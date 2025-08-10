#!/usr/bin/env bash
set -euo pipefail

# Provision a fresh Ubuntu Hetzner VM to run Open Booking Network Search API
# - Installs Node.js 20 LTS, git, build tools
# - Installs PostgreSQL 15 and Redis (optional; disable via flags)
# - Installs Caddy as reverse proxy with automatic TLS
# - Creates system user and directories
#
# Usage:
#   HOST=your.server.ip_or_dns \
#   SSH_USER=root \
#   DOMAIN=api.openrooms.net \
#   INSTALL_DB=1 INSTALL_REDIS=1 \
#   ./ops/provision-hetzner.sh
#
# Environment variables:
#   HOST          - required, server host/ip
#   SSH_USER      - ssh username (default: root)
#   DOMAIN        - domain to serve (default: api.openrooms.net)
#   INSTALL_DB    - 1 to install PostgreSQL (default: 1)
#   INSTALL_REDIS - 1 to install Redis (default: 1)
#
# After provisioning, use ./ops/deploy-search-api.sh to deploy the app.

: "${HOST:?HOST is required}"
SSH_USER="${SSH_USER:-root}"
DOMAIN="${DOMAIN:-api.openrooms.net}"
INSTALL_DB="${INSTALL_DB:-1}"
INSTALL_REDIS="${INSTALL_REDIS:-1}"

ssh "$SSH_USER@$HOST" "DOMAIN='$DOMAIN' INSTALL_DB='$INSTALL_DB' INSTALL_REDIS='$INSTALL_REDIS' HTTP_ONLY='${HTTP_ONLY:-0}' bash -s" << 'REMOTE_EOF'
set -euo pipefail

wait_for_apt() {
  echo "Waiting for apt/dpkg lock if present..."
  while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
        fuser /var/lib/dpkg/lock >/dev/null 2>&1 || \
        pgrep -x apt >/dev/null || pgrep -x apt-get >/dev/null || pgrep -x unattended-up >/dev/null; do
    sleep 3
  done
}

if [ -f /etc/debian_version ]; then
  export DEBIAN_FRONTEND=noninteractive
  wait_for_apt
  apt-get update
  wait_for_apt
  apt-get install -y ca-certificates curl gnupg lsb-release software-properties-common git build-essential ufw
else
  echo "This script assumes Debian/Ubuntu. Aborting." >&2
  exit 1
fi

# Harden SSH a bit (optional)
sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config || true
systemctl reload ssh || true

# Create system user and directories
id -u openrooms >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin openrooms
mkdir -p /opt/openrooms/app /var/log/openrooms
chown -R openrooms:openrooms /opt/openrooms /var/log/openrooms

# Node.js 20 LTS (NodeSource)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  wait_for_apt
  apt-get install -y nodejs
fi

# PostgreSQL 15 (optional)
if [ "${INSTALL_DB}" = "1" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor > /etc/apt/trusted.gpg.d/postgresql.gpg
    wait_for_apt
    apt-get update
    wait_for_apt
    apt-get install -y postgresql-15 postgresql-client-15
  fi
  systemctl enable --now postgresql
  # Create production DB and user if not exists
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'openrooms'" | grep -q 1 || sudo -u postgres createdb openrooms
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='openrooms'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER openrooms WITH PASSWORD 'change_me_strong';"
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE openrooms TO openrooms;"
fi

# Redis (optional)
if [ "${INSTALL_REDIS}" = "1" ]; then
  wait_for_apt
  apt-get install -y redis-server
  systemctl enable --now redis-server
fi

# Caddy (reverse proxy with Let's Encrypt)
if ! command -v caddy >/dev/null 2>&1; then
  wait_for_apt
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
  wait_for_apt
  apt-get update
  wait_for_apt
  apt-get install -y caddy
fi

# UFW basic rules
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable || true

# Create Caddyfile (HTTP_ONLY fallback if DNS not propagated)
if [ "${HTTP_ONLY:-0}" = "1" ]; then
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

systemctl reload caddy || systemctl restart caddy || true

echo "Provisioning completed. Upload env file to /etc/openrooms/search-api.env and deploy the app."
REMOTE_EOF

cat <<INFO
Done.
Next steps:
1) Put your API env vars in a local file (e.g., ops/env/prod.search-api.env) and run deploy script:
   HOST=$HOST SSH_USER=$SSH_USER DOMAIN=$DOMAIN ENV_FILE=ops/env/prod.search-api.env ./ops/deploy-search-api.sh
2) Point DNS A/AAAA for $DOMAIN to $HOST, Caddy will fetch certificates automatically (when not HTTP_ONLY).
INFO
