# Booking Network (MVP per CHECKLIST)

This repo scaffolds the minimal runnable pieces from the checklist:

- Core JSON Schemas in `packages/schemas/`
- Open Search API (Fastify + Postgres + Redis) in `services/search-api/`
- Dev infra via Docker Compose in `ops/docker-compose.yml`

## Pitch

For the problem, vision, and why this matters, see the project pitch:

- [Read the Pitch (PITCH.md)](./PITCH.md)

## Quick start

Prereqs: Node 20+, Docker Desktop.

1) Start Postgres and Redis

```
cd ops
docker compose up -d
```

2) Install dependencies (root workspaces)

```
npm install
```

3) Run the Search API in dev (auto-reload)

```
npm run dev
```

The server listens on `http://localhost:3001`.

## API Endpoints (MVP)

- GET `/health`
- GET `/v1/search?query=rome&checkIn=2025-10-01&checkOut=2025-10-03&guests=2`
- GET `/v1/property/:id`
- GET `/v1/offers?propertyId=...&checkIn=...&checkOut=...`
- GET `/v1/availability/stream?propertyId=...` (SSE; subscribes to `offers:delta`)

## Notes

- DB tables are auto-created on server start (`properties`, `room_types`, `offers`).
- SSE uses Redis channel `offers:delta`. To test, you can publish a message using `redis-cli` in the Redis container.

Example (container name may differ; check with `docker ps`):

```
docker exec -it <redis-container> redis-cli publish offers:delta '{"type":"upsert","offerId":"o1","propertyId":"p1","changed":["price"],"at":"2025-08-10T07:00:00Z"}'
```

## macOS local setup (no Docker)

If you don't have Docker, you can run Postgres and Redis locally via Homebrew:

1) Install Postgres and Redis

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

2) Create DB and user

```bash
createuser booking --superuser || true
createdb booking -O booking || true
psql -d postgres -c "alter user booking with password 'booking';" || true
```

3) Configure env for `services/search-api`

Copy `.env.example` to `.env` and keep defaults:

```bash
cp services/search-api/.env.example services/search-api/.env
```

4) Install deps and run API

```bash
npm install
npm run dev
# server at http://localhost:3001
```

5) Seed demo data (in another terminal)

```bash
cd services/search-api
npm run seed
```

6) Test SSE deltas (in another terminal)

```bash
cd services/search-api
npm run publish:delta
# Or with redis-cli:
# redis-cli publish offers:delta '{"type":"upsert","offerId":"o1","propertyId":"p1","changed":["price"],"at":"2025-08-10T07:00:00Z"}'
```

7) Try endpoints

```bash
curl http://localhost:3001/health
curl "http://localhost:3001/v1/search?query=rome&checkIn=2025-10-01&checkOut=2025-10-03&guests=2"
curl -N "http://localhost:3001/v1/availability/stream?propertyId=p1" # observe deltas
```

## OpenAPI

The OpenAPI spec is at `openapi.yaml`. Import it into your API client (Insomnia/Postman) or generate types/clients for the UI (e.g., `openapi-typescript`).

Default public API base (when hosted): `https://api.openrooms.net`.
For local UI development (Vite), set:

```bash
VITE_API_BASE_URL=http://localhost:3001
```

## Next

- Add ingestion adapters (`/services/gateway`) and ranking logic.
- Expand search (geo bbox, reviews, scoring) per checklist.
- Add clients and attribution service.

## Hardening (enabled/available in `services/search-api`)

- **Validation**: Zod schemas with consistent error responses.
- **Error handling**: Central error handler and typed `AppError` with `statusCode`.
- **CORS**: via `@fastify/cors`; can restrict to web origins later.
- **Rate limiting**: via `@fastify/rate-limit` (default conservative limits).
- **Request IDs**: Correlation id propagated in `x-request-id` header.
- **Payments**: Stripe test mode behind feature flag.
- **Migrations**: `node-pg-migrate` for versioned schema.
- **Tests**: Vitest + Supertest integration test scaffold.

### Stripe (test mode)

Environment variables in `services/search-api/.env`:

```
STRIPE_ENABLED=false          # set true to use real Stripe test mode
STRIPE_API_KEY=sk_test_...    # required if STRIPE_ENABLED=true
```

Payment flow (UI): create a Payment Method (Stripe Elements) and send its id in `POST /v1/payments` payload. When disabled, the API simulates success.

### Rate limit and request IDs

- Default rate limit configured; adjust in `src/index.ts`.
- Each response includes `x-request-id`. You can also send your own `x-request-id` per request.

### Migrations

We use `node-pg-migrate`. Run from repo root:

```bash
# Up
npx node-pg-migrate -m services/search-api/migrations -d postgres://booking:booking@localhost:5432/booking up

# Down last
npx node-pg-migrate -m services/search-api/migrations -d postgres://booking:booking@localhost:5432/booking down

# Create a new migration (JS skeleton)
npx node-pg-migrate -m services/search-api/migrations create add_new_table
```

Note: Boot-time auto-creation remains for dev convenience, but prefer migrations for any schema change.
