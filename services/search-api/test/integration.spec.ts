import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { buildServer } from '../src/index';

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  app = await buildServer({
    logger: false,
  });
});

afterAll(async () => {
  await app.close();
});

describe('Search API - basic', () => {
  test('GET /health -> 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// End-to-end placeholders. Requires Postgres + Redis running and proper env.
// To enable, remove .skip and ensure local services and env vars are set.
describe.skip('End-to-end flow: redeem -> pay -> release', () => {
  test('POST /v1/bit -> token, then redeem, pay, and release', async () => {
    // 1) Issue BIT
    const bitIssue = await app.inject({
      method: 'POST',
      url: '/v1/bit',
      payload: {
        propertyId: 'prop_1',
        offerId: 'offer_1',
        discoveryAppId: 'demo_app',
        leadFeeBps: 100,
        price: { currency: 'USD', base: 100, taxes: 10, fees: 5, total: 115 },
        stay: { checkIn: '2025-10-01', checkOut: '2025-10-03', guests: 2 },
      },
    });
    expect(bitIssue.statusCode).toBe(200);
    const { token } = bitIssue.json() as { token: string };
    expect(token).toBeTruthy();

    // 2) Redeem BIT
    const redeem = await app.inject({
      method: 'POST',
      url: '/v1/bit/redeem',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(redeem.statusCode).toBe(200);
    const { checkoutSessionId } = redeem.json() as { checkoutSessionId: string };
    expect(checkoutSessionId).toBeTruthy();

    // 3) Complete payment (simulated or Stripe in test mode if STRIPE_ENABLED=true)
    const pay = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      payload: { checkoutSessionId },
    });
    expect(pay.statusCode).toBe(200);
    const payBody = pay.json() as { status: string; bookingId: string };
    expect(payBody.status).toBe('succeeded');
    expect(payBody.bookingId).toBeTruthy();

    // 4) Release escrow
    const rel = await app.inject({
      method: 'POST',
      url: '/v1/escrow/release',
      payload: { bookingId: payBody.bookingId },
    });
    expect(rel.statusCode).toBe(200);
    const relBody = rel.json() as { transferId: string };
    expect(relBody.transferId).toBeTruthy();
  });
});
