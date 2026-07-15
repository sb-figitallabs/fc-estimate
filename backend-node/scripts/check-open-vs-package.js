// #13 diagnosis: why does the open-billing band sit BELOW the package-actuals
// band (TKR GIPSA: open 2.0–2.93L vs package 2.61–3.85L)? And CAG's 16–24k vs
// 18k–1.23L. Hypotheses: (a) the mart cohort mixes package-billed admissions
// into the "open" band, (b) package actuals are gross incl. billed exclusions,
// (c) daycare/non-daycare mixing (CAG).
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const MONEY = 'fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin';
const q3 = (col) => `
  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY ${col})::numeric) p25,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${col})::numeric) p50,
  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ${col})::numeric) p75`;

// does mart know which admissions were package-billed? try the join key.
const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='mart' AND table_name='main_table'
    AND (column_name ILIKE '%pack%' OR column_name ILIKE '%ip%' OR column_name ILIKE '%bill%')`);
console.log('mart pack/ip/bill columns:', cols.rows.map((r) => r.column_name).join(', '));
const ipCol = cols.rows.map((r) => r.column_name).find((n) => /^ip|ip_no|ipno/i.test(n));

// 1. TKR unilateral GIPSA — cohort band, split open vs package-billed
console.log('\n— TKR unilateral / GIPSA Insurance —');
const tkrAll = await c.query(`
  SELECT count(*)::int n, ${q3(MONEY)}
  FROM mart.main_table
  WHERE curated_template_names_jsonb ? 'TOTAL KNEE REPLACEMENT (TKR) UNILATERAL - RIGHT - PA'
     OR curated_template_names_jsonb ? 'TOTAL KNEE REPLACEMENT (TKR) - LEFT-PA'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(curated_template_names_jsonb) t(x) WHERE x ILIKE '%KNEE REPLACEMENT%UNILATERAL%' OR x ILIKE '%(TKR) - LEFT%' OR x ILIKE '%(TKR)%RIGHT%')
    AND payor_bucket = 'GIPSA Insurance'`);
console.log('mart cohort (all rows, GIPSA):', JSON.stringify(tkrAll.rows[0]));

if (ipCol) {
  const split = await c.query(`
    SELECT (b.ip_no IS NOT NULL) AS package_billed, count(*)::int n, ${q3(`m.${MONEY}`)}
    FROM mart.main_table m
    LEFT JOIN fc.package_bill_admissions b ON upper(btrim(b.ip_no)) = upper(btrim(m.${ipCol}::text))
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.curated_template_names_jsonb) t(x) WHERE x ILIKE '%KNEE REPLACEMENT%UNILATERAL%' OR x ILIKE '%(TKR)%RIGHT%' OR x ILIKE '%(TKR) - LEFT%')
      AND m.payor_bucket = 'GIPSA Insurance'
    GROUP BY 1`);
  console.log('mart TKR GIPSA split by package-billed:');
  split.rows.forEach((r) => console.log('  package_billed:', r.package_billed, JSON.stringify(r)));
}

// 2. package actuals for TKR UNILATERAL on TR290 — final bill vs pkg amount
const pkg = await c.query(`
  SELECT count(*)::int n, ${q3('final_pkg_bill_excl_fnb')},
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pkg_gross_amount)::numeric) pkg_amount_p50,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY inc_amount)::numeric) inc_p50,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY defined_exc_amount)::numeric) exc_p50
  FROM fc.package_bill_admissions
  WHERE upper(btrim(p_tariff_cd)) = 'TR290' AND package_name ILIKE '%KNEE REPLACEMENT%UNILATERAL%'`);
console.log('\npackage actuals TR290 TKR UNILATERAL:', JSON.stringify(pkg.rows[0]));

// 3. CAG — daycare vs non-daycare split in the cohort
console.log('\n— CAG daycare mixing —');
const cag = await c.query(`
  SELECT is_daycare_broad, payor_bucket, count(*)::int n, ${q3(MONEY)}
  FROM mart.main_table
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(curated_template_names_jsonb) t(x) WHERE x ILIKE '%CORONARY ANGIOGRAM%' OR x ILIKE 'CAG%')
  GROUP BY 1, 2 ORDER BY 1, 3 DESC LIMIT 10`);
cag.rows.forEach((r) => console.log(' ', JSON.stringify(r)));

const cagPkg = await c.query(`
  SELECT count(*)::int n, ${q3('final_pkg_bill_excl_fnb')}
  FROM fc.package_bill_admissions
  WHERE package_name ILIKE '%CAG%' OR package_name ILIKE '%CORONARY ANGIOGRAM%'`);
console.log('CAG package actuals (all tariffs):', JSON.stringify(cagPkg.rows[0]));

await c.end();
