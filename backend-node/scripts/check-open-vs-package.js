// #13 diagnosis round 2: open-vs-package inversion, with mart's own
// has_package flag and discovered template names.
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const MONEY = 'fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin';
const q3 = (col) => `
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY ${col})::numeric) p25,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${col})::numeric) p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ${col})::numeric) p75`;

// discover the actual TKR template names
const tpl = await c.query(`
  SELECT t, count(*) n FROM mart.main_table, jsonb_array_elements_text(curated_template_names_jsonb) t
  WHERE t ILIKE '%KNEE%' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
console.log('KNEE templates:', tpl.rows.map((r) => `${r.t} (${r.n})`).join(' | '));

// TKR unilateral GIPSA: split by mart's has_package flag
const tkr = await c.query(`
  SELECT has_package, count(*)::int n, ${q3(MONEY)},
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY package_amount)::numeric) mart_pkg_amount_p50
  FROM mart.main_table
  WHERE payor_bucket = 'GIPSA Insurance'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(curated_template_names_jsonb) t
                WHERE t ILIKE '%KNEE REPLACEMENT%' AND t NOT ILIKE '%BILATERAL%')
  GROUP BY 1 ORDER BY 1`);
console.log('\nTKR-unilateral GIPSA mart split by has_package:');
tkr.rows.forEach((r) => console.log(' ', JSON.stringify(r)));

// same admissions' final package bills (joined by package_code presence)
const link = await c.query(`
  SELECT count(*)::int n, ${q3('b.final_pkg_bill_excl_fnb')},
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.${MONEY})::numeric) mart_total_p50
  FROM mart.main_table m
  JOIN fc.package_bill_admissions b ON upper(btrim(b.package_name)) = upper(btrim(m.package_name))
   AND upper(btrim(b.p_tariff_cd)) = 'TR290'
  WHERE m.payor_bucket = 'GIPSA Insurance' AND m.has_package
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.curated_template_names_jsonb) t
                WHERE t ILIKE '%KNEE REPLACEMENT%' AND t NOT ILIKE '%BILATERAL%')`);
console.log('linked (mart pkg TKR rows ~ package bills):', JSON.stringify(link.rows[0]));

// CAG: daycare vs not, package vs not
const cag = await c.query(`
  SELECT is_daycare_broad, has_package, count(*)::int n, ${q3(MONEY)}
  FROM mart.main_table
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(curated_template_names_jsonb) t
                WHERE t ILIKE '%CORONARY ANGIOGRAM%')
  GROUP BY 1, 2 ORDER BY 1, 2`);
console.log('\nCAG mart split daycare × has_package:');
cag.rows.forEach((r) => console.log(' ', JSON.stringify(r)));

// CAG billed package names — is the band being fed by CAG+combo names?
const cagNames = await c.query(`
  SELECT package_name, count(*)::int n,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p50
  FROM fc.package_bill_admissions
  WHERE package_name ILIKE '%CAG%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
console.log('\nCAG-named billed packages:');
cagNames.rows.forEach((r) => console.log(' ', r.n, 'x', r.package_name.slice(0, 60), 'p50', r.p50));

await c.end();
