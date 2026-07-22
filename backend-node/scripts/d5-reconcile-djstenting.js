// D5: reconcile his "45 found" vs our "26 found" for DJ-stenting cash cases.
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// our package-bill history views (what the flow shows as "cases")
const a = await c.query(`
  SELECT package_code, package_name, admission_count
  FROM fc.v_package_case_history
  WHERE upper(package_name) LIKE '%DJ STENTING%' AND tariff_code = 'TR1'
  ORDER BY admission_count DESC LIMIT 8`);
console.log('v_package_case_history (TR1):', JSON.stringify(a.rows));

const b = await c.query(`
  SELECT count(DISTINCT ip_no)::int AS ips
  FROM fc.package_bill_admissions
  WHERE payer_type = 'PRIVATE'
    AND (upper(surgery_name) LIKE '%DJ STENTING%' OR upper(package_name) LIKE '%DJ STENTING%')`);
console.log('package_bill_admissions PRIVATE w/ DJ STENTING:', JSON.stringify(b.rows[0]));

const b2 = await c.query(`
  SELECT count(DISTINCT ip_no)::int AS ips
  FROM fc.package_bill_admissions
  WHERE payer_type = 'PRIVATE' AND upper(COALESCE(surgery_name,'') || COALESCE(package_name,'')) LIKE '%DJ STENTING%'
    AND upper(COALESCE(surgery_name,'')) NOT LIKE '%,%'`);
console.log('  …single-procedure only:', JSON.stringify(b2.rows[0]));

// name split — what "26" could be
const d = await c.query(`
  SELECT upper(COALESCE(NULLIF(surgery_name,''), package_name)) AS nm, count(DISTINCT ip_no)::int AS ips
  FROM fc.package_bill_admissions
  WHERE payer_type='PRIVATE' AND upper(COALESCE(surgery_name,'') || COALESCE(package_name,'')) LIKE '%DJ STENTING%'
  GROUP BY 1 ORDER BY ips DESC LIMIT 10`);
console.log('by name:', JSON.stringify(d.rows));
await c.end();
