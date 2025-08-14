/* eslint-disable */
/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Bookings: enhancements for escrow and VAT
  pgm.addColumns('bookings', {
    check_in: { type: 'date' },
    check_out: { type: 'date' },
    paid_at: { type: 'timestamptz' },
    escrow_status: { type: 'text', default: 'pending' }, // pending | held | released | refunded
    escrow_release_at: { type: 'timestamptz' },
    released_at: { type: 'timestamptz' },
    proof_of_stay: { type: 'jsonb' },
    vat_country: { type: 'text' },
    vat_amount: { type: 'numeric(12,2)', default: 0 },
    commission_amount: { type: 'numeric(12,2)', default: 0 }
  });
  pgm.createIndex('bookings', ['escrow_status', 'escrow_release_at'], { name: 'bookings_escrow_idx' });

  // Messages table
  pgm.createTable('messages', {
    id: { type: 'text', primaryKey: true },
    booking_id: { type: 'uuid', references: 'bookings(id)', onDelete: 'CASCADE' },
    sender_type: { type: 'text' }, // 'admin' | 'host' | 'guest' | 'system'
    sender_id: { type: 'text' },
    recipient_type: { type: 'text' },
    recipient_id: { type: 'text' },
    body: { type: 'text', notNull: true },
    attachments: { type: 'jsonb' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') },
    read_at: { type: 'timestamptz' }
  });
  pgm.createIndex('messages', ['booking_id', 'created_at'], { name: 'messages_booking_created_idx' });

  // Disputes table
  pgm.createTable('disputes', {
    id: { type: 'text', primaryKey: true },
    booking_id: { type: 'uuid', references: 'bookings(id)', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'open' }, // open | resolved | escalated | canceled
    reason: { type: 'text' },
    details: { type: 'jsonb' },
    resolution: { type: 'text' },
    created_by: { type: 'text', references: 'admin_users(id)' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
  pgm.createIndex('disputes', ['booking_id', 'status'], { name: 'disputes_booking_status_idx' });

  // VAT reports table
  pgm.createTable('vat_reports', {
    id: { type: 'text', primaryKey: true },
    period_start: { type: 'date', notNull: true },
    period_end: { type: 'date', notNull: true },
    country: { type: 'text' },
    currency: { type: 'text', default: 'EUR' },
    totals: { type: 'jsonb' }, // e.g. { groups: [{ country, currency, total, vat_total, commission_total, count }], generatedAt }
    generated_by: { type: 'text', references: 'admin_users(id)' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
  pgm.createIndex('vat_reports', ['period_start', 'period_end', 'country'], { name: 'vat_reports_period_country_idx' });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('vat_reports', ['period_start', 'period_end', 'country'], { name: 'vat_reports_period_country_idx' });
  pgm.dropTable('vat_reports');

  pgm.dropIndex('disputes', ['booking_id', 'status'], { name: 'disputes_booking_status_idx' });
  pgm.dropTable('disputes');

  pgm.dropIndex('messages', ['booking_id', 'created_at'], { name: 'messages_booking_created_idx' });
  pgm.dropTable('messages');

  pgm.dropIndex('bookings', ['escrow_status', 'escrow_release_at'], { name: 'bookings_escrow_idx' });
  pgm.dropColumns('bookings', [
    'check_in',
    'check_out',
    'paid_at',
    'escrow_status',
    'escrow_release_at',
    'released_at',
    'proof_of_stay',
    'vat_country',
    'vat_amount',
    'commission_amount'
  ]);
};
