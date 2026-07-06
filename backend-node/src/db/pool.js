import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

/** Tagged-template-free helper: query(text, params) */
export const query = (text, params) => pool.query(text, params);
