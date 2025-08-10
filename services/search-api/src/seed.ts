import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'booking',
    password: process.env.PGPASSWORD || 'booking',
    database: process.env.PGDATABASE || 'booking'
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      insert into properties (id, name, geo, address, contact, photos, amenities, pms)
      values ($1, $2, point(59.334591, 18.063240), $3, $4, $5, $6, $7)
      on conflict (id) do update set name = excluded.name;
    `, [
      'prop_demo_1',
      'Demo Hotel Stockholm',
      { country: 'SE', locality: 'Stockholm', street: 'Demo St 1', postalCode: '111 22' },
      { website: 'https://demo.hotel', phone: '+46 8 123 456', email: 'info@demo.hotel' },
      ['https://picsum.photos/seed/hotel/800/600'],
      ['wifi', 'breakfast', 'gym'],
      { vendor: 'mock', externalId: 'demo-1' }
    ]);

    await client.query(`
      insert into room_types (id, property_id, name, description, capacity, beds)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (id) do update set name = excluded.name;
    `, [
      'rt_demo_1',
      'prop_demo_1',
      'Standard Double',
      'Cozy room with a queen bed',
      2,
      [{ type: 'queen', count: 1 }]
    ]);

    await client.query(`
      insert into offers (
        id, property_id, room_type_id, rate_plan, check_in, check_out, price, cancellation, inventory, terms, source
      ) values (
        $1, $2, $3, $4, $5::date, $6::date, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11
      )
      on conflict (id) do update set updated_at = now();
    `, [
      'offer_demo_1_2025-10-12_2025-10-14',
      'prop_demo_1',
      'rt_demo_1',
      'refundable',
      '2025-10-12',
      '2025-10-14',
      { currency: 'EUR', base: 180, taxes: 36, fees: 4, total: 220 },
      { policy: 'Free cancellation until 48h before check-in', freeUntil: null },
      5,
      { payAt: 'booking' },
      'mock'
    ]);

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
