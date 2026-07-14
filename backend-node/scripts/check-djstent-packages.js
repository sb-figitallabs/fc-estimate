// One-off audit: verify manager's 14-Jul claims about DJ stenting.
// 1) Does a cash DJ-stenting package exist in the master (with details)?
// 2) How many package-billed admissions are DJ-stenting-related, and their payor split?
// 3) Does 'URSL + DJ STENTING' exist as a curated display name, with what counts?
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const tabs = await c.query(`
  SELECT table_schema || '.' || table_name t FROM information_schema.tables
  WHERE table_schema IN ('fc','mart') ORDER BY 1`);
console.log('TABLES:', tabs.rows.map((r) => r.t).join(', '));

const pkgTables = tabs.rows.map((r) => r.t).filter((t) => /packag/i.test(t) && !/bill/.test(t));
for (const t of pkgTables) {
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
    t.split('.')
  );
  const nameCol = cols.rows.map((r) => r.column_name).find((cn) => /name/i.test(cn));
  if (!nameCol) continue;
  const r = await c.query(`SELECT * FROM ${t} WHERE ${nameCol}::text ILIKE '%DJ%STENT%' LIMIT 5`);
  console.log(`\n${t} rows matching DJ STENT (${r.rowCount}):`);
  r.rows.forEach((row) => console.log(' ', JSON.stringify(row).slice(0, 400)));
}

const pb = await c.query(`
  SELECT payor_bucket, count(*) n,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p50
  FROM fc.package_bill_admissions
  WHERE p_tariff_cd ILIKE '%DJ%STENT%' OR p_tariff_cd ILIKE '%URSL%'
  GROUP BY 1 ORDER BY 2 DESC`);
console.log('\npackage_bill_admissions where package name mentions DJ STENT / URSL:');
pb.rows.forEach((r) => console.log(' ', r.payor_bucket, '->', r.n, 'p50', r.p50));

const pbCols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='fc' AND table_name='package_bill_admissions'`);
console.log('\npackage_bill_admissions columns:', pbCols.rows.map((r) => r.column_name).join(', '));

const ursl = await c.query(`
  SELECT t.template, m.payor_bucket, count(*) n
  FROM mart.main_table m, jsonb_array_elements_text(m.curated_template_names_jsonb) t(template)
  WHERE t.template ILIKE '%URSL%'
  GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
console.log('\nmart templates matching URSL (by payor):');
ursl.rows.forEach((r) => console.log(' ', r.template, '|', r.payor_bucket, '->', r.n));

await c.end();
