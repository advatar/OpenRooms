import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const { Pool } = pg;

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
    // Optional seed admin user (requires migrations to have run)
    const seedEmail = process.env.SEED_ADMIN_EMAIL;
    const seedPassword = process.env.SEED_ADMIN_PASSWORD;
    if (seedEmail && seedPassword) {
      try {
        const { rows: tableCheck } = await client.query("select to_regclass('public.admin_users') as exists");
        if (tableCheck[0]?.exists) {
          const hash = await bcrypt.hash(seedPassword, 10);
          await client.query(
            `insert into admin_users (id, email, password_hash, role)
             values ($1, $2, $3, 'admin')
             on conflict (email) do nothing`,
            ['adm_' + randomUUID(), seedEmail, hash]
          );
          console.log(`Seed admin ensured for email ${seedEmail}`);
        } else {
          console.warn('Skipping admin user seed: admin_users table not found (run migrations first).');
        }
      } catch (e) {
        console.warn('Skipping admin user seed due to error:', (e as any).message);
      }
    }
    // Stockholm sample data
    type Prop = {
      id: string;
      name: string;
      lat: number;
      lon: number;
      address: { country: string; locality: string; street: string; postalCode: string };
      contact: { website?: string; phone?: string; email?: string };
      photos: string[];
      amenities: string[];
      pms: { vendor: string; externalId: string };
      roomTypes: Array<{
        id: string;
        name: string;
        description: string;
        capacity: number;
        beds: Array<{ type: string; count: number }>;
        offers: Array<{
          id: string;
          checkIn: string;
          checkOut: string;
          ratePlan: string;
          price: { currency: string; base: number; taxes: number; fees: number; total: number };
          cancellation: { policy: string; freeUntil: string | null };
          inventory: number;
          terms: { payAt: 'booking' | 'property' };
          source: string;
        }>;
      }>;
    };

    const props: Prop[] = [
      {
        id: 'prop_gamlastan_1',
        name: 'Old Town Boutique Hotel',
        lat: 59.325, lon: 18.070,
        address: { country: 'SE', locality: 'Stockholm', street: 'Stora Nygatan 12', postalCode: '111 27' },
        contact: { website: 'https://example.com/oldtown', phone: '+46 8 410 123 45', email: 'stay@oldtown.example' },
        photos: [
          'https://images.unsplash.com/photo-1528909514045-2fa4ac7a08ba?q=80&w=1200',
          'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?q=80&w=1200'
        ],
        amenities: ['wifi', 'breakfast', 'historic', 'non-smoking', 'concierge'],
        pms: { vendor: 'mock', externalId: 'ots-1' },
        roomTypes: [
          {
            id: 'rt_gamlastan_queen',
            name: 'Queen Room Courtyard',
            description: 'Charming room facing a quiet 17th‑century courtyard with artisan details and oak floors.',
            capacity: 2,
            beds: [{ type: 'queen', count: 1 }],
            offers: [
              {
                id: 'offer_gamlastan_queen_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 2100, taxes: 210, fees: 40, total: 2350 },
                cancellation: { policy: 'Free cancellation up to 48h before arrival', freeUntil: null },
                inventory: 3,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      },
      {
        id: 'prop_sodermalm_1',
        name: 'Södermalm Design Stay',
        lat: 59.315, lon: 18.065,
        address: { country: 'SE', locality: 'Stockholm', street: 'Skånegatan 77', postalCode: '116 37' },
        contact: { website: 'https://example.com/sodermalm', phone: '+46 8 555 222 11', email: 'hello@sodermalm.example' },
        photos: [
          'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?q=80&w=1200',
          'https://images.unsplash.com/photo-1549187774-b4e9b0445b41?q=80&w=1200'
        ],
        amenities: ['wifi', 'breakfast', 'bar', 'gym', 'pet-friendly'],
        pms: { vendor: 'mock', externalId: 'sod-1' },
        roomTypes: [
          {
            id: 'rt_sodermalm_loft',
            name: 'Scandi Loft Suite',
            description: 'Airy loft with Nordic design, exposed beams, and views over Katarina church.',
            capacity: 3,
            beds: [{ type: 'king', count: 1 }],
            offers: [
              {
                id: 'offer_sodermalm_loft_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 2600, taxes: 260, fees: 40, total: 2900 },
                cancellation: { policy: 'Free cancellation up to 24h before arrival', freeUntil: null },
                inventory: 2,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      },
      {
        id: 'prop_djurgarden_1',
        name: 'Djurgården Park Hotel',
        lat: 59.327, lon: 18.121,
        address: { country: 'SE', locality: 'Stockholm', street: 'Galärvarvsvägen 10', postalCode: '115 21' },
        contact: { website: 'https://example.com/djurgarden', phone: '+46 8 777 000', email: 'stay@djurgarden.example' },
        photos: [
          'https://images.unsplash.com/photo-1528909514045-2fa4ac7a08ba?q=80&w=1200',
          'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?q=80&w=1200'
        ],
        amenities: ['wifi', 'breakfast', 'sauna', 'bike-rental', 'waterfront'],
        pms: { vendor: 'mock', externalId: 'dju-1' },
        roomTypes: [
          {
            id: 'rt_djurgarden_deluxe',
            name: 'Deluxe Park View',
            description: 'Bright room with panoramic windows overlooking the royal park and waterways.',
            capacity: 2,
            beds: [{ type: 'king', count: 1 }],
            offers: [
              {
                id: 'offer_djurgarden_deluxe_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 3200, taxes: 320, fees: 60, total: 3580 },
                cancellation: { policy: 'Free cancellation up to 72h before arrival', freeUntil: null },
                inventory: 4,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      },
      {
        id: 'prop_norrmalm_1',
        name: 'Norrmalm City Hub',
        lat: 59.335, lon: 18.065,
        address: { country: 'SE', locality: 'Stockholm', street: 'Kungsgatan 31', postalCode: '111 56' },
        contact: { website: 'https://example.com/norrmalm', phone: '+46 8 101 010', email: 'book@norrmalm.example' },
        photos: [
          'https://images.unsplash.com/photo-1511746315387-c4a76990fd63?q=80&w=1200'
        ],
        amenities: ['wifi', 'breakfast', 'gym', 'business-center'],
        pms: { vendor: 'mock', externalId: 'nor-1' },
        roomTypes: [
          {
            id: 'rt_norrmalm_standard',
            name: 'Standard Twin',
            description: 'Comfortable base downtown—steps from Hötorget, with fast Wi‑Fi and ergonomic desks.',
            capacity: 2,
            beds: [{ type: 'twin', count: 2 }],
            offers: [
              {
                id: 'offer_norrmalm_standard_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 1800, taxes: 180, fees: 40, total: 2020 },
                cancellation: { policy: 'Free cancellation up to 24h before arrival', freeUntil: null },
                inventory: 8,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      },
      {
        id: 'prop_vasastan_1',
        name: 'Vasastan Townhouse Inn',
        lat: 59.346, lon: 18.043,
        address: { country: 'SE', locality: 'Stockholm', street: 'Odengatan 72', postalCode: '113 22' },
        contact: { website: 'https://example.com/vasastan', phone: '+46 8 909 909', email: 'stay@vasastan.example' },
        photos: [
          'https://images.unsplash.com/photo-1494526585095-c41746248156?q=80&w=1200'
        ],
        amenities: ['wifi', 'breakfast', 'library', 'family-rooms'],
        pms: { vendor: 'mock', externalId: 'vas-1' },
        roomTypes: [
          {
            id: 'rt_vasastan_family',
            name: 'Family Room',
            description: 'Spacious family room with a cozy reading nook and playful Scandinavian decor.',
            capacity: 4,
            beds: [{ type: 'queen', count: 1 }, { type: 'bunk', count: 1 }],
            offers: [
              {
                id: 'offer_vasastan_family_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 2400, taxes: 240, fees: 40, total: 2680 },
                cancellation: { policy: 'Free cancellation up to 48h before arrival', freeUntil: null },
                inventory: 2,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      },
      {
        id: 'prop_archipelago_1',
        name: 'Stockholm Archipelago Lodge',
        lat: 59.405, lon: 18.635,
        address: { country: 'SE', locality: 'Vaxholm', street: 'Hamngatan 5', postalCode: '185 31' },
        contact: { website: 'https://example.com/archipelago', phone: '+46 8 300 300', email: 'hello@archipelago.example' },
        photos: [
          'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200',
          'https://images.unsplash.com/photo-1501183638710-841dd1904471?q=80&w=1200'
        ],
        amenities: ['wifi', 'sauna', 'sea-view', 'kayak-rental'],
        pms: { vendor: 'mock', externalId: 'arc-1' },
        roomTypes: [
          {
            id: 'rt_archipelago_cabin',
            name: 'Sea‑View Cabin',
            description: 'Timber cabin perched by the waterline—private deck and evening sauna included.',
            capacity: 2,
            beds: [{ type: 'queen', count: 1 }],
            offers: [
              {
                id: 'offer_archipelago_cabin_2025-10-12_2025-10-14',
                checkIn: '2025-10-12',
                checkOut: '2025-10-14',
                ratePlan: 'refundable',
                price: { currency: 'SEK', base: 3400, taxes: 340, fees: 60, total: 3800 },
                cancellation: { policy: 'Free cancellation up to 72h before arrival', freeUntil: null },
                inventory: 1,
                terms: { payAt: 'booking' },
                source: 'mock'
              }
            ]
          }
        ]
      }
    ];

    for (const p of props) {
      await client.query(
        `insert into properties (id, name, geo, address, contact, photos, amenities, pms)
         values ($1, $2, point($3, $4), $5::jsonb, $6::jsonb, $7::jsonb, $8::text[], $9::jsonb)
         on conflict (id) do update set name = excluded.name, updated_at = now();`,
        [
          p.id,
          p.name,
          p.lat,
          p.lon,
          JSON.stringify(p.address),
          JSON.stringify(p.contact),
          JSON.stringify(p.photos),
          p.amenities,
          JSON.stringify(p.pms)
        ]
      );

      for (const rt of p.roomTypes) {
        await client.query(
          `insert into room_types (id, property_id, name, description, capacity, beds)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do update set name = excluded.name, description = excluded.description, updated_at = now();`,
          [rt.id, p.id, rt.name, rt.description, rt.capacity, JSON.stringify(rt.beds)]
        );

        for (const off of rt.offers) {
          await client.query(
            `insert into offers (
               id, property_id, room_type_id, rate_plan, check_in, check_out, price, cancellation, inventory, terms, source
             ) values (
               $1, $2, $3, $4, $5::date, $6::date, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11
             )
             on conflict (id) do update set updated_at = now();`,
            [
              off.id,
              p.id,
              rt.id,
              off.ratePlan,
              off.checkIn,
              off.checkOut,
              JSON.stringify(off.price),
              JSON.stringify(off.cancellation),
              off.inventory,
              JSON.stringify(off.terms),
              off.source,
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete: inserted properties in Stockholm & surroundings.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
