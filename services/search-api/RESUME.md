# Admin Property Management API — Resume Plan

## Current Status
- Admin plugin implemented in `src/admin.ts` (auth, CRUD, bulk import, file upload, error handling, rate limits, zod validation).
- Migration ready: `migrations/1723590000000_admin_api.js` adds `admin_users`, `import_logs`, property metadata columns and indexes.
- Server wiring in `src/index.ts` mounts admin routes under `/v1/admin` when `ADMIN_JWT_SECRET` is set.
- Seed script updated (`src/seed.ts`) to optionally create an initial admin user using `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.
- Dependencies declared in `package.json` (Fastify, jose, bcryptjs, csv-parse, zod, etc.).
- Issue: `npm install` failed due to invalid version `@fastify/swagger-ui@3.0.1` (no such version). No lockfile present.
- Potential cleanup: duplicate plugin registrations at bottom of `src/index.ts` (uses `require()` in ESM), safe to remove after install/migrate.

## Immediate Next Actions (ordered)
1) Fix dependency version, then install dependencies.
2) Run database migrations (inline PG env).
3) Seed an admin user (inline env) — requires migrations to be applied.
4) Optionally create uploads directory now (server also ensures it).
5) Build to validate types and compilation.
6) Optional code cleanup: remove duplicate multipart/static registration at bottom of `src/index.ts`.
7) Start the dev server with admin routes enabled and test endpoints.

## Commands

### 1) Fix `@fastify/swagger-ui` to a valid version and install
```bash
cd services/search-api
npm pkg set dependencies.@fastify/swagger-ui=$(npm view @fastify/swagger-ui version)
npm install
```

### 2) Run migrations (adjust PG env as needed)
```bash
PGHOST=localhost PGPORT=5432 PGUSER=booking PGPASSWORD=booking PGDATABASE=booking \
npm run migrate:up
```

### 3) Seed initial admin user
```bash
SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='ChangeMe123!' \
PGHOST=localhost PGPORT=5432 PGUSER=booking PGPASSWORD=booking PGDATABASE=booking \
npm run seed
```

### 4) Create uploads directory (optional; server also creates if missing)
```bash
sudo mkdir -p /var/openrooms/uploads && sudo chmod -R 777 /var/openrooms/uploads
```

### 5) Build
```bash
npm run build
```

### 6) Start dev server (admin routes enabled)
```bash
ADMIN_JWT_SECRET='devsecret' \
UPLOAD_DIR='/var/openrooms/uploads' \
BASE_URL='http://localhost:3001' \
MAX_UPLOAD_BYTES=$((10*1024*1024)) \
npm run dev
```

## Validation Checklist
- Auth:
  - POST `/v1/admin/auth/login` with seeded admin credentials returns JWT.
  - GET `/v1/admin/auth/verify` with Bearer token is valid.
- Properties:
  - POST `/v1/admin/properties` creates a property.
  - PUT `/v1/admin/properties/:id` updates.
  - DELETE `/v1/admin/properties/:id` soft-deletes.
  - GET `/v1/admin/properties?page=&limit=&city=&stars=` paginates/filters.
- Bulk/Imports:
  - POST `/v1/admin/properties/bulk` creates multiple; logs `import_logs`.
  - POST `/v1/admin/properties/import` (CSV/JSON) upserts; logs `import_logs`.
  - POST `/v1/admin/properties/import-api` imports from external API; logs `import_logs`.
- Uploads:
  - POST `/v1/admin/upload/images` accepts JPEG/PNG/WEBP and returns URLs under `/uploads/`.

## Notes / Risks
- `src/index.ts` lines ~398–406 re-register `@fastify/static` and `@fastify/multipart` using `require()` despite ESM; recommended to remove these duplicates.
- Ensure `ADMIN_JWT_SECRET` is set in environment for admin routes to be available.
- Postgres and Redis must be reachable using env in `src/index.ts` defaults or overrides.
- Consider adding integration tests for admin endpoints after basic verification.
