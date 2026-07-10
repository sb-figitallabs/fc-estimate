import fs from 'node:fs';
import pg from 'pg';

/**
 * SSL: when PGSSLROOTCERT points at a CA bundle (e.g. AWS RDS global bundle),
 * verify against it; otherwise fall back to the connection string's sslmode.
 * Download the bundle: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 */
const ssl = process.env.PGSSLROOTCERT
  ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT).toString() }
  : undefined;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ...(ssl ? { ssl } : {}),
});

// A transient error on an IDLE pooled connection (e.g. RDS dropping the socket,
// EADDRNOTAVAIL/ECONNRESET) is emitted on the pool; without a listener Node
// treats it as uncaught and crashes the process. Log and let the pool recycle.
pool.on('error', (err) => {
  console.error('[pg pool] idle client error (recovered):', err.message);
});

/** Tagged-template-free helper: query(text, params) */
export const query = (text, params) => pool.query(text, params);
