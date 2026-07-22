// F2 validity check: does OUR mart already classify GIPSA per the manager's
// rule (insurance org whose tariff is TR290 ⇒ GIPSA, else non-GIPSA)?
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const a = await c.query(`SELECT payor_bucket, count(*)::int AS n FROM mart.main_table GROUP BY 1 ORDER BY n DESC`);
console.log('buckets:', JSON.stringify(a.rows));
const b = await c.query(`
  SELECT payor_bucket, tariff_code, count(*)::int AS n
  FROM mart.main_table
  WHERE payor_bucket IN ('GIPSA Insurance','Non-GIPSA Insurance')
  GROUP BY 1, 2 ORDER BY 1, n DESC LIMIT 14`);
console.log('insurance buckets by tariff:', JSON.stringify(b.rows));
const cx = await c.query(`
  SELECT count(*) FILTER (WHERE payor_bucket = 'GIPSA Insurance' AND tariff_code IS DISTINCT FROM 'TR290')::int AS gipsa_not_tr290,
         count(*) FILTER (WHERE payor_bucket = 'Non-GIPSA Insurance' AND tariff_code = 'TR290')::int AS nongipsa_but_tr290
  FROM mart.main_table`);
console.log('rule violations:', JSON.stringify(cx.rows[0]));
await c.end();
