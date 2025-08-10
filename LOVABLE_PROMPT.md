# Prompt for lovable.dev: Open Booking Network UI (MVP)

Build a production-ready, modern web UI for the Open Booking Network MVP that connects to our public APIs. Use https://api.openrooms.net as the default API base URL (override via env). The UI must be accessible, fast, and easy to extend. Follow the detailed spec below.

## Tech stack
- Framework: React (Vite) with TypeScript
- Styling: Tailwind CSS
- State: React Query (TanStack Query) for data fetching + caching
- Routing: React Router
- SSE: native EventSource with reconnect/backoff
- Forms: React Hook Form + Zod validation
- Build: Vite

## OpenAPI
- Use the OpenAPI spec in the repository at `openapi.yaml` during development.
- Optionally generate TypeScript types and a lightweight client from the spec (e.g., `openapi-typescript`, `orval`, or `swagger-typescript-api`).
- Keep client types in sync with the spec and prefer typed integrations in `lib/api.ts`.

## Environments
- Use environment variable for API base URL
  - Vite: `VITE_API_BASE_URL=https://api.openrooms.net`
  - Provide `.env.example` with the default above and allow developers to override locally

## Pages & flows

1) Search page `/search`
- Inputs: destination text `query`, `checkIn`, `checkOut`, `guests`, optional `bbox`
- Calls GET `https://api.openrooms.net/v1/search?query=...&checkIn=...&checkOut=...&guests=...&bbox=...`
- Results layout: responsive map/list split or list-only (grid on mobile)
- Each result card shows: property name, photo, total price, cancellation badge, distance, quick actions
- Sorting: by price (asc), review score (desc), distance (asc)
- Filters: free cancellation, max price slider, date picker
- Empty state & skeleton loaders

2) Property detail page `/property/:id`
- Calls GET `https://api.openrooms.net/v1/property/:id`
- Calls GET `https://api.openrooms.net/v1/offers?propertyId=:id&checkIn=...&checkOut=...`
- Shows gallery, amenities, address/map, contact links
- Offers table: room type, rate plan, total price, cancellation, inventory, CTA “Book”
- Live updates: subscribe SSE to `https://api.openrooms.net/v1/availability/stream?propertyId=:id`
  - On `event: delta` messages, update prices/inventory in-list with a soft highlight

3) Checkout flow `/checkout`
- Triggered from “Book” CTA with `propertyId`, `offerId`, `price` (currency/total), `stay` (checkIn/checkOut), `discoveryAppId`
- Step A: Issue BIT
  - POST `https://api.openrooms.net/v1/bit` with body `{ propertyId, offerId, price:{currency,total}, stay:{checkIn,checkOut}, discoveryAppId }`
  - Receive `{ token }` (JWT)
- Step B: Redeem BIT
  - POST `https://api.openrooms.net/v1/bit/redeem` with `Authorization: Bearer <token>`
  - Receive `{ checkoutSessionId, leadFeeBps }`
- Step C: Payment
  - Collect guest details + card details (Stripe Elements recommended UI placeholder)
  - POST `https://api.openrooms.net/v1/payments` with `{ checkoutSessionId, paymentMethodId }`
  - Show confirmation with booking summary and fee transparency

4) Post-check-in flow (operator)
- Add a minimal operator page or stub to simulate escrow release
  - POST `https://api.openrooms.net/v1/escrow/release` with `{ bookingId }`
  - Display `{ transferId, proofOfStayVC }`

## Components
- SearchBar: query, dates, guests, submit
- PropertyCard: photo, name, tags, price, CTA
- OffersTable: inline update on SSE delta events
- PriceBadge: currency, total, tooltip with taxes/fees breakdown (if provided)
- CancellationBadge: free until date or policy summary
- FeeImpactBanner: “Your booking supports fee cap of X%” if `leadFeeBps` present
- Loading & Error components standardised

## API integration details
- Use React Query for all requests
- Global axios/fetch client reading base URL from env
- Error handling: toast + inline retry
- Query keys: `['search', params]`, `['property', id]`, `['offers', id, dates]`
- SSE handling: dedicated hook `useOfferDeltas(propertyId)` with cleanup and exponential backoff

## Accessibility & UX
- Keyboard navigable, focus states, semantic HTML, aria labels
- High contrast, supports reduced motion
- Mobile-first responsive design
- Persist search params in URL
- Display currency consistently; format dates localized

## Placeholder & mocking
- Provide a `DEV_MOCKS=true` mode that serves fixtures if API not available
  - JSON fixtures for: search results, property, offers, bit issuance, redeem, payments
  - Toggle at runtime if fetch fails with network error

## Directory structure (Vite + React suggested)
```
src/
  main.tsx
  App.tsx
  routes/
    SearchPage.tsx
    PropertyPage.tsx
    CheckoutPage.tsx
  components/
    SearchBar.tsx
    PropertyCard.tsx
    OffersTable.tsx
    PriceBadge.tsx
    CancellationBadge.tsx
    FeeImpactBanner.tsx
  lib/
    api.ts (axios/fetch client)
    sse.ts (EventSource helper)
    hooks/
      useOfferDeltas.ts
      useSearch.ts
      useProperty.ts
      useOffers.ts
  styles/
    globals.css
index.html
vite.config.ts
```

## Detailed endpoint specs (as used by UI)
- GET `/v1/search` → `{ properties: Property[], offers: Offer[] }`
- GET `/v1/property/:id` → `Property`
- GET `/v1/offers?propertyId=:id&checkIn&checkOut` → `Offer[]`
- GET `/v1/availability/stream?propertyId=:id` (SSE `event: delta`, `data: {...}`)
- POST `/v1/bit` → `{ token }`
- POST `/v1/bit/redeem` (Bearer token) → `{ checkoutSessionId, leadFeeBps }`
- POST `/v1/payments` → `{ status:"succeeded"|"requires_action"|"failed", bookingId? }`
- POST `/v1/escrow/release` → `{ transferId, proofOfStayVC }`

Note: Use the `VITE_API_BASE_URL` env at runtime (defaults to https://api.openrooms.net). Assume JSON responses as shown.

## Validation models (TypeScript, mirrored from schemas)
Define minimal TS types aligned with our JSON Schemas (can refine as needed):
- `Property`, `RoomType`, `Offer`, `BITIssuanceRequest`, `BITRedeemResponse`, `PaymentRequest`, `PaymentResponse`

## UI states to cover
- Loading: skeletons for list and detail
- Empty: “No results. Try adjusting dates/filters.”
- Errors: inline retry + toast, network/offline message
- SSE: visual hint when price/inventory changes
- Checkout: three-step progress indicator (Issue → Redeem → Pay)

## Telemetry & logging
- Console debug flags for network requests and SSE events in dev
- Basic timing metrics per request (performance.mark/measure)

## Testing
- Unit: component tests with Vitest/Jest + Testing Library
- E2E (optional): Playwright happy path search → property → checkout (mocked)

## Deliverables
- A working UI in a `clients/consumer-web/` folder
- README in that folder with env setup and run instructions
- `.env.example` with `VITE_API_BASE_URL=https://api.openrooms.net` and `DEV_MOCKS=false`
- Mock fixtures and toggle as described

## Visual style
- Clean, modern, accessible
- Card-based layout with generous spacing
- Clear price typography, badges for cancellation/fees
- Primary CTA/button consistent across views

## Nice-to-haves (optional)
- Map integration (OpenStreetMap/Leaflet) if bbox/geo available
- Saved searches (localStorage)
- Dark mode

## Notes
- If any endpoint is not available yet, fallback to mock fixtures and log a console warning. The API base URL will be provided later.
- Keep code modular and well-commented so we can swap endpoints or augment payloads easily.
