import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT a.attname
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = 'fc.package_alias'::regclass AND i.indisprimary`);
console.log('PK columns:', rows.map((r) => r.attname).join(', '));
const s = await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='fc' AND table_name='package_alias' ORDER BY ordinal_position`);
console.log('columns:', s.rows.map((r) => r.column_name).join(', '));
await c.end();
