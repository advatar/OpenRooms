#!/usr/bin/env bash
set -euo pipefail

# Deploy Search API to Hetzner host over SSH
# - Rsyncs repo to /opt/openrooms/app
# - Installs deps, builds, runs migrations
# - Installs/updates systemd unit and restarts service
# - Updates Caddy config for DOMAIN
#
# Usage:
#   HOST=your.server.ip_or_dns \
#   SSH_USER=root \
#   DOMAIN=api.openrooms.net \
#   ENV_FILE=ops/env/prod.search-api.env \
#   ./ops/deploy-search-api.sh
#
# Required env vars:
#   HOST       - target server
#   ENV_FILE   - path to local env file for API (will upload to /etc/openrooms/search-api.env)
# Optional:
#   SSH_USER   - ssh user (default: root)
#   DOMAIN     - domain for Caddy (default: api.openrooms.net)

: "${HOST:?HOST is required}"
: "${ENV_FILE:?ENV_FILE local path is required}"
SSH_USER="${SSH_USER:-root}"
DOMAIN="${DOMAIN:-api.openrooms.net}"

# Ensure env file exists
[ -f "$ENV_FILE" ] || { echo "ENV_FILE not found: $ENV_FILE" >&2; exit 1; }

REMOTE_DIR=/opt/openrooms/app
SERVICE_NAME=openrooms-search-api
REMOTE_ENV=/etc/openrooms/search-api.env

# 1) Upload source (exclude node_modules and build artifacts)
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude ops/env/*.env \
  ./ "$SSH_USER@$HOST:$REMOTE_DIR/"

# 2) Upload env file
ssh "$SSH_USER@$HOST" "mkdir -p /etc/openrooms && chown -R openrooms:openrooms /etc/openrooms"
scp "$ENV_FILE" "$SSH_USER@$HOST:$REMOTE_ENV.tmp"
ssh "$SSH_USER@$HOST" "install -o openrooms -g openrooms -m 640 $REMOTE_ENV.tmp $REMOTE_ENV && rm -f $REMOTE_ENV.tmp"

# 3) Install deps, build, and run migrations
ssh "$SSH_USER@$HOST" bash -s <<REMOTE_EOF
set -euo pipefail
cd $REMOTE_DIR/services/search-api
# Ensure correct ownership for runtime
chown -R openrooms:openrooms $REMOTE_DIR

# Install with dev deps for build
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build
# Prune dev deps for runtime
npm prune --omit=dev

# Load env for migrations
set -a
. $REMOTE_ENV
set +a
# Expect PG connection via PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in env
npm run migrate:up || true
REMOTE_EOF

# 4) Install/Update systemd service
scp ops/systemd/search-api.service "$SSH_USER@$HOST:/etc/systemd/system/$SERVICE_NAME.service"
ssh "$SSH_USER@$HOST" bash -s <<REMOTE_EOF
set -euo pipefail
sed -i "s#@@APP_DIR@@#$REMOTE_DIR/services/search-api#g" /etc/systemd/system/$SERVICE_NAME.service
sed -i "s#@@ENV_FILE@@#$REMOTE_ENV#g" /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl restart $SERVICE_NAME
REMOTE_EOF

# 5) Update Caddy for DOMAIN or HTTP_ONLY fallback
ssh "$SSH_USER@$HOST" bash -s <<REMOTE_EOF
set -euo pipefail
if [ "
${HTTP_ONLY:-0}
" = "1" ]; then
  cat >/etc/caddy/Caddyfile <<CADDY
:80 {
  encode gzip
  log {
    output file /var/log/openrooms/caddy-access.log
  }
  reverse_proxy 127.0.0.1:3001
}
CADDY
else
  cat >/etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
  encode gzip
  log {
    output file /var/log/openrooms/caddy-access.log
  }
  reverse_proxy 127.0.0.1:3001
}
CADDY
fi
systemctl reload caddy || systemctl restart caddy
REMOTE_EOF

echo "Deploy complete. API should be reachable at https://$DOMAIN (proxied to 127.0.0.1:3001)."
