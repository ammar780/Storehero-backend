const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';

// SSL is required for any non-local connection. Railway/Neon/Supabase/etc. all use
// self-signed certs, so we accept those. Local development uses no SSL.
const isLocal = url.includes('localhost') || url.includes('127.0.0.1') || url.includes('::1');
const ssl = url && !isLocal ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: url,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB error:', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
