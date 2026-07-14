/**
 * report-package-diff.js — compare OUR package master's amounts against what
 * billing ACTUALLY charged, using the freshly-loaded actuals from
 * scripts/load-package-bills.js (manager task #3, 14-Jul).
 *
 * Sides of the comparison:
 *   MASTER  — fc.package_master, keyed (tariff_code, package_code), scalar
 *             package_amount + per-room tiers in fc.package_room_rates
 *             (the same rows the runtime view folds into room_rates_jsonb).
 *   ACTUALS — fc.package_bill_admissions (pkg_detl export), one row per
 *             admission: p_tariff_cd, package_name, declared pkg_amount and
 *             the reconstructed final bill excluding F&B
 *             (final_pkg_bill_excl_fnb = Σ rate×ex_qty minus F&B lines).
 *
 * Join: actuals rows with open_bill_or_pkg_bill = 'Package Bill', matched by
 *   upper(btrim(p_tariff_cd)) = upper(btrim(master.tariff_code))
 *   AND upper(btrim(package_name)) = upper(btrim(master.package_name))
 * There is no package_code in the actuals export, so the name join is the
 * best available key; its match rate is itself a data-quality signal and is
 * reported first. Where several master package_codes share one name, the
 * MEDIAN priced package_amount is used and the row is flagged '*'.
 *
 * Report (stdout IS the report — run via the maintenance workflow and read
 * the workflow log):
 *   1. Join match rate + top unmatched package names.
 *   2. Per (tariff_code, package_name): n admissions, master amount (+ room
 *      tier range), median declared pkg_amount, final-bill P25/P50/P75, and
 *      DIFF = median(actual pkg_amount) − master amount (₹ and %).
 *      Sorted by |%diff| desc, top --limit rows (default 40), plus buckets:
 *      within ±5%, ±5–15%, >15%, master-missing.
 *   3. Aggregate by tariff_code: admission-level median %diff — shows which
 *      insurer's master is stale (e.g. a consistent ≈ −10% echoes the Excel
 *      audit's GIPSA ×0.90 finding).
 *
 * READ-ONLY: SELECTs only — no DDL, no DML.
 *
 * How to run (maintenance runner, repo root):
 *   gh workflow run maintenance.yml --ref dev -f script=report-package-diff.js
 * Locally:
 *   node scripts/report-package-diff.js [--limit N]
 *
 * Flags:
 *   --limit N   cap printed rows in the per-package diff table (default 40).
 */
import 'dotenv/config';
import { pool, query } from '../src/db/pool.js';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : 40;
if (!Number.isInteger(limit) || limit <= 0) {
  console.error('--limit expects a positive integer');
  process.exit(1);
}

/* ------------------------------------------------------------------ utils */

const num = (v) => (v == null ? null : Number(v));
const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const inr = (n) => (n == null ? '—' : '₹' + Math.round(Number(n)).toLocaleString('en-IN'));
const inrSigned = (n) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + inr(Math.abs(n)));
const signedPct = (p) => (p == null ? '—' : (p > 0 ? '+' : '') + p.toFixed(1) + '%');
const trunc = (s, w) => {
  const t = String(s ?? '');
  return t.length <= w ? t : t.slice(0, w - 1) + '…';
};
const pad = (s, w) => String(s ?? '').padEnd(w);
const rpad = (s, w) => String(s ?? '').padStart(w);

/* ------------------------------------------------------------------- SQL */

/**
 * Shared master aggregation: one row per (tariff_code, package_name-key).
 * Multiple package_codes can share a name — count them and take the MEDIAN
 * priced amount (percentile ordered-set aggs ignore NULLs; zero/negative
 * amounts are excluded via FILTER as "unpriced").
 */
const MASTER_CTE = `
  master_named AS (
    SELECT upper(btrim(tariff_code))  AS tariff_code,
           upper(btrim(package_name)) AS pkg_key,
           count(*)::int AS n_master_codes,
           count(*) FILTER (WHERE package_amount > 0)::int AS n_priced_codes,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY package_amount)
             FILTER (WHERE package_amount > 0) AS master_amount,
           min(package_amount) FILTER (WHERE package_amount > 0) AS master_min,
           max(package_amount) FILTER (WHERE package_amount > 0) AS master_max
    FROM fc.package_master
    WHERE package_name IS NOT NULL AND btrim(package_name) <> ''
    GROUP BY 1, 2
  )`;

/** Per (tariff, package-name): actuals stats LEFT JOIN master + room range. */
const PER_PACKAGE_SQL = `
WITH actuals AS (
    SELECT upper(btrim(p_tariff_cd))  AS tariff_code,
           upper(btrim(package_name)) AS pkg_key,
           min(btrim(package_name))   AS package_name,
           count(*)::int AS n_adm,
           count(*) FILTER (WHERE pkg_amount > 0)::int AS n_declared,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY pkg_amount)
             FILTER (WHERE pkg_amount > 0) AS med_pkg_amount,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb) AS p25_final,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb) AS p50_final,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb) AS p75_final
    FROM fc.package_bill_admissions
    WHERE open_bill_or_pkg_bill = 'Package Bill'
      AND package_name IS NOT NULL AND btrim(package_name) <> ''
    GROUP BY 1, 2
),
${MASTER_CTE},
rooms AS (
    SELECT upper(btrim(pm.tariff_code))  AS tariff_code,
           upper(btrim(pm.package_name)) AS pkg_key,
           min(r.amount) FILTER (WHERE r.amount > 0) AS room_min,
           max(r.amount) FILTER (WHERE r.amount > 0) AS room_max
    FROM fc.package_room_rates r
    JOIN fc.package_master pm
      ON pm.tariff_code = r.tariff_code AND pm.package_code = r.package_code
    GROUP BY 1, 2
)
SELECT a.tariff_code, a.pkg_key, a.package_name, a.n_adm, a.n_declared,
       a.med_pkg_amount, a.p25_final, a.p50_final, a.p75_final,
       m.n_master_codes, m.n_priced_codes, m.master_amount, m.master_min, m.master_max,
       rm.room_min, rm.room_max
FROM actuals a
LEFT JOIN master_named m ON m.tariff_code = a.tariff_code AND m.pkg_key = a.pkg_key
LEFT JOIN rooms rm        ON rm.tariff_code = a.tariff_code AND rm.pkg_key = a.pkg_key
ORDER BY a.n_adm DESC, a.tariff_code, a.pkg_key`;

/** Per tariff_code: admission-level median relative diff vs master. */
const PER_TARIFF_SQL = `
WITH ${MASTER_CTE},
adm AS (
    SELECT upper(btrim(p_tariff_cd))  AS tariff_code,
           upper(btrim(package_name)) AS pkg_key,
           pkg_amount
    FROM fc.package_bill_admissions
    WHERE open_bill_or_pkg_bill = 'Package Bill'
      AND package_name IS NOT NULL AND btrim(package_name) <> ''
),
names AS (
    SELECT tariff_cd, min(tariff_name) AS tariff_name
    FROM fc.organization_tariff_mapping GROUP BY 1
)
SELECT a.tariff_code,
       n.tariff_name,
       count(DISTINCT a.pkg_key)::int AS n_pkgs,
       count(*)::int AS n_adm,
       count(*) FILTER (WHERE m.master_amount > 0)::int AS n_adm_matched,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (a.pkg_amount - m.master_amount) / NULLIF(m.master_amount, 0))
         FILTER (WHERE m.master_amount > 0 AND a.pkg_amount > 0) AS med_rel_diff
FROM adm a
LEFT JOIN master_named m ON m.tariff_code = a.tariff_code AND m.pkg_key = a.pkg_key
LEFT JOIN names n        ON n.tariff_cd = a.tariff_code
GROUP BY 1, 2
ORDER BY n_adm DESC`;

const TOTALS_SQL = `
SELECT count(*)::int AS n_all,
       count(*) FILTER (WHERE open_bill_or_pkg_bill = 'Package Bill')::int AS n_pkg_bill,
       count(*) FILTER (WHERE open_bill_or_pkg_bill = 'Package Bill'
                          AND (package_name IS NULL OR btrim(package_name) = ''))::int AS n_pkg_bill_noname,
       min(date_of_admission)::date AS min_adm,
       max(date_of_admission)::date AS max_adm
FROM fc.package_bill_admissions`;

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`report-package-diff (top ${limit} rows) — read-only`);

  const totals = (await query(TOTALS_SQL)).rows[0];
  console.log(`\nActuals: ${totals.n_all} admissions in fc.package_bill_admissions ` +
    `(admissions ${totals.min_adm?.toISOString?.().slice(0, 10) ?? totals.min_adm} → ` +
    `${totals.max_adm?.toISOString?.().slice(0, 10) ?? totals.max_adm}); ` +
    `'Package Bill': ${totals.n_pkg_bill} (${pct(totals.n_pkg_bill, totals.n_all)})` +
    (totals.n_pkg_bill_noname ? `; ${totals.n_pkg_bill_noname} of them have a blank package_name (excluded)` : ''));

  const rows = (await query(PER_PACKAGE_SQL)).rows.map((r) => {
    const masterAmount = num(r.master_amount);
    const medDecl = num(r.med_pkg_amount);
    const matched = r.n_master_codes != null;               // name join hit
    const priced = matched && masterAmount != null && masterAmount > 0;
    const diff = priced && medDecl != null ? medDecl - masterAmount : null;
    const relPct = diff != null ? (100 * diff) / masterAmount : null;
    return { ...r, n_adm: num(r.n_adm), n_declared: num(r.n_declared), matched, priced, masterAmount, medDecl, diff, relPct };
  });

  /* ---------------- 1. join quality ---------------- */
  const nGroups = rows.length;
  const nAdm = rows.reduce((s, r) => s + r.n_adm, 0);
  const mGroups = rows.filter((r) => r.matched);
  const mAdm = mGroups.reduce((s, r) => s + r.n_adm, 0);
  const pGroups = rows.filter((r) => r.priced);
  const pAdm = pGroups.reduce((s, r) => s + r.n_adm, 0);
  console.log('\n================ 1. JOIN QUALITY (actuals → package master) ================');
  console.log(`Join key: (upper(trim(p_tariff_cd)), upper(trim(package_name))) — actuals carry no package_code.`);
  console.log(`Distinct (tariff, package_name) groups in actuals: ${nGroups} covering ${nAdm} admissions`);
  console.log(`  matched in fc.package_master:        ${mGroups.length}/${nGroups} groups (${pct(mGroups.length, nGroups)}); ${mAdm}/${nAdm} admissions (${pct(mAdm, nAdm)})`);
  console.log(`  matched AND master has an amount>0:  ${pGroups.length}/${nGroups} groups (${pct(pGroups.length, nGroups)}); ${pAdm}/${nAdm} admissions (${pct(pAdm, nAdm)})`);
  const ambiguous = mGroups.filter((r) => num(r.n_priced_codes) > 1 && num(r.master_min) !== num(r.master_max));
  if (ambiguous.length) {
    console.log(`  name-ambiguous groups (several package_codes, differing amounts — median used, flagged '*'): ${ambiguous.length}`);
  }
  const unmatched = rows.filter((r) => !r.matched).sort((a, b) => b.n_adm - a.n_adm);
  if (unmatched.length) {
    console.log(`\nTop unmatched package names (data-quality signal — name drift or missing master rows):`);
    unmatched.slice(0, 15).forEach((r, i) =>
      console.log(`  ${rpad(i + 1, 2)}. [${r.tariff_code ?? '??'}] ${trunc(r.package_name, 60)} — ${r.n_adm} adm`));
    if (unmatched.length > 15) console.log(`  … and ${unmatched.length - 15} more unmatched groups`);
  }

  /* ---------------- 2. per-package diff ---------------- */
  const diffed = rows.filter((r) => r.relPct != null).sort((a, b) => Math.abs(b.relPct) - Math.abs(a.relPct));
  console.log('\n================ 2. MASTER vs ACTUALS, per (tariff, package) ================');
  console.log(`DIFF = median(actuals declared pkg_amount) − master package_amount. Sorted by |%diff| desc.`);
  console.log(`Final bill = final_pkg_bill_excl_fnb (Σ billed lines minus F&B).\n`);
  const hdr =
    pad('TARIFF', 7) + pad('PACKAGE', 46) + rpad('N', 5) +
    rpad('MASTER', 12) + pad('  ROOM-TIERS', 22) + rpad('DECL-MED', 12) +
    rpad('DIFF', 12) + rpad('DIFF%', 9) + '  ' + pad('FINAL P25/P50/P75', 34);
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of diffed.slice(0, limit)) {
    const star = num(r.n_priced_codes) > 1 && num(r.master_min) !== num(r.master_max) ? '*' : '';
    const roomRange = r.room_min != null
      ? (num(r.room_min) === num(r.room_max) ? inr(r.room_min) : `${inr(r.room_min)}–${inr(r.room_max)}`)
      : '—';
    console.log(
      pad(r.tariff_code, 7) + pad(trunc(r.package_name, 44), 46) + rpad(r.n_adm, 5) +
      rpad(inr(r.masterAmount) + star, 12) + pad('  ' + roomRange, 22) + rpad(inr(r.medDecl), 12) +
      rpad(inrSigned(r.diff), 12) + rpad(signedPct(r.relPct), 9) +
      '  ' + pad(`${inr(r.p25_final)} / ${inr(r.p50_final)} / ${inr(r.p75_final)}`, 34));
  }
  if (diffed.length > limit) console.log(`… ${diffed.length - limit} more diffed groups not printed (raise --limit)`);

  const within5 = diffed.filter((r) => Math.abs(r.relPct) <= 5);
  const within15 = diffed.filter((r) => Math.abs(r.relPct) > 5 && Math.abs(r.relPct) <= 15);
  const beyond15 = diffed.filter((r) => Math.abs(r.relPct) > 15);
  const masterMissing = rows.filter((r) => !r.priced);
  const noDeclared = rows.filter((r) => r.priced && r.medDecl == null);
  const admOf = (a) => a.reduce((s, r) => s + r.n_adm, 0);
  console.log('\nAggregate (package groups; admissions in parentheses):');
  console.log(`  within ±5%:        ${within5.length} (${admOf(within5)} adm)`);
  console.log(`  ±5–15%:            ${within15.length} (${admOf(within15)} adm)`);
  console.log(`  beyond ±15%:       ${beyond15.length} (${admOf(beyond15)} adm)`);
  console.log(`  master missing/unpriced: ${masterMissing.length} (${admOf(masterMissing)} adm)`);
  if (noDeclared.length) console.log(`  master priced but no declared pkg_amount in actuals: ${noDeclared.length} (${admOf(noDeclared)} adm)`);

  /* ---------------- 3. per-tariff aggregate ---------------- */
  const tariffs = (await query(PER_TARIFF_SQL)).rows;
  console.log('\n================ 3. BY TARIFF (which insurer\'s master is stale?) ================');
  console.log(`med %diff = admission-level median of (declared pkg_amount − master amount) / master amount.\n`);
  const thdr = pad('TARIFF', 8) + pad('TARIFF NAME', 18) + rpad('PKGS', 6) + rpad('ADM', 7) +
    rpad('ADM-MATCHED', 13) + rpad('MED %DIFF', 11) + '  NOTE';
  console.log(thdr);
  console.log('-'.repeat(thdr.length));
  for (const t of tariffs) {
    const med = num(t.med_rel_diff);
    const medPct = med == null ? null : med * 100;
    let note = '';
    if (medPct != null && medPct <= -8 && medPct >= -12) note = '≈ master ×0.90 (cf. Excel audit GIPSA finding)';
    else if (medPct != null && Math.abs(medPct) <= 2) note = 'master in line with billing';
    else if (t.n_adm_matched === 0) note = 'no priced master coverage';
    console.log(
      pad(t.tariff_code ?? '(blank)', 8) + pad(trunc(t.tariff_name ?? '—', 16), 18) +
      rpad(t.n_pkgs, 6) + rpad(t.n_adm, 7) +
      rpad(`${t.n_adm_matched} (${pct(t.n_adm_matched, t.n_adm)})`, 13) +
      rpad(signedPct(medPct), 11) + '  ' + note);
  }
  console.log('\n=================================================');
  console.log('Report complete — read-only, nothing written.');
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('FATAL:', e);
    pool.end().finally(() => process.exit(1));
  });
