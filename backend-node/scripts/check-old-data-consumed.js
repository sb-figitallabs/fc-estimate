// Have we consumed the Dec-2024→Apr-2025 extracts?
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const a = await c.query(`
  SELECT min(date_of_admission)::date AS min_adm, max(date_of_admission)::date AS max_adm,
         count(*)::int AS n,
         count(*) FILTER (WHERE date_of_admission < '2025-05-01')::int AS before_may25
  FROM fc.package_bill_admissions WHERE date_of_admission IS NOT NULL`);
console.log('package_bill_admissions:', JSON.stringify(a.rows[0]));
const b = await c.query(`
  SELECT count(DISTINCT ip_no)::int AS ips,
         count(DISTINCT ip_no) FILTER (WHERE create_dt < '2025-05-01')::int AS ips_before_may25,
         min(create_dt)::date AS min_dt, max(create_dt)::date AS max_dt
  FROM fc.package_bill_lines`);
console.log('package_bill_lines:', JSON.stringify(b.rows[0]));
const m = await c.query(`
  SELECT min(date_of_admission)::date AS min_adm,
         count(*) FILTER (WHERE date_of_admission < '2025-05-01')::int AS mart_before_may25,
         count(*)::int AS mart_total
  FROM mart.main_table`);
console.log('mart:', JSON.stringify(m.rows[0]));
// sample IPs from the new files present anywhere?
const probe = await c.query(`
  SELECT
    (SELECT count(*)::int FROM fc.package_bill_admissions WHERE ip_no IN ('GIP2425006955','GIP2425006980')) AS pkgadm_hits,
    (SELECT count(DISTINCT ip_no)::int FROM fc.package_bill_lines WHERE ip_no = 'IPGB2425007508') AS line_hits,
    (SELECT count(*)::int FROM mart.main_table WHERE admission_no = 'IPGB2425007508') AS mart_hits`);
console.log('sample-IP probe:', JSON.stringify(probe.rows[0]));
await c.end();
