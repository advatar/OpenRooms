import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { SignJWT, importJWK, jwtVerify, JWK } from 'jose';
import { randomUUID } from 'crypto';

const PORT = Number(process.env.PORT || 3001);

// Postgres pool
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'booking',
  password: process.env.PGPASSWORD || 'booking',
  database: process.env.PGDATABASE || 'booking'
});

// Redis client
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = createClient({ url: redisUrl });

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      create table if not exists properties(
        id text primary key,
        name text,
        geo point,
        address jsonb,
        contact jsonb,
        photos jsonb,
        amenities text[],
        pms jsonb,
        updated_at timestamptz default now()
      );
    `);
    await client.query(`
      create index if not exists properties_name_idx on properties using gin (to_tsvector('simple', name));
    `);
    await client.query(`
      create table if not exists room_types(
        id text primary key,
        property_id text references properties(id),
        name text,
        description text,
        capacity int,
        beds jsonb,
        updated_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists offers(
        id text primary key,
        property_id text references properties(id),
        room_type_id text references room_types(id),
        rate_plan text,
        check_in date,
        check_out date,
        price jsonb,
        cancellation jsonb,
        inventory int,
        terms jsonb,
        source text,
        updated_at timestamptz default now()
      );
    `);
    await client.query(`
      create index if not exists offers_prop_dates_idx on offers(property_id, check_in, check_out);
    `);
    await client.query(`
      create table if not exists bookings(
        id uuid primary key,
        checkout_session_id text unique,
        property_id text,
        offer_id text,
        lead_fee_bps int,
        amount jsonb,
        status text,
        created_at timestamptz default now()
      );
    `);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

class AppError extends Error {
  statusCode: number;
  details?: unknown;
  constructor(message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export async function buildServer() {
  const fastify = Fastify({ logger: true, genReqId: () => randomUUID() });

  await fastify.register(cors, { origin: true, credentials: false });
  await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await fastify.register(swagger, { openapi: { info: { title: 'Open Booking Network API', version: '0.1.0' } } });
  await fastify.register(swaggerUi, { routePrefix: '/docs' });

  // CORS for UI and external clients
  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: any) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    // Propagate request id
    reply.header('x-request-id', (request as any).id);
    return payload;
  });
  fastify.options('/*', async (_req: any, reply: any) => reply.code(200).send());

  fastify.setErrorHandler((err, req, reply) => {
    const status = (err as any).statusCode || (err instanceof AppError ? err.statusCode : 500);
    const body: any = { error: err.message || 'Internal Server Error' };
    if (err instanceof AppError && err.details) body.details = err.details;
    reply.header('x-request-id', (req as any).id);
    reply.code(status).send(body);
  });

  // Schemas
  const PriceSchema = z.object({ currency: z.string(), total: z.number().nonnegative() });
  const StaySchema = z.object({ checkIn: z.string(), checkOut: z.string() });
  const BitIssueBody = z.object({
    propertyId: z.string(),
    offerId: z.string(),
    discoveryAppId: z.string(),
    leadFeeBps: z.number().int().min(0).max(10_000).optional(),
    price: PriceSchema,
    stay: StaySchema
  });
  const BitRedeemHeaders = z.object({ authorization: z.string() });
  const PaymentsBody = z.object({
    checkoutSessionId: z.string(),
    paymentMethodId: z.string().optional()
  });
  const EscrowBody = z.object({ bookingId: z.string() });
  const OffersQuery = z.object({ propertyId: z.string(), checkIn: z.string(), checkOut: z.string() });
  const SearchQuery = z.object({
    query: z.string().optional(),
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    guests: z.string().optional(),
    bbox: z.string().optional()
  });

  // Health
  fastify.get('/health', async () => ({ ok: true }));

  // GET /v1/property/:id
  fastify.get('/v1/property/:id', async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query('select * from properties where id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    return rows[0];
  });

  // GET /v1/offers?propertyId=...&checkIn=...&checkOut=...
  fastify.get('/v1/offers', {
    schema: { querystring: zodToJsonSchema(OffersQuery, 'OffersQuery') }
  }, async (req: any) => {
    const q = OffersQuery.parse(req.query);
    const { rows } = await pool.query(
      `select * from offers where property_id = $1 and check_in = $2 and check_out = $3 order by updated_at desc`,
      [q.propertyId, q.checkIn, q.checkOut]
    );
    return rows;
  });

  // GET /v1/search?query=...&checkIn=...&checkOut=...&guests=2&bbox=...
  fastify.get('/v1/search', {
    schema: { querystring: zodToJsonSchema(SearchQuery, 'SearchQuery') }
  }, async (req: any) => {
    const q = SearchQuery.parse(req.query);
    const query = (q.query || '').trim();
    // naive search by name substring; bbox ignored in MVP
    const props = await pool.query(
      `select * from properties where ($1 = '' or name ilike '%' || $1 || '%') limit 50`,
      [query]
    );
    // fetch offers per property for given dates
    let offers: any[] = [];
    if (q.checkIn && q.checkOut) {
      const propIds = props.rows.map((r) => r.id);
      if (propIds.length) {
        const { rows } = await pool.query(
          `select * from offers where property_id = any($1) and check_in = $2 and check_out = $3`,
          [propIds, q.checkIn, q.checkOut]
        );
        offers = rows;
      }
    }
    return { properties: props.rows, offers };
  });

  // GET /v1/availability/stream?propertyId=...
  fastify.get('/v1/availability/stream', async (req: any, reply: any) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const sub = createClient({ url: redisUrl });
    await sub.connect();
    const channel = 'offers:delta';
    await sub.subscribe(channel, (message) => {
      reply.raw.write(`event: delta\n`);
      reply.raw.write(`data: ${message}\n\n`);
    });

    req.raw.on('close', async () => {
      await sub.unsubscribe(channel);
      await sub.quit();
    });
  });

  // POST /v1/bit (issue booking intent token)
  fastify.post('/v1/bit', {
    schema: { body: zodToJsonSchema(BitIssueBody, 'BitIssueBody') }
  }, async (req: any) => {
    const body = BitIssueBody.parse(req.body);
    const cap = Number(process.env.LEAD_FEE_CAP_BPS || 200);
    const requested = Number(body.leadFeeBps ?? cap);
    const leadFeeBps = Math.min(requested, cap);

    const issuer = process.env.BIT_ISSUER_DID || 'did:key:dev-issuer';
    const aud = 'hotel-plugin';
    const now = Math.floor(Date.now() / 1000);
    const expSeconds = Number(process.env.BIT_TTL_SECONDS || 24 * 3600);

    // Load EdDSA private key from env JWK
    const jwkStr = process.env.BIT_PRIVATE_KEY_JWK;
    if (!jwkStr) throw new AppError('BIT_PRIVATE_KEY_JWK missing', 500);
    let privateKey: any;
    try {
      const jwk: JWK = JSON.parse(jwkStr);
      privateKey = await importJWK(jwk, 'EdDSA');
    } catch (e) {
      throw new AppError('Invalid BIT_PRIVATE_KEY_JWK', 500);
    }

    const token = await new SignJWT({
      propertyId: body.propertyId,
      offerId: body.offerId,
      discoveryAppId: body.discoveryAppId,
      leadFeeBps,
      price: body.price,
      stay: body.stay
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuedAt(now)
      .setIssuer(issuer)
      .setAudience(aud)
      .setJti(randomUUID())
      .setExpirationTime(now + expSeconds)
      .sign(privateKey);

    return { token };
  });

  // POST /v1/bit/redeem (verify and create checkout session)
  fastify.post('/v1/bit/redeem', {
    schema: { headers: zodToJsonSchema(BitRedeemHeaders, 'BitRedeemHeaders') }
  }, async (req: any) => {
    const { authorization } = BitRedeemHeaders.parse(req.headers);
    const auth = authorization;
    if (!auth || !auth.startsWith('Bearer ')) throw new AppError('Missing token', 401);
    const token = auth.slice('Bearer '.length);

    // Load public key from env or derive from private JWK
    const jwkStr = process.env.BIT_PUBLIC_KEY_JWK || process.env.BIT_PRIVATE_KEY_JWK;
    if (!jwkStr) throw new AppError('BIT_PUBLIC_KEY_JWK or BIT_PRIVATE_KEY_JWK missing', 500);
    let publicKey: any;
    try {
      const jwk: JWK = JSON.parse(jwkStr);
      publicKey = await importJWK(jwk, 'EdDSA');
    } catch (e) {
      throw new AppError('Invalid BIT_PUBLIC_KEY_JWK', 500);
    }
    let payload: any;
    try {
      const { payload: pl } = await jwtVerify(token, publicKey, { audience: 'hotel-plugin' });
      payload = pl;
    } catch (e) {
      throw new AppError('Invalid or expired token', 401);
    }

    // Create a checkout session record
    const checkoutSessionId = randomUUID();
    const leadFeeBps = Number(payload.leadFeeBps || process.env.LEAD_FEE_CAP_BPS || 200);
    const amount = payload.price || null;
    await pool.query(
      `insert into bookings(id, checkout_session_id, property_id, offer_id, lead_fee_bps, amount, status)
       values($1,$2,$3,$4,$5,$6,$7)
       on conflict (checkout_session_id) do nothing`,
      [randomUUID(), checkoutSessionId, payload.propertyId, payload.offerId, leadFeeBps, amount, 'pending']
    );

    return { checkoutSessionId, leadFeeBps };
  });

  // POST /v1/payments (simulate or call Stripe)
  fastify.post('/v1/payments', {
    schema: { body: zodToJsonSchema(PaymentsBody, 'PaymentsBody') }
  }, async (req: any) => {
    const body = PaymentsBody.parse(req.body);
    const { rows } = await pool.query('select * from bookings where checkout_session_id = $1', [body.checkoutSessionId]);
    if (!rows[0]) throw new AppError('checkoutSessionId not found', 404);
    const booking = rows[0];
    const enableStripe = (process.env.STRIPE_ENABLED || 'false').toLowerCase() === 'true';

    if (enableStripe) {
      if (!process.env.STRIPE_API_KEY) throw new AppError('Stripe not configured', 500);
      if (!body.paymentMethodId) throw new AppError('paymentMethodId required when STRIPE_ENABLED=true', 400);
      const stripe = new Stripe(process.env.STRIPE_API_KEY, { apiVersion: '2024-06-20' });
      const total = Number(booking.amount?.total || 0);
      const currency = String(booking.amount?.currency || 'usd').toLowerCase();
      const amountInMinor = Math.round(total * 100);
      const pi = await stripe.paymentIntents.create({
        amount: amountInMinor,
        currency,
        payment_method: body.paymentMethodId,
        confirm: true,
        description: `Booking ${booking.checkout_session_id}`
      });
      if (pi.status !== 'succeeded') throw new AppError(`Payment ${pi.status}`, 402, { paymentIntentId: pi.id });
    }

    const bookingId = randomUUID();
    await pool.query(`update bookings set status = 'succeeded', id = $1 where checkout_session_id = $2`, [bookingId, body.checkoutSessionId]);
    return { status: 'succeeded', bookingId };
  });

  // POST /v1/escrow/release (simulate release and PoS VC)
  fastify.post('/v1/escrow/release', {
    schema: { body: zodToJsonSchema(EscrowBody, 'EscrowBody') }
  }, async (req: any) => {
    const body = EscrowBody.parse(req.body);
    const transferId = 'tr_' + randomUUID();
    const proofOfStayVC = {
      type: 'ProofOfStay',
      bookingId: body.bookingId,
      issuedAt: new Date().toISOString()
    };
    return { transferId, proofOfStayVC };
  });

  return fastify;
}

async function start() {
  await initDb();
  await redis.connect();
  const server = await buildServer();
  await server.listen({ port: PORT, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
