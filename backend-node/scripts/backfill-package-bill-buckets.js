// 16-Jul manager note ¶1: bucket-level Historic Metrics for package bills.
// Classifies every billed line of every single-package (non-combo) package
// bill into the estimate's buckets and persists per-admission-extras
// quartiles per (package_code, payor_group, bucket). Idempotent: applies the
// migration, then DELETE + reload in one transaction.
//
//   node scripts/backfill-package-bill-buckets.js
//
// Classification ladder per line (billed, non-F&B):
//   0. the package's own line (service_name == admission.package_name) → skipped (it IS the package)
//   1. pharmacy service groups → fc.pharmacy_item_mapping: Implants / Stents ⇒ Implants, else Pharmacy
//   2. fc.service_item_mapping by service_cd ⇒ its fc_estimate_bucket
//   3. group majority: the group's dominant mapped bucket (computed over ALL lines)
//   4. surgical-looking groups (SURG / PROCEDURE / CARDIO-THORACIC / OT) ⇒ Procedure / OT Charges
//   5. else ⇒ Other / Miscellaneous
import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool } from '../src/db/pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// payer_type + tariff → the engine's payor buckets. GIPSA = the 4 PSU
// insurers sharing TR290; every other insurance tariff is Non-GIPSA.
const PAYOR_GROUP_SQL = `
  CASE
    WHEN a.payer_type = 'PRIVATE' THEN 'Cash'
    WHEN a.payer_type = 'INSURANCE' AND upper(btrim(a.p_tariff_cd)) = 'TR290' THEN 'GIPSA Insurance'
    WHEN a.payer_type = 'INSURANCE' THEN 'Non-GIPSA Insurance'
    WHEN a.payer_type = 'CORPORATE' THEN 'Corporate'
    ELSE 'Other'
  END`;

// One admission+bucket = summed extras; classification ladder inline.
const CLASSIFIED_SQL = `
  WITH adm AS (
    SELECT a.ip_no, a.package_name, ${PAYOR_GROUP_SQL} AS payor_group,
           (SELECT pm2.package_code FROM fc.package_master pm2
             WHERE upper(btrim(pm2.package_name)) = upper(btrim(a.package_name))
             LIMIT 1) AS package_code
    FROM fc.package_bill_admissions a
    WHERE a.open_bill_or_pkg_bill = 'Package Bill'
      AND a.final_pkg_bill_excl_fnb IS NOT NULL
      AND a.package_name NOT LIKE '%,%'   -- combo bills would pollute single-package buckets (same rule as billed_actuals)
  ),
  group_majority AS (
    SELECT l.service_group_desc, mode() WITHIN GROUP (ORDER BY sm.fc_estimate_bucket) AS bucket
    FROM fc.package_bill_lines l
    JOIN fc.service_item_mapping sm ON sm.item_code = l.service_cd
    GROUP BY 1
  ),
  classified AS (
    SELECT adm.package_code, adm.payor_group, adm.ip_no,
      CASE
        WHEN l.service_group_desc ILIKE '%pharmacy%' THEN
          CASE WHEN pm.classification = 'Implants / Stents' THEN 'Implants' ELSE 'Pharmacy' END
        WHEN sm.fc_estimate_bucket IS NOT NULL THEN sm.fc_estimate_bucket
        WHEN gm.bucket IS NOT NULL THEN gm.bucket
        WHEN l.service_group_desc ~* '(SURG|PROCEDURE|CARDIO-THORACIC|OPERATION|CATH|OT )' THEN 'Procedure / OT Charges'
        ELSE 'Other / Miscellaneous'
      END AS bucket,
      l.billed_amount
    FROM fc.package_bill_lines l
    JOIN adm ON adm.ip_no = l.ip_no
    LEFT JOIN fc.service_item_mapping  sm ON sm.item_code = l.service_cd
    LEFT JOIN fc.pharmacy_item_mapping pm ON pm.item_code = l.service_cd
    LEFT JOIN group_majority gm ON gm.service_group_desc = l.service_group_desc
    WHERE COALESCE(l.is_fnb, false) = false
      AND COALESCE(l.billed_amount, 0) > 0
      AND adm.package_code IS NOT NULL
      AND upper(btrim(l.service_name)) <> upper(btrim(adm.package_name))  -- the package line itself is not an extra
  ),
  per_admission AS (
    SELECT package_code, payor_group, bucket, ip_no, SUM(billed_amount) AS extras
    FROM classified GROUP BY 1, 2, 3, 4
  ),
  cohort_sizes AS (
    SELECT package_code, payor_group, COUNT(*)::int AS admissions
    FROM adm WHERE package_code IS NOT NULL GROUP BY 1, 2
  )
  SELECT p.package_code, p.payor_group, p.bucket,
         c.admissions,
         COUNT(*)::int AS presence_cases,
         round(percentile_cont(0.25) WITHIN GROUP (ORDER BY p.extras)::numeric) AS p25,
         round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY p.extras)::numeric) AS p50,
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY p.extras)::numeric) AS p75,
         round(avg(p.extras)::numeric) AS avg_amount
  FROM per_admission p
  JOIN cohort_sizes c USING (package_code, payor_group)
  GROUP BY 1, 2, 3, c.admissions`;

// The All-Payers rollup: same shape, payor_group collapsed.
const ALL_PAYERS_SQL = CLASSIFIED_SQL
  .replaceAll(PAYOR_GROUP_SQL, `'All Payers'`);

async function main() {
  console.log('backfill-package-bill-buckets');
  const client = await pool.connect();
  try {
    const migration = readFileSync(path.join(HERE, '../migrations/002_package_bill_bucket_metrics.sql'), 'utf8');
    await client.query(migration);
    console.log('[migrate] applied 002_package_bill_bucket_metrics.sql (idempotent)');

    await client.query('BEGIN');
    await client.query('DELETE FROM fc.package_bill_bucket_metrics');
    const ins = (sel) => `
      INSERT INTO fc.package_bill_bucket_metrics
        (package_code, payor_group, bucket, admissions, presence_cases, p25, p50, p75, avg_amount)
      ${sel}`;
    const r1 = await client.query(ins(CLASSIFIED_SQL));
    const r2 = await client.query(ins(ALL_PAYERS_SQL));
    await client.query('COMMIT');
    console.log(`[load] ${r1.rowCount} per-payor rows + ${r2.rowCount} all-payers rows`);

    // ── report ──
    const { rows: head } = await client.query(`
      SELECT COUNT(DISTINCT package_code)::int codes, COUNT(*)::int rows FROM fc.package_bill_bucket_metrics`);
    console.log(`\n=========== PACKAGE-BILL BUCKET METRICS REPORT ===========`);
    console.log(`Packages covered: ${head[0].codes} codes, ${head[0].rows} (code × payor × bucket) rows`);

    const { rows: dropped } = await client.query(`
      SELECT COUNT(*)::int n FROM fc.package_bill_admissions a
      WHERE a.open_bill_or_pkg_bill = 'Package Bill' AND a.final_pkg_bill_excl_fnb IS NOT NULL
        AND a.package_name NOT LIKE '%,%'
        AND NOT EXISTS (SELECT 1 FROM fc.package_master pm2
                        WHERE upper(btrim(pm2.package_name)) = upper(btrim(a.package_name)))`);
    console.log(`Admissions dropped (name not in package master): ${dropped[0].n}`);

    const { rows: tkr } = await client.query(`
      SELECT payor_group, bucket, admissions, presence_cases, p25, p50, p75
      FROM fc.package_bill_bucket_metrics
      WHERE package_code IN (SELECT DISTINCT package_code FROM fc.package_master WHERE package_name ILIKE '%TOTAL KNEE REPLACEMENT%UNILATERAL%')
        AND payor_group IN ('GIPSA Insurance', 'Cash')
      ORDER BY payor_group, p50 DESC NULLS LAST`);
    console.log('\nTKR Unilateral sanity check (extras above package, per bucket):');
    console.log('payor | bucket | present/adm | p25 | p50 | p75');
    for (const r of tkr) console.log([r.payor_group, r.bucket, `${r.presence_cases}/${r.admissions}`, r.p25, r.p50, r.p75].join(' | '));
    console.log('===========================================================');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* not in tx */ }
    console.error('FATAL:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
