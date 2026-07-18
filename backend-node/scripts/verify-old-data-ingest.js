// After-state verification for the Dec-24→Apr-25 ingest.
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const a = await c.query(`SELECT count(*)::int AS n, min(date_of_admission)::date AS min_adm, max(date_of_admission)::date AS max_adm FROM fc.package_bill_admissions`);
console.log('admissions:', JSON.stringify(a.rows[0]), '(was n=12648, min 2025-01)');
const l = await c.query(`SELECT count(*)::int AS lines, count(DISTINCT ip_no)::int AS ips FROM fc.package_bill_lines`);
console.log('lines:', JSON.stringify(l.rows[0]), '(was lines≈514599, ips=3696)');
const u = await c.query(`SELECT package_code, admission_count FROM fc.v_package_case_history WHERE package_code IN ('URO5011','URO5443') AND tariff_code='TR1'`);
console.log('URO case history:', JSON.stringify(u.rows), '(URO5011 was 30)');
const t = await c.query(`
  SELECT count(DISTINCT ip_no)::int AS tkr_left FROM fc.package_bill_admissions
  WHERE upper(COALESCE(package_name,'')) LIKE '%TOTAL KNEE REPLACEMENT%LEFT%'`);
console.log('TKR-left billed admissions now:', JSON.stringify(t.rows[0]));
await c.end();
