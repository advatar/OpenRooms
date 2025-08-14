import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse';
import { lookup as mimeLookup } from 'mime-types';

// Types
type AdminPluginOpts = {
  pool: Pool;
  uploadDir: string;
  baseUrl: string;
  adminJwtSecret: string;
  tokenTtlSeconds: number;
  maxUploadBytes: number;
};

type AdminUser = { id: string; email: string; role: string };

type JwtPayload = { id: string; email: string; role: 'admin'; iat: number; exp: number; iss: string; aud: string };

// Error handling specific to admin endpoints
class AdminError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function parsePoint(geo: any): { latitude: number | null; longitude: number | null } {
  if (!geo) return { latitude: null, longitude: null };
  if (typeof geo === 'string') {
    // "(lat,lon)"
    const m = geo.match(/\(([^,]+),([^\)]+)\)/);
    if (m) return { latitude: Number(m[1]), longitude: Number(m[2]) };
  }
  if (typeof geo === 'object' && geo !== null) {
    // Some pg configurations may return { x, y }
    const lat = (geo as any).x ?? (geo as any).lat ?? null;
    const lon = (geo as any).y ?? (geo as any).lon ?? null;
    return { latitude: lat, longitude: lon } as any;
  }
  return { latitude: null, longitude: null };
}

function adminUserFromRow(row: any): AdminUser {
  return { id: String(row.id), email: String(row.email), role: String(row.role || 'admin') };
}

async function signAdminJWT(secret: string, user: AdminUser, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ id: user.id, email: user.email, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer('openrooms-admin')
    .setAudience('openrooms-admin')
    .setExpirationTime(now + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
  return token;
}

async function verifyAdminJWT(secret: string, token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'openrooms-admin',
    audience: 'openrooms-admin'
  });
  return payload as unknown as JwtPayload;
}

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(6) });

const PropertyBody = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  description: z.string().optional().default(''),
  amenities: z.array(z.string()).optional().default([]),
  stars: z.number().int().min(0).max(5).optional().default(0),
  photos: z.array(z.string()).optional().default([])
});

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  city: z.string().optional(),
  stars: z.coerce.number().int().min(0).max(5).optional()
});

const BulkBody = z.object({ properties: z.array(PropertyBody) });

const ImportApiBody = z.object({
  apiEndpoint: z.string().url(),
  apiKey: z.string().optional(),
  mapping: z.record(z.string()).optional().default({})
});

async function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function toAdminProperty(row: any) {
  const { latitude, longitude } = parsePoint(row.geo);
  return {
    id: String(row.id),
    name: row.name || '',
    address: typeof row.address === 'string' ? row.address : (row.address?.street || row.address?.freeform || ''),
    city: row.city || row.address?.locality || '',
    latitude,
    longitude,
    description: row.description || '',
    amenities: row.amenities || [],
    stars: row.stars ?? 0,
    photos: row.photos || [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

// Additional schemas for new admin features
const MessageCreateBody = z.object({
  text: z.string().min(1),
  attachments: z.array(z.string().url()).optional().default([]),
  recipientType: z.enum(['host', 'guest']).optional().default('host')
});

const BookingsListQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  escrowStatus: z.enum(['pending', 'held', 'released', 'refunded']).optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

const EscrowReleaseBody = z.object({
  bookingId: z.string().uuid(),
  proofOfStay: z.any().optional()
});

const DisputeCreateBody = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().min(1),
  details: z.record(z.any()).optional().default({})
});

const DisputeUpdateBody = z.object({
  status: z.enum(['open', 'resolved', 'escalated', 'canceled']),
  resolution: z.string().optional()
});

const DisputesListQuery = z.object({
  bookingId: z.string().uuid().optional(),
  status: z.enum(['open', 'resolved', 'escalated', 'canceled']).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50)
});

const VatReportGenerateBody = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  country: z.string().optional(),
  currency: z.string().optional().default('EUR'),
  save: z.boolean().optional().default(true)
});

export default async function adminRoutes(fastify: FastifyInstance, opts: AdminPluginOpts) {
  const { pool, uploadDir, baseUrl, adminJwtSecret, tokenTtlSeconds, maxUploadBytes } = opts;

  // Register multipart and static within plugin scope (idempotent/ok if already registered globally)
  if (!(fastify as any).hasMultipart) await fastify.register(multipart, { limits: { fileSize: maxUploadBytes } });
  await ensureDir(uploadDir);
  try {
    await fastify.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/' });
  } catch (_) {
    // may already be registered by root; ignore
  }

  // Admin-only error handler
  fastify.setErrorHandler((err, req, reply) => {
    const status = (err as any).status || (err as any).statusCode || (err instanceof AdminError ? err.status : 500);
    const code = err instanceof AdminError ? err.code : (status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR');
    const message = err.message || 'Internal error';
    const details = (err as any).details || (err as any).validation || undefined;
    reply.code(status).send({ error: { code, message, details } });
  });

  // Auth preHandler
  async function authGuard(req: FastifyRequest, _reply: FastifyReply) {
    if (req.method === 'POST' && req.url.endsWith('/auth/login')) return;
    // verify token for all admin endpoints except login
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) throw new AdminError('UNAUTHORIZED', 'Missing token', 401);
    try {
      const token = auth.slice('Bearer '.length);
      const payload = await verifyAdminJWT(adminJwtSecret, token);
      (req as any).admin = { id: payload.id, email: payload.email, role: payload.role } as AdminUser;
    } catch (e) {
      throw new AdminError('UNAUTHORIZED', 'Invalid or expired token', 401);
    }
  }
  fastify.addHook('onRequest', authGuard);

  // Auth: login
  fastify.post('/auth/login', { schema: { body: zodToJsonSchema(LoginBody, 'AdminLogin') } }, async (req) => {
    const body = LoginBody.parse((req as any).body);
    const { rows } = await pool.query('select * from admin_users where email = $1', [body.email]);
    const user = rows[0];
    if (!user) throw new AdminError('UNAUTHORIZED', 'Invalid credentials', 401);
    const ok = await bcrypt.compare(body.password, String(user.password_hash));
    if (!ok) throw new AdminError('UNAUTHORIZED', 'Invalid credentials', 401);
    await pool.query('update admin_users set last_login = now() where id = $1', [user.id]);
    const token = await signAdminJWT(adminJwtSecret, adminUserFromRow(user), tokenTtlSeconds);
    return { token, user: adminUserFromRow(user) };
  });

  // Auth: verify
  fastify.get('/auth/verify', async (req) => {
    const u = (req as any).admin as AdminUser;
    return { valid: true, user: u };
  });

  // Property: create
  fastify.post('/properties', { schema: { body: zodToJsonSchema(PropertyBody, 'PropertyCreate') }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = PropertyBody.parse((req as any).body);
      const admin = (req as any).admin as AdminUser;
      const id = 'prop_' + randomUUID();
      const addressJson = { street: body.address, locality: body.city };
      const photos = body.photos || [];
      const amenities = body.amenities || [];
      await pool.query(
        `insert into properties (id, name, geo, address, photos, amenities, description, stars, city, created_by)
         values ($1, $2, point($3, $4), $5::jsonb, $6::jsonb, $7::text[], $8, $9, $10, $11)`,
        [id, body.name, body.latitude, body.longitude, addressJson, photos, amenities, body.description || '', body.stars || 0, body.city, admin.id]
      );
      const { rows } = await pool.query('select * from properties where id = $1', [id]);
      return toAdminProperty(rows[0]);
    }
  );

  // Property: update
  fastify.put('/properties/:id', { schema: { body: zodToJsonSchema(PropertyBody, 'PropertyUpdate') } },
    async (req) => {
      const body = PropertyBody.parse((req as any).body);
      const { id } = (req as any).params as { id: string };
      const addressJson = { street: body.address, locality: body.city };
      const photos = body.photos || [];
      const amenities = body.amenities || [];
      const res = await pool.query(
        `update properties set name=$2, geo=point($3,$4), address=$5::jsonb, photos=$6::jsonb, amenities=$7::text[], description=$8, stars=$9, city=$10, updated_at=now() where id=$1 and deleted_at is null`,
        [id, body.name, body.latitude, body.longitude, addressJson, photos, amenities, body.description || '', body.stars || 0, body.city]
      );
      if (res.rowCount === 0) throw new AdminError('NOT_FOUND', 'Property not found', 404);
      const { rows } = await pool.query('select * from properties where id = $1', [id]);
      return toAdminProperty(rows[0]);
    }
  );

  // Property: delete (soft)
  fastify.delete('/properties/:id', async (req, reply) => {
    const { id } = (req as any).params as { id: string };
    const res = await pool.query(`update properties set deleted_at = now() where id=$1 and deleted_at is null`, [id]);
    if (res.rowCount === 0) throw new AdminError('NOT_FOUND', 'Property not found', 404);
    reply.code(204).send();
  });

  // Property: list
  fastify.get('/properties', { schema: { querystring: zodToJsonSchema(ListQuery, 'PropertyListQuery') } }, async (req) => {
    const q = ListQuery.parse((req as any).query);
    const where: string[] = ['deleted_at is null'];
    const params: any[] = [];
    let idx = 1;
    if (q.city) { where.push(`city = $${idx++}`); params.push(q.city); }
    if (typeof q.stars === 'number') { where.push(`stars = $${idx++}`); params.push(q.stars); }
    const whereSql = where.length ? 'where ' + where.join(' and ') : '';
    const { rows: countRows } = await pool.query(`select count(*)::int as total from properties ${whereSql}`, params);
    const total = Number(countRows[0]?.total || 0);
    const offset = (q.page - 1) * q.limit;
    const { rows } = await pool.query(`select * from properties ${whereSql} order by created_at desc limit $${idx++} offset $${idx++}`, [...params, q.limit, offset]);
    const properties = rows.map(toAdminProperty);
    const totalPages = Math.ceil(total / q.limit);
    return { properties, pagination: { page: q.page, limit: q.limit, total, totalPages } };
  });

  // Bulk create
  fastify.post('/properties/bulk', { schema: { body: zodToJsonSchema(BulkBody, 'BulkCreate') }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = BulkBody.parse((req as any).body);
    const admin = (req as any).admin as AdminUser;
    const client = await pool.connect();
    const errors: any[] = [];
    let created = 0;
    try {
      await client.query('BEGIN');
      for (let i = 0; i < body.properties.length; i++) {
        const p = body.properties[i];
        const valid = PropertyBody.safeParse(p);
        if (!valid.success) {
          errors.push({ index: i, property: p, error: valid.error.message });
          continue;
        }
        try {
          await client.query('SAVEPOINT sp');
          const id = 'prop_' + randomUUID();
          const addressJson = { street: p.address, locality: p.city };
          await client.query(
            `insert into properties (id, name, geo, address, photos, amenities, description, stars, city, created_by)
             values ($1,$2,point($3,$4),$5::jsonb,$6::jsonb,$7::text[],$8,$9,$10,$11)`,
            [id, p.name, p.latitude, p.longitude, addressJson, p.photos || [], p.amenities || [], p.description || '', p.stars || 0, p.city, admin.id]
          );
          created++;
        } catch (e: any) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          errors.push({ index: i, property: p, error: e.message || 'insert error' });
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new AdminError('INTERNAL_ERROR', 'Bulk insert failed', 500, { error: (e as any).message });
    } finally {
      client.release();
    }

    // import_logs entry
    const logId = randomUUID();
    await pool.query(
      `insert into import_logs(id, admin_user_id, import_type, source, properties_processed, properties_created, properties_failed, errors)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [logId, (req as any).admin.id, 'bulk', 'api', body.properties.length, created, errors.length, JSON.stringify(errors)]
    );

    return { created, failed: errors.length, errors };
  });

  // Upload images
  fastify.post('/upload/images', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const file = await (req as any).file({ limits: { fileSize: maxUploadBytes } });
    if (!file) throw new AdminError('VALIDATION_ERROR', 'No file uploaded', 400);
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) throw new AdminError('VALIDATION_ERROR', 'Unsupported file type', 400, { mimetype: file.mimetype });
    const ext = mimeLookup(file.filename) || (file.mimetype.split('/')[1] ?? 'bin');
    const name = 'img_' + randomUUID() + '.' + String(ext).split('/').pop();
    const storagePath = path.join(uploadDir, name);
    await ensureDir(uploadDir);
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(storagePath);
      file.file.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', (e) => reject(e));
    });
    const url = `${baseUrl.replace(/\/$/, '')}/uploads/${name}`;
    return { urls: [url] };
  });

  // Import from CSV/JSON file
  fastify.post('/properties/import', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const part = await (req as any).file({ limits: { fileSize: maxUploadBytes } });
    if (!part) throw new AdminError('VALIDATION_ERROR', 'No file uploaded', 400);
    const mimetype = part.mimetype;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      part.file.on('data', (d: Buffer) => chunks.push(d));
      part.file.on('end', () => resolve());
      part.file.on('error', (e: any) => reject(e));
    });
    const buf = Buffer.concat(chunks);

    let records: any[] = [];
    if (mimetype.includes('csv')) {
      records = await new Promise<any[]>((resolve, reject) => {
        const out: any[] = [];
        csvParse(buf, { columns: true, skip_empty_lines: true }, (err, recs) => {
          if (err) reject(err); else resolve(recs as any[]);
        });
      });
    } else if (mimetype.includes('json') || part.filename.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(buf.toString('utf8'));
      records = Array.isArray(json) ? json : Array.isArray(json.properties) ? json.properties : [];
    } else {
      throw new AdminError('VALIDATION_ERROR', 'Unsupported file type', 400, { mimetype });
    }

    let processed = 0, created = 0, updated = 0, failed = 0;
    const errors: any[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < records.length; i++) {
        processed++;
        const r = records[i];
        const obj = {
          name: r.name ?? r.property_name ?? '',
          address: r.address ?? r.full_address ?? '',
          city: r.city ?? r.locality ?? '',
          latitude: Number(r.latitude ?? r.lat ?? 0),
          longitude: Number(r.longitude ?? r.lng ?? 0),
          description: r.description ?? '',
          amenities: r.amenities ?? [],
          stars: Number(r.stars ?? 0),
          photos: r.photos ?? []
        };
        const valid = PropertyBody.safeParse(obj);
        if (!valid.success) {
          failed++; errors.push({ row: i + 1, data: r, error: valid.error.message }); continue;
        }
        try {
          await client.query('SAVEPOINT sp');
          // Upsert by name+city heuristic
          const find = await client.query(`select id from properties where name=$1 and city=$2 and deleted_at is null`, [obj.name, obj.city]);
          if (find.rows[0]) {
            const id = String(find.rows[0].id);
            await client.query(
              `update properties set geo=point($2,$3), address=$4::jsonb, photos=$5::jsonb, amenities=$6::text[], description=$7, stars=$8, city=$9, updated_at=now() where id=$1`,
              [id, obj.latitude, obj.longitude, { street: obj.address, locality: obj.city }, obj.photos, obj.amenities, obj.description, obj.stars, obj.city]
            );
            updated++;
          } else {
            const id = 'prop_' + randomUUID();
            await client.query(
              `insert into properties (id, name, geo, address, photos, amenities, description, stars, city)
               values ($1,$2,point($3,$4),$5::jsonb,$6::jsonb,$7::text[],$8,$9,$10)`,
              [id, obj.name, obj.latitude, obj.longitude, { street: obj.address, locality: obj.city }, obj.photos, obj.amenities, obj.description, obj.stars, obj.city]
            );
            created++;
          }
        } catch (e: any) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          failed++; errors.push({ row: i + 1, data: r, error: e.message || 'insert/update error' });
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new AdminError('INTERNAL_ERROR', 'Import failed', 500, { error: (e as any).message });
    } finally {
      client.release();
    }

    const logId = randomUUID();
    await pool.query(
      `insert into import_logs(id, admin_user_id, import_type, source, properties_processed, properties_created, properties_failed, errors)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [logId, (req as any).admin.id, 'csv', part.filename, processed, created, failed, JSON.stringify(errors)]
    );

    return { processed, created, updated, failed, errors };
  });

  // Import from external API
  fastify.post('/properties/import-api', { schema: { body: zodToJsonSchema(ImportApiBody, 'ImportApiRequest') }, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const body = ImportApiBody.parse((req as any).body);
    const headers: Record<string, string> = {};
    if (body.apiKey) headers['Authorization'] = `Bearer ${body.apiKey}`;
    const res = await fetch(body.apiEndpoint, { headers });
    if (!res.ok) throw new AdminError('INTERNAL_ERROR', `Fetch failed: ${res.status}`, 500);
    const data = await res.json();
    const items: any[] = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : Array.isArray((data as any).properties) ? (data as any).properties : [];

    const map = (src: any) => ({
      name: src[body.mapping?.name || 'name'],
      address: src[body.mapping?.address || 'address'],
      latitude: Number(src[body.mapping?.latitude || 'latitude'] ?? src['lat']),
      longitude: Number(src[body.mapping?.longitude || 'longitude'] ?? src['lng']),
      city: src[body.mapping?.city || 'city'] ?? src['locality'] ?? '',
      description: src[body.mapping?.description || 'description'] ?? '',
      amenities: src[body.mapping?.amenities || 'amenities'] ?? [],
      stars: Number(src[body.mapping?.stars || 'stars'] ?? 0),
      photos: src[body.mapping?.photos || 'photos'] ?? []
    });

    let imported = 0, failed = 0; const errors: string[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < items.length; i++) {
        const p = map(items[i]);
        const v = PropertyBody.safeParse(p);
        if (!v.success) { failed++; errors.push(`Row ${i + 1}: ${v.error.message}`); continue; }
        try {
          await client.query('SAVEPOINT sp');
          const id = 'prop_' + randomUUID();
          await client.query(
            `insert into properties (id, name, geo, address, photos, amenities, description, stars, city)
             values ($1,$2,point($3,$4),$5::jsonb,$6::jsonb,$7::text[],$8,$9,$10)`,
            [id, p.name, p.latitude, p.longitude, { street: p.address, locality: p.city }, p.photos, p.amenities, p.description, p.stars, p.city]
          );
          imported++;
        } catch (e: any) {
          await client.query('ROLLBACK TO SAVEPOINT sp');
          failed++; errors.push(`Row ${i + 1}: ${e.message || 'insert error'}`);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new AdminError('INTERNAL_ERROR', 'Import from API failed', 500, { error: (e as any).message });
    } finally {
      client.release();
    }

    const logId = randomUUID();
    await pool.query(
      `insert into import_logs(id, admin_user_id, import_type, source, properties_processed, properties_created, properties_failed, errors)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [logId, (req as any).admin.id, 'api', body.apiEndpoint, items.length, imported, failed, JSON.stringify(errors)]
    );

    return { imported, failed, errors };
  });

  // Bookings: list with escrow filters and dates
  fastify.get('/bookings', { schema: { querystring: zodToJsonSchema(BookingsListQuery, 'BookingsListQuery') } }, async (req) => {
    const q = BookingsListQuery.parse((req as any).query);
    const where: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (q.escrowStatus) { where.push(`escrow_status = $${idx++}`); params.push(q.escrowStatus); }
    if (q.from) { where.push(`created_at >= $${idx++}`); params.push(q.from); }
    if (q.to) { where.push(`created_at <= $${idx++}`); params.push(q.to); }
    const whereSql = where.length ? 'where ' + where.join(' and ') : '';
    const { rows: cnt } = await pool.query(`select count(*)::int as total from bookings ${whereSql}`, params);
    const total = Number(cnt[0]?.total || 0);
    const offset = (q.page - 1) * q.limit;
    const { rows } = await pool.query(`select * from bookings ${whereSql} order by created_at desc limit $${idx++} offset $${idx++}`, [...params, q.limit, offset]);
    return { bookings: rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
  });

  // Messaging: list messages for a booking
  fastify.get('/bookings/:id/messages', async (req) => {
    const { id } = (req as any).params as { id: string };
    const { rows } = await pool.query(`select * from messages where booking_id = $1 order by created_at asc`, [id]);
    return { messages: rows };
  });

  // Messaging: create message from admin to host/guest
  fastify.post('/bookings/:id/messages', { schema: { body: zodToJsonSchema(MessageCreateBody, 'MessageCreate') }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = (req as any).params as { id: string };
    const body = MessageCreateBody.parse((req as any).body);
    const admin = (req as any).admin as AdminUser;
    const msgId = 'msg_' + randomUUID();
    await pool.query(
      `insert into messages (id, booking_id, sender_type, sender_id, recipient_type, recipient_id, body, attachments)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [msgId, id, 'admin', admin.id, body.recipientType, null, body.text, JSON.stringify(body.attachments || [])]
    );
    const { rows } = await pool.query(`select * from messages where id = $1`, [msgId]);
    return rows[0];
  });

  // Escrow: release funds for a booking (manual)
  fastify.post('/escrow/release', { schema: { body: zodToJsonSchema(EscrowReleaseBody, 'EscrowReleaseBody') }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = EscrowReleaseBody.parse((req as any).body);
    const proof = body.proofOfStay || { type: 'ProofOfStay', bookingId: body.bookingId, issuedAt: new Date().toISOString(), issuer: 'admin' };
    const res = await pool.query(`update bookings set escrow_status='released', released_at=now(), proof_of_stay=$2 where id=$1`, [body.bookingId, proof]);
    if (res.rowCount === 0) throw new AdminError('NOT_FOUND', 'Booking not found', 404);
    return { status: 'released', bookingId: body.bookingId };
  });

  // Disputes: create
  fastify.post('/disputes', { schema: { body: zodToJsonSchema(DisputeCreateBody, 'DisputeCreate') } }, async (req) => {
    const body = DisputeCreateBody.parse((req as any).body);
    const admin = (req as any).admin as AdminUser;
    const id = 'disp_' + randomUUID();
    await pool.query(
      `insert into disputes (id, booking_id, status, reason, details, created_by)
       values ($1,$2,'open',$3,$4::jsonb,$5)`,
      [id, body.bookingId, body.reason, JSON.stringify(body.details || {}), admin.id]
    );
    const { rows } = await pool.query('select * from disputes where id=$1', [id]);
    return rows[0];
  });

  // Disputes: list
  fastify.get('/disputes', { schema: { querystring: zodToJsonSchema(DisputesListQuery, 'DisputesListQuery') } }, async (req) => {
    const q = DisputesListQuery.parse((req as any).query);
    const where: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (q.bookingId) { where.push(`booking_id = $${idx++}`); params.push(q.bookingId); }
    if (q.status) { where.push(`status = $${idx++}`); params.push(q.status); }
    const whereSql = where.length ? 'where ' + where.join(' and ') : '';
    const { rows: cnt } = await pool.query(`select count(*)::int as total from disputes ${whereSql}`, params);
    const total = Number(cnt[0]?.total || 0);
    const offset = (q.page - 1) * q.limit;
    const { rows } = await pool.query(`select * from disputes ${whereSql} order by created_at desc limit $${idx++} offset $${idx++}`, [...params, q.limit, offset]);
    return { disputes: rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
  });

  // Disputes: update status/resolution
  fastify.patch('/disputes/:id', { schema: { body: zodToJsonSchema(DisputeUpdateBody, 'DisputeUpdate') } }, async (req) => {
    const { id } = (req as any).params as { id: string };
    const body = DisputeUpdateBody.parse((req as any).body);
    const res = await pool.query(`update disputes set status=$2, resolution=coalesce($3, resolution), updated_at=now() where id=$1`, [id, body.status, body.resolution || null]);
    if (res.rowCount === 0) throw new AdminError('NOT_FOUND', 'Dispute not found', 404);
    const { rows } = await pool.query('select * from disputes where id=$1', [id]);
    return rows[0];
  });

  // VAT: generate a report (optionally persist)
  fastify.post('/vat/reports/generate', { schema: { body: zodToJsonSchema(VatReportGenerateBody, 'VatReportGenerateBody') }, config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (req) => {
    const body = VatReportGenerateBody.parse((req as any).body);
    const admin = (req as any).admin as AdminUser;
    const args: any[] = [body.periodStart, body.periodEnd];
    let where = `status = 'succeeded' and created_at >= $1 and created_at <= $2`;
    if (body.country) { where += ` and coalesce(vat_country, '') = $3`; args.push(body.country); }
    const { rows } = await pool.query(
      `select coalesce(vat_country,'') as country,
              lower(coalesce(amount->>'currency','eur')) as currency,
              sum(coalesce((amount->>'total')::numeric,0)) as total,
              sum(coalesce(vat_amount,0)) as vat_total,
              sum(coalesce(commission_amount,0)) as commission_total,
              count(*)::int as count
       from bookings where ${where}
       group by 1,2 order by 1,2`,
      args
    );
    const report = { periodStart: body.periodStart, periodEnd: body.periodEnd, country: body.country || null, currency: body.currency, groups: rows, generatedAt: new Date().toISOString() };
    let reportId: string | null = null;
    if (body.save) {
      reportId = 'vat_' + randomUUID();
      await pool.query(
        `insert into vat_reports (id, period_start, period_end, country, currency, totals, generated_by)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [reportId, body.periodStart, body.periodEnd, body.country || null, body.currency || 'EUR', JSON.stringify(report), admin.id]
      );
    }
    return { report, reportId };
  });

  // VAT: list and get reports
  const VatListQuery = z.object({ page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(200).optional().default(50) });
  fastify.get('/vat/reports', { schema: { querystring: zodToJsonSchema(VatListQuery, 'VatListQuery') } }, async (req) => {
    const q = VatListQuery.parse((req as any).query);
    const offset = (q.page - 1) * q.limit;
    const { rows: cnt } = await pool.query(`select count(*)::int as total from vat_reports`, []);
    const total = Number(cnt[0]?.total || 0);
    const { rows } = await pool.query(`select * from vat_reports order by created_at desc limit $1 offset $2`, [q.limit, offset]);
    return { reports: rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
  });
  fastify.get('/vat/reports/:id', async (req, reply) => {
    const { id } = (req as any).params as { id: string };
    const { rows } = await pool.query(`select * from vat_reports where id = $1`, [id]);
    if (!rows[0]) throw new AdminError('NOT_FOUND', 'Report not found', 404);
    return rows[0];
  });
}
