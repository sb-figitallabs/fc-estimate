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

/** Tagged-template-free helper: query(text, params) */
export const query = (text, params) => pool.query(text, params);
