import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT table_schema, table_name,
         (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
          FROM information_schema.columns cc
          WHERE cc.table_schema = t.table_schema AND cc.table_name = t.table_name) AS cols
  FROM information_schema.tables t
  WHERE table_schema IN ('fc','mart') AND table_type IN ('BASE TABLE','VIEW')
  ORDER BY 1, 2`);
for (const r of rows) console.log(`${r.table_schema}.${r.table_name}: ${r.cols?.slice(0, 300)}`);
await c.end();
