Awesome—here’s a concrete, buildable plan you can hand to a junior team. It’s modular, API-first, and gets you to a federation pilot in ~90 days.

High-level architecture (what we’re building)
	•	Federation Gateway (association- or PMS-run): normalizes property content, prices, and availability from multiple sources into a common Offer API.
	•	Open Search API: public, read-optimized discovery/search + live availability deltas over SSE.
	•	Attribution & Booking-Intent Service: issues short-lived, signed booking-intent tokens (BITs) so discovery apps get a small, capped lead fee without price-parity.
	•	Payments/Escrow: card (Stripe Connect) for MVP; SEPA Instant later. Holds funds until check-in; splits out the capped lead fee.
	•	Portable Reviews & Proof-of-Stay: escrow or PMS issues a verifiable receipt; reviews are signed and portable.
	•	Transparency Log: append-only Merkle log for fees, ranking factors, paid placement.
	•	Hotel Site Plugin: drop-in widget to redeem BITs and complete checkout with the hotel’s PMS/engine.
	•	Reference Clients: consumer web app + hotel console.

⸻

Phase 0 — Decisions & repos (Day 1–3)

Tech choices
	•	Backend: TypeScript + Fastify, Postgres, Redis, NATS (optional)
	•	Crypto: jose (JWT/JWS), DID:key or DID:web (later), Ed25519 keys
	•	Infra: Docker Compose for dev; Terraform + Fly.io/Render/Vercel or k8s for prod
	•	Payments (MVP): Stripe Connect (split payouts + platform fees)
	•	Search: Postgres + pg_trgm + bounding-box geo; optional Typesense/Meilisearch later
	•	Object store: S3-compatible (MinIO dev; Cloudflare R2 prod)

Monorepo layout

/booking-network
  /services
    /gateway
    /search-api
    /attribution
    /payments
    /reviews
    /transparency
  /clients
    /consumer-web
    /hotel-console
    /hotel-plugin
  /packages
    /schemas
    /lib-crypto
    /lib-merkle
  /ops
    docker-compose.yml
    terraform/
    k8s/


⸻

Phase 1 — Core schemas (Day 3–7)

Define JSON Schemas in /packages/schemas (keep them versioned):

Property

{
  "$id": "Property",
  "type": "object",
  "required": ["id","name","geo","address","contact","amenities"],
  "properties": {
    "id": {"type":"string"},               // stable, globally unique (namespace:sourceId)
    "name": {"type":"string"},
    "geo": {"type":"object","properties":{"lat":{"type":"number"},"lon":{"type":"number"}}},
    "address": {"type":"object","properties":{"country":{"type":"string"},"locality":{"type":"string"},"street":{"type":"string"},"postalCode":{"type":"string"}}},
    "contact": {"type":"object","properties":{"website":{"type":"string"},"phone":{"type":"string"},"email":{"type":"string"}}},
    "photos": {"type":"array","items":{"type":"string"}},  // URLs (S3/IPFS)
    "amenities": {"type":"array","items":{"type":"string"}},
    "pms": {"type":"object","properties":{"vendor":{"type":"string"},"externalId":{"type":"string"}}}
  }
}

RoomType

{
  "$id":"RoomType",
  "type":"object",
  "required":["id","propertyId","name","capacity"],
  "properties":{
    "id":{"type":"string"},
    "propertyId":{"type":"string"},
    "name":{"type":"string"},
    "description":{"type":"string"},
    "capacity":{"type":"integer"},
    "beds":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string"},"count":{"type":"integer"}}}}
  }
}

Offer (normalized rate)

{
  "$id":"Offer",
  "type":"object",
  "required":["id","propertyId","roomTypeId","checkIn","checkOut","price","cancellation","inventory"],
  "properties":{
    "id":{"type":"string"}, // hash(propertyId, roomTypeId, dates, ratePlan)
    "propertyId":{"type":"string"},
    "roomTypeId":{"type":"string"},
    "ratePlan":{"type":"string"},
    "checkIn":{"type":"string","format":"date"},
    "checkOut":{"type":"string","format":"date"},
    "price":{"type":"object","properties":{
      "currency":{"type":"string"},
      "base":{"type":"number"},
      "taxes":{"type":"number"},
      "fees":{"type":"number"},
      "total":{"type":"number"}
    }},
    "cancellation":{"type":"object","properties":{
      "policy":{"type":"string"},
      "freeUntil":{"type":["string","null"],"format":"date-time"}
    }},
    "inventory":{"type":"integer"},
    "terms":{"type":"object","properties":{"payAt":{"type":"string","enum":["property","booking"]}}},
    "source":{"type":"string"} // which adapter
  }
}

BookingIntentToken (BIT) — JWT claims

{
  "$id":"BITClaims",
  "type":"object",
  "required":["iss","aud","iat","exp","jti","propertyId","offerId","leadFeeBps","discoveryAppId"],
  "properties":{
    "iss":{"type":"string"},          // attribution service DID
    "aud":{"type":"string"},          // hotel site plugin origin
    "iat":{"type":"integer"},
    "exp":{"type":"integer"},         // e.g., +24h
    "jti":{"type":"string"},
    "propertyId":{"type":"string"},
    "offerId":{"type":"string"},
    "leadFeeBps":{"type":"integer"},  // capped (e.g., max 200 = 2.00%)
    "discoveryAppId":{"type":"string"},
    "price":{"type":"object","properties":{"currency":{"type":"string"},"total":{"type":"number"}}},
    "stay":{"type":"object","properties":{"checkIn":{"type":"string","format":"date"},"checkOut":{"type":"string","format":"date"}}}
  }
}


⸻

Phase 2 — Gateway service (Week 2)

Purpose: ingest from PMS/channel managers and normalize to Property, RoomType, Offer.

DB (Postgres)

create table properties(
  id text primary key, name text, geo point, address jsonb, contact jsonb,
  photos jsonb, amenities text[], pms jsonb, updated_at timestamptz default now()
);
create index on properties using gin (to_tsvector('simple', name));

create table room_types(
  id text primary key, property_id text references properties(id), name text,
  description text, capacity int, beds jsonb, updated_at timestamptz default now()
);

create table offers(
  id text primary key, property_id text references properties(id),
  room_type_id text references room_types(id), rate_plan text,
  check_in date, check_out date, price jsonb, cancellation jsonb,
  inventory int, terms jsonb, source text, updated_at timestamptz default now()
);
create index on offers(property_id, check_in, check_out);

Adapters
Create /services/gateway/src/adapters/{pms}.ts (start with CSV/JSON mock + one real PMS later). Each adapter yields normalized objects.

Upsert pipeline
	•	Poll adapters every N minutes + webhooks if available.
	•	Write normalized rows with ON CONFLICT DO UPDATE.
	•	Publish delta events to Redis Stream offers:delta:

{ "type":"upsert", "offerId":"...", "propertyId":"...", "changed":["price","inventory"], "at":"2025-08-10T07:00:00Z" }

S3 media
Upload canonical photos to /properties/{id}/ and store signed URLs.

⸻

Phase 3 — Open Search API (Week 3)

Fastify service at /services/search-api.

Endpoints
	•	GET /v1/search?query=stockholm&checkIn=2025-10-12&checkOut=2025-10-14&guests=2&bbox=...
	•	GET /v1/property/:id
	•	GET /v1/offers?propertyId=...&checkIn=...&checkOut=...
	•	GET /v1/availability/stream?propertyId=... (SSE pushing price/inventory deltas)

SSE example (server)

fastify.get('/v1/availability/stream', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const sub = redis.duplicate(); await sub.connect();
  await sub.subscribe('offers:delta', (msg) => {
    reply.raw.write(`event: delta\ndata: ${msg}\n\n`);
  });
});

Ranking (transparent default)
	•	Score = f(total price, free cancellation, reviews score, distance, availability)
	•	If paid placement ever exists: include sponsored:true and log every impression → Transparency Log.

⸻

Phase 4 — Attribution & Booking-Intent (Week 4)

Service issues and validates BITs.

Issuance (discovery app flow)
	•	POST /v1/bit with {propertyId, offerId, price, stay, discoveryAppId}
	•	Service checks current offer, enforces cap (e.g., leadFeeBps <= 200), mints JWT (Ed25519), exp = 24h.

Example issuance

import { SignJWT, generateKeyPair } from 'jose';
const { privateKey } = await generateKeyPair('EdDSA');
const token = await new SignJWT({
  propertyId, offerId, discoveryAppId, leadFeeBps: 150, price, stay
})
  .setProtectedHeader({ alg:'EdDSA', kid:'did:key:z...' })
  .setIssuedAt()
  .setIssuer('did:key:zAttribution')
  .setAudience('hotel-plugin')
  .setJti(crypto.randomUUID())
  .setExpirationTime('24h')
  .sign(privateKey);

Redemption (hotel site plugin flow)
	•	Hotel plugin calls POST /v1/bit/redeem with JWT
	•	Service verifies signature + freshness, locks the offerId (optimistic concurrency), and returns a checkout session ID + the settled lead fee bps.

Edge cases
	•	Price drift > threshold → require customer confirmation or re-issue BIT.
	•	Multiple redemptions → idempotency by jti.

⸻

Phase 5 — Payments & Escrow (Week 5–6)

Stripe Connect MVP
	•	Platform account = federation operator
	•	Onboard hotels as Connect Accounts (standard or express)
	•	On redemption, create PaymentIntent with Application Fee = (leadFeeBps/10000) * total
	•	Capture at booking or at check-in (recommend capture at booking, transfer at check-in with delayed transfers; or capture to platform, hold, then Transfer to hotel on check-in event).

Flows
	1.	Book-now, pay-now (with refunds policy)
	•	Create PaymentIntent (capture immediately)
	•	Funds in platform balance; Transfer to hotel at check-in; Platform retains lead fee.
	2.	Authorize-now, capture-on-check-in (Stripe allows up to 7 days; for longer stays, capture at booking and handle refunds per policy)

Check-in confirmation
	•	Hotel console triggers POST /v1/escrow/release {bookingId}
	•	Service issues Proof-of-Stay VC (see next phase) and runs Stripe Transfer to hotel.

⸻

Phase 6 — Proof-of-Stay & Portable Reviews (Week 6–7)

Proof-of-Stay VC (minimal for MVP)
	•	Issuer: Escrow service DID
	•	Subject: guest pseudonymous DID (mint when booking)
	•	Claims: { propertyId, stay: {checkIn, checkOut}, bookingId }
	•	Store only hash on Transparency Log to avoid PII.

Review flow
	•	After checkout, send link with a challenge signed to guest DID
	•	POST /v1/reviews with { review, rating, proof: VC } signed by guest key
	•	Verify VC and signature; display review anywhere (portable).

DB

create table reviews(
  id uuid primary key,
  property_id text not null,
  rating int check (rating between 1 and 5),
  review text,
  proof jsonb,        -- stored VC (minimal)
  created_at timestamptz default now()
);


⸻

Phase 7 — Transparency Log (Week 7)

Append-only Merkle log for:
	•	Fee schedules & caps
	•	Paid placement events (if any)
	•	Tree heads (STH) published daily

Simple implementation
	•	transparency_entries(id uuid, type text, payload jsonb, ts timestamptz)
	•	Batch compute Merkle roots per day; publish signed STH to a public bucket + GitHub Pages.

/packages/lib-merkle provides:

export function merkleRoot(leaves: Buffer[]): Buffer
export function inclusionProof(leaves: Buffer[], index: number): {root:Buffer, path:Buffer[]}


⸻

Phase 8 — Hotel Site Plugin (Week 8)

Drop-in widget that:
	•	Detects a BIT in URL or window.postMessage from discovery app
	•	Calls POST /v1/bit/redeem → returns checkout session
	•	Renders guest details + cancellation + total price; submits to hotel PMS or built-in checkout if hotel lacks PMS booking engine

Snippet (ES module)

<script type="module">
import { initHotelWidget } from "https://cdn.staymesh.org/hotel-plugin/v1.js";
initHotelWidget({
  propertyId: "prop_123",
  onCheckout: async (payload) => {
    // If hotel has PMS booking URL:
    const url = new URL("https://hotel.com/book");
    url.searchParams.set("checkIn", payload.stay.checkIn);
    // Fallback: call our payments API
  }
});
</script>
<div id="staymesh-widget"></div>


⸻

Phase 9 — Consumer Web App (Week 8–9)

Features:
	•	Map & list view; server-side search to avoid price leaks
	•	Show total price up-front (base+tax+fees), cancellation, and fee impact banner (“Your booking supports X% fee cap”)
	•	“Book direct on hotel site” (opens hotel page with BIT) or “Book here” (our escrow checkout)

Pages
	•	/search (query params)
	•	/property/:id (room types + offers)
	•	/checkout (BIT redemption + payment)

⸻

Phase 10 — Hotel Console (Week 9)
	•	Dashboard: upcoming stays, payouts, attribution analytics
	•	Fee cap controls (within network limits), cancellation policy editor
	•	Proof-of-stay issuance log, review responses

⸻

Phase 11 — Governance & Policy (parallel Weeks 7–9)
	•	Network Policy v1 (markdown):
	•	Fee cap (e.g., max 2.00% lead fee)
	•	Explicit no price-parity clauses
	•	Data portability + right to link to your own site
	•	Ranking factors disclosure
	•	Membership & keys: association runs a root key; gateways + attribution service are delegated DIDs; rotation policy defined.

⸻

Phase 12 — Pilot rollout (Week 10–12)
	•	50–100 hotels via one PMS + one association gateway
	•	Success metrics: direct bookings share, avg fee %, cancellation rate, review completion %, payout delays
	•	Legal: DPA, ToS, PCI scope limited (Stripe-hosted elements), GDPR DPIA

⸻

API Cheat-Sheet (copy into README)

Search

GET /v1/search
  ?query=rome&checkIn=2025-10-01&checkOut=2025-10-03&guests=2&bbox=...
→ { properties:[...], offers:[...] }

Offers

GET /v1/offers?propertyId=prop_123&checkIn=2025-10-01&checkOut=2025-10-03
→ [ Offer ]

SSE availability

GET /v1/availability/stream?propertyId=prop_123
event: delta
data: {"offerId":"...","changed":["price"]}

BIT issuance

POST /v1/bit
{ propertyId, offerId, price:{currency,total}, stay:{checkIn,checkOut}, discoveryAppId }
→ { token }

BIT redeem

POST /v1/bit/redeem
Authorization: Bearer <token>
→ { checkoutSessionId, leadFeeBps }

Create payment

POST /v1/payments
{ checkoutSessionId, paymentMethodId }
→ { status:"succeeded", bookingId }

Release escrow (check-in)

POST /v1/escrow/release
{ bookingId }
→ { transferId, proofOfStayVC }

Post review

POST /v1/reviews
{ bookingId, rating, review, proof, signature }
→ 201 Created


⸻

DevOps quickstart

docker-compose.yml (dev)

services:
  postgres: { image: postgres:16, environment: { POSTGRES_PASSWORD: dev }, ports: ["5432:5432"] }
  redis: { image: redis:7, ports: ["6379:6379"] }
  minio:
    image: minio/minio
    command: server /data
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio123 }
    ports: ["9000:9000","9001:9001"]

Service scaffold

pnpm dlx create-fastify@latest gateway
pnpm add zod jose pg ioredis

Migrations

pnpm dlx prisma init     # or use node-pg-migrate
pnpm run migrate

Keys

node -e "import('jose').then(async m=>{const {publicKey,privateKey}=await m.generateKeyPair('EdDSA');console.log(await m.exportJWK(publicKey));console.log(await m.exportJWK(privateKey));})"


⸻

Security & privacy notes (ship with v1)
	•	PII minimization: search and offers are anonymous; PII only in checkout; tokenize payment; store only what’s required for tax/audit.
	•	BIT scope: one property + one offer + short TTL + one-time redemption.
	•	Anti-fraud: device fingerprint at checkout, velocity checks on BIT issuance, mandatory 3DS for high-risk.
	•	GDPR: DPO email, records of processing, DPIA, data retention policy (e.g., delete PII 180 days after checkout unless law requires longer).
	•	Incident response: playbook + contact chain; rotate DIDs and keys with downtime < 10 min.

⸻

Stretch goals (post-pilot)
	•	OpenBanking/SEPA Instant escrow (PSD2)
	•	DID-based hotel identity (association-issued VCs)
	•	Federated search across multiple gateways via signed Query Tokens
	•	Price-match “guardrails”: hotels can always be cheaper on their own site; never punished in ranking
	•	Accessibility & sustainability tags embedded in Offer schema
	•	Mobile wallets: add EU Wallet / eIDAS 2 for age/name attestations at check-in (privacy-preserving)

⸻

Milestones & staffing
	•	Weeks 1–2: Schemas, Gateway (1 BE dev)
	•	Week 3: Search API + SSE (1 BE dev)
	•	Week 4: Attribution/BIT (1 BE dev)
	•	Weeks 5–6: Payments/Escrow (1 BE dev)
	•	Week 7: Proof-of-stay, Reviews, Transparency (1 BE + 0.5 crypt/FE)
	•	Weeks 8–9: Hotel plugin, Consumer app, Console (1–2 FE devs)
	•	Weeks 10–12: Pilot integration with 50–100 hotels (all hands)

⸻

What you’ll demo to hotels & investors
	•	Search a city → see total prices + transparent fee banner
	•	Click “Book on hotel site” → hotel page opens, widget recognizes BIT, price confirmed, checkout
	•	Payout settles on check-in; console shows lead fee and attribution
	•	Guest leaves a portable, proof-backed review
	•	Public page shows daily transparency log and fee caps

If you want, I can generate:
	1.	A minimal OpenAPI spec for all endpoints, and
	2.	A Docker Compose dev environment you can run locally today (with mock PMS adapter + Stripe test mode).