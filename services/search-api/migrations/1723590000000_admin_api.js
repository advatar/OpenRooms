/* eslint-disable */
/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Properties: new metadata columns
  pgm.addColumns('properties', {
    created_at: { type: 'timestamptz', default: pgm.func('now()') },
    description: { type: 'text' },
    stars: { type: 'int' },
    city: { type: 'text' },
    created_by: { type: 'text' },
    deleted_at: { type: 'timestamptz' }
  });

  // Indexes for properties
  pgm.createIndex('properties', 'city', { name: 'properties_city_idx' });
  pgm.createIndex('properties', 'stars', { name: 'properties_stars_idx' });
  pgm.createIndex('properties', 'created_at', { name: 'properties_created_at_idx' });

  // Admin users table
  pgm.createTable('admin_users', {
    id: { type: 'text', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', default: 'admin' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') },
    last_login: { type: 'timestamptz' }
  });

  // Import logs table
  pgm.createTable('import_logs', {
    id: { type: 'text', primaryKey: true },
    admin_user_id: { type: 'text', references: 'admin_users(id)' },
    import_type: { type: 'text' }, // 'bulk', 'csv', 'json', 'api'
    source: { type: 'text' }, // filename or API endpoint
    properties_processed: { type: 'int' },
    properties_created: { type: 'int' },
    properties_failed: { type: 'int' },
    errors: { type: 'jsonb' },
    created_at: { type: 'timestamptz', default: pgm.func('now()') }
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('import_logs');
  pgm.dropTable('admin_users');
  pgm.dropIndex('properties', 'created_at', { name: 'properties_created_at_idx' });
  pgm.dropIndex('properties', 'stars', { name: 'properties_stars_idx' });
  pgm.dropIndex('properties', 'city', { name: 'properties_city_idx' });
  pgm.dropColumns('properties', ['created_at', 'description', 'stars', 'city', 'created_by', 'deleted_at']);
};
