/* eslint-disable */
/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('properties', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text' },
    geo: { type: 'point' },
    address: { type: 'jsonb' },
    contact: { type: 'jsonb' },
    photos: { type: 'jsonb' },
    amenities: { type: 'text[]' },
    pms: { type: 'jsonb' },
    updated_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
  pgm.createIndex('properties', 'name', { method: 'gin', expression: `to_tsvector('simple', name)` });

  pgm.createTable('room_types', {
    id: { type: 'text', primaryKey: true },
    property_id: { type: 'text', references: 'properties(id)' },
    name: { type: 'text' },
    description: { type: 'text' },
    capacity: { type: 'int' },
    beds: { type: 'jsonb' },
    updated_at: { type: 'timestamptz', default: pgm.func('now()') }
  });

  pgm.createTable('offers', {
    id: { type: 'text', primaryKey: true },
    property_id: { type: 'text', references: 'properties(id)' },
    room_type_id: { type: 'text', references: 'room_types(id)' },
    rate_plan: { type: 'text' },
    check_in: { type: 'date' },
    check_out: { type: 'date' },
    price: { type: 'jsonb' },
    cancellation: { type: 'jsonb' },
    inventory: { type: 'int' },
    terms: { type: 'jsonb' },
    source: { type: 'text' },
    updated_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
  pgm.createIndex('offers', ['property_id', 'check_in', 'check_out']);

  pgm.createTable('bookings', {
    id: { type: 'uuid', primaryKey: true },
    checkout_session_id: { type: 'text', unique: true },
    property_id: { type: 'text' },
    offer_id: { type: 'text' },
    lead_fee_bps: { type: 'int' },
    amount: { type: 'jsonb' },
    status: { type: 'text' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('bookings');
  pgm.dropTable('offers');
  pgm.dropTable('room_types');
  pgm.dropTable('properties');
};
