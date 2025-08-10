# Booking Network (MVP per CHECKLIST)

This repo scaffolds the minimal runnable pieces from the checklist:

- Core JSON Schemas in `packages/schemas/`
- Open Search API (Fastify + Postgres + Redis) in `services/search-api/`
- Dev infra via Docker Compose in `ops/docker-compose.yml`

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

## Next

- Add ingestion adapters (`/services/gateway`) and ranking logic.
- Expand search (geo bbox, reviews, scoring) per checklist.
- Add clients and attribution service.
