import 'dotenv/config';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { createClient } from 'redis';

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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function buildServer() {
  const fastify = Fastify({ logger: true });

  // Health
  fastify.get('/health', async () => ({ ok: true }));

  // GET /v1/property/:id
  fastify.get('/v1/property/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query('select * from properties where id = $1', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Not found' });
    return rows[0];
  });

  // GET /v1/offers?propertyId=...&checkIn=...&checkOut=...
  fastify.get('/v1/offers', async (req, reply) => {
    const q = req.query as { propertyId?: string; checkIn?: string; checkOut?: string };
    if (!q.propertyId || !q.checkIn || !q.checkOut) {
      return reply.code(400).send({ error: 'propertyId, checkIn, checkOut are required' });
    }
    const { rows } = await pool.query(
      `select * from offers where property_id = $1 and check_in = $2 and check_out = $3 order by updated_at desc`,
      [q.propertyId, q.checkIn, q.checkOut]
    );
    return rows;
  });

  // GET /v1/search?query=...&checkIn=...&checkOut=...&guests=2&bbox=...
  fastify.get('/v1/search', async (req) => {
    const q = req.query as { query?: string; checkIn?: string; checkOut?: string; guests?: string; bbox?: string };
    const query = q.query?.trim() || '';
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
  fastify.get('/v1/availability/stream', async (req, reply) => {
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
