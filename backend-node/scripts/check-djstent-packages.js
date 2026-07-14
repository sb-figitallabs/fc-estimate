// One-off audit round 2: DJ-stenting packages + actual package-bill payor split.
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const pm = await c.query(`
  SELECT tariff_code, package_code, package_name, package_amount
  FROM fc.package_master
  WHERE package_name ILIKE '%DJ%STENT%' OR package_code ILIKE 'URO544%'
  ORDER BY package_code, tariff_code LIMIT 30`);
console.log('fc.package_master DJ-stent rows (' + pm.rowCount + '):');
pm.rows.forEach((r) => console.log(' ', r.tariff_code, r.package_code, '|', r.package_name, '| Rs', r.package_amount));

const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='fc' AND table_name='package_bill_admissions' ORDER BY ordinal_position`);
console.log('\npackage_bill_admissions columns:', cols.rows.map((r) => r.column_name).join(', '));
const payorCol = cols.rows.map((r) => r.column_name).find((n) => /payor|payer|tariff/i.test(n));

const pb = await c.query(`
  SELECT ${payorCol} grp, count(*) n,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p50
  FROM fc.package_bill_admissions
  WHERE p_tariff_cd ILIKE '%DJ%STENT%' OR p_tariff_cd ILIKE '%URSL%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
console.log(`\npackage_bill_admissions DJ-stent/URSL split by ${payorCol}:`);
pb.rows.forEach((r) => console.log(' ', r.grp, '->', r.n, 'p50', r.p50));

const names = await c.query(`
  SELECT p_tariff_cd, count(*) n
  FROM fc.package_bill_admissions
  WHERE p_tariff_cd ILIKE '%DJ%STENT%' OR p_tariff_cd ILIKE '%URSL%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
console.log('\ntop billed package names (p_tariff_cd) DJ-stent/URSL:');
names.rows.forEach((r) => console.log(' ', r.n, 'x', r.p_tariff_cd));

const ursl = await c.query(`
  SELECT t.template, m.payor_bucket, count(*) n
  FROM mart.main_table m, jsonb_array_elements_text(m.curated_template_names_jsonb) t(template)
  WHERE t.template ILIKE '%URSL%'
  GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
console.log('\nmart templates matching URSL (by payor):');
ursl.rows.forEach((r) => console.log(' ', r.template, '|', r.payor_bucket, '->', r.n));

await c.end();
