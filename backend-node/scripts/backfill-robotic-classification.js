/**
 * backfill-robotic-classification.js — todo-15jul #28 ("at a database level,
 * classify whether the surgery / the package has a robotic add-on or not —
 * and also do that at an IP patient level"), building on the #9 finding that
 * robotic classification must run PER PAYOR GROUP.
 *
 * Applies migrations/001_robotic_classification.sql (idempotent DDL), then
 * fully recomputes the four fc.robotic_* tables:
 *
 *   1. fc.robotic_tariff_addon_rate       — contracted robotic line items per
 *      tariff from fc.service_tariff_rate_matrix (e.g. TR290 'CHARGES FOR
 *      ROBOTIC TKR' ≈ ₹1,20,000), folded per ward group like the engine does.
 *   2. fc.robotic_admission_classification — one row per historical admission
 *      (mart.main_table ∪ fc.package_bill_admissions): was robotic actually
 *      billed, and for how much (mart services_json amounts + package-bill
 *      billed portion rate×ex_qty).
 *   3. fc.robotic_package_classification  — one row per fc.package_master
 *      (tariff_code, package_code): robotic package? contracted add-on in the
 *      tariff? historical robotic presence per payor group (by package_code —
 *      the CODE is package identity across tariffs).
 *   4. fc.robotic_family_classification   — one row per (cohort family ×
 *      payor group), presence computed through the ENGINE'S OWN code path
 *      (artifacts.js buildServiceStats → services.js roboticPresenceInfo) so
 *      the persisted rate always matches what a live estimate would show.
 *
 * Robotic detection everywhere = services.js isRoboticText semantics:
 * /ROBO/i over item code, item name, mapped grouping, mapped
 * fc_estimate_bucket — minus 'remove'-category rows (isRemoveCategory).
 *
 * Load semantics: each table is DELETE-and-reload inside its own transaction
 * (derived data, no stable incremental key) — safe to re-run any time as new
 * data lands. Read-only against every pre-existing table.
 *
 * Run:  node scripts/backfill-robotic-classification.js [--skip-families]
 *   --skip-families   refresh only the SQL-set-based layers (1–3); the family
 *                     layer rebuilds every cohort through the engine and is
 *                     the slow part (~170 families).
 *
 * The stdout of a run IS the report (headline counts, the per-payor TKR
 * table from todo #9, robotic-billed admission totals, contracted rates).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pool, query } from '../src/db/pool.js';
import { fetchCohortRows, basisCohorts, buildServiceStats } from '../src/modules/engine/artifacts.js';
import {
  roboticPresenceInfo, isRemoveCategory, TEMPLATE_EXCLUDED_SERVICE_CODES,
} from '../src/modules/engine/services.js';
import { listFamilies, getCohort, roboticBaseOf } from '../src/modules/engine/cohort.js';

const skipFamilies = process.argv.includes('--skip-families');

const MIGRATION = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..', 'migrations', '001_robotic_classification.sql'
);

/** Same signal the engine uses (services.js isRoboticText). */
const ROBO_RE = /ROBO/i;

/** Payor groups persisted at family level (mart payor_bucket values + overall). */
const PAYOR_GROUPS = ['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance', 'All Payers'];

const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
const inr = (n) => (n == null ? 'n/a' : '₹' + Math.round(Number(n)).toLocaleString('en-IN'));

/* ------------------------------------------------------------------ layer 0 */

async function applyMigration() {
  const ddl = fs.readFileSync(MIGRATION, 'utf8');
  await query(ddl);
  console.log(`[migrate] applied ${path.basename(MIGRATION)} (idempotent)`);
}

/**
 * Code lists that let the set-based SQL reproduce the mapping-aware part of
 * the engine signal without a per-line join:
 *  - roboByMapping: item codes whose mapped grouping/bucket says robotic
 *  - removeCodes:   item codes classified 'remove' (never a robotic signal)
 */
async function mappingCodeLists() {
  const { rows } = await query(
    `SELECT item_code, grouping, fc_estimate_bucket FROM fc.service_item_mapping`
  );
  const roboByMapping = [];
  const removeCodes = [];
  for (const r of rows) {
    if (isRemoveCategory(r.fc_estimate_bucket, r.grouping)) removeCodes.push(r.item_code);
    else if (ROBO_RE.test(r.grouping || '') || ROBO_RE.test(r.fc_estimate_bucket || '')) {
      roboByMapping.push(r.item_code);
    }
  }
  console.log(`[mapping] ${roboByMapping.length} robotic-mapped item codes, ${removeCodes.length} remove-category codes`);
  return { roboByMapping, removeCodes, mappingRows: rows };
}

/* ------------------------------------------------------- 1) tariff add-ons */

async function refreshTariffAddonRates() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fc.robotic_tariff_addon_rate');
    const { rowCount } = await client.query(`
      INSERT INTO fc.robotic_tariff_addon_rate
        (tariff_cd, service_cd, service_name,
         charge_general, charge_twin, charge_single, charge_icu, charge_other, charge_max, refreshed_at)
      SELECT tariff_cd, service_cd, min(service_name),
             max(charge) FILTER (WHERE upper(coalesce(ward_group_name,'')) LIKE '%GENERAL%'),
             max(charge) FILTER (WHERE upper(coalesce(ward_group_name,'')) LIKE '%TWIN%'),
             max(charge) FILTER (WHERE upper(coalesce(ward_group_name,'')) LIKE '%SINGLE%'),
             max(charge) FILTER (WHERE upper(coalesce(ward_group_name,'')) LIKE '%ICU%'
                                    OR upper(coalesce(ward_group_name,'')) LIKE '%ICCU%'),
             max(charge) FILTER (WHERE upper(coalesce(ward_group_name,'')) NOT LIKE '%GENERAL%'
                                   AND upper(coalesce(ward_group_name,'')) NOT LIKE '%TWIN%'
                                   AND upper(coalesce(ward_group_name,'')) NOT LIKE '%SINGLE%'
                                   AND upper(coalesce(ward_group_name,'')) NOT LIKE '%ICU%'
                                   AND upper(coalesce(ward_group_name,'')) NOT LIKE '%ICCU%'),
             max(charge),
             now()
      FROM fc.service_tariff_rate_matrix
      WHERE service_cd ~* 'ROBO' OR service_name ~* 'ROBO'
      GROUP BY tariff_cd, service_cd`);
    await client.query('COMMIT');
    console.log(`[addon-rates] ${rowCount} contracted robotic (tariff, item) rows`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* --------------------------------------------------- 2) admission level ---- */

async function refreshAdmissionClassification({ roboByMapping, removeCodes }) {
  const { rows: reg } = await query(`SELECT to_regclass('fc.package_bill_admissions') IS NOT NULL AS a,
                                            to_regclass('fc.package_bill_lines') IS NOT NULL AS l`);
  const hasBills = reg[0].a && reg[0].l;
  if (!hasBills) console.warn('[admissions] fc.package_bill_* not found — classifying from mart only');

  // Robotic-signal predicate on a service line, matching services.js
  // isRoboticText + isRemoveCategory: code/name regex OR mapping-flagged code,
  // and never a remove-category code.
  const lineSignal = (codeExpr, nameExpr) => `
        (${codeExpr} ~* 'ROBO' OR ${nameExpr} ~* 'ROBO' OR ${codeExpr} = ANY($1::text[]))
    AND NOT (${codeExpr} = ANY($2::text[]))`;

  const billCtes = hasBills ? `
    bill_rob AS (
      SELECT l.ip_no,
             count(*)::int             AS n,
             sum(l.billed_amount)      AS billed,
             sum(l.amount)             AS consumed,
             jsonb_agg(jsonb_build_object('code', l.service_cd, 'name', l.service_name,
                                          'billed', l.billed_amount, 'amount', l.amount)) AS ex
      FROM fc.package_bill_lines l
      WHERE ${lineSignal('l.service_cd', 'l.service_name')}
      GROUP BY l.ip_no
    ),
    bills AS (
      SELECT ip_no, payer_type, p_tariff_cd, organization_name, package_name
      FROM fc.package_bill_admissions
    ),` : `
    bill_rob AS (SELECT NULL::text ip_no, 0::int n, NULL::numeric billed, NULL::numeric consumed, NULL::jsonb ex WHERE false),
    bills    AS (SELECT NULL::text ip_no, NULL::text payer_type, NULL::text p_tariff_cd,
                        NULL::text organization_name, NULL::text package_name WHERE false),`;

  const sql = `
    WITH mart_rows AS (
      SELECT DISTINCT ON (admission_no)
             admission_no, payor_bucket, organization_name, package_code, package_name, services_json
      FROM mart.main_table
      ORDER BY admission_no
    ),
    mart_rob AS (
      SELECT m.admission_no AS ip_no,
             count(*)::int AS n,
             sum(nullif(s->>'amount','')::numeric) AS amt,
             jsonb_agg(jsonb_build_object('code', s->>'service_code', 'name', s->>'service_name',
                                          'amount', nullif(s->>'amount','')::numeric)) AS ex
      FROM mart_rows m
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.services_json::jsonb, '[]'::jsonb)) s
      WHERE ${lineSignal(`(s->>'service_code')`, `(s->>'service_name')`)}
      GROUP BY m.admission_no
    ),
    ${billCtes}
    base AS (
      SELECT coalesce(m.admission_no, b.ip_no) AS ip_no,
             (m.admission_no IS NOT NULL)      AS in_mart,
             (b.ip_no IS NOT NULL)             AS in_bills,
             m.payor_bucket, b.payer_type, b.p_tariff_cd,
             coalesce(m.organization_name, b.organization_name) AS organization_name,
             m.package_code,
             coalesce(m.package_name, b.package_name) AS package_name
      FROM mart_rows m
      FULL OUTER JOIN bills b ON b.ip_no = m.admission_no
    )
    INSERT INTO fc.robotic_admission_classification
      (ip_no, in_mart, in_package_bills, payor_bucket, payer_type, p_tariff_cd,
       organization_name, package_code, package_name, robotic_billed,
       mart_robotic_line_count, mart_robotic_amount,
       bill_robotic_line_count, bill_robotic_billed_amount, bill_robotic_consumed_amount,
       robotic_amount, robotic_examples, refreshed_at)
    SELECT b.ip_no, b.in_mart, b.in_bills, b.payor_bucket, b.payer_type, b.p_tariff_cd,
           b.organization_name, b.package_code, b.package_name,
           (coalesce(mr.n, 0) + coalesce(br.n, 0)) > 0,
           coalesce(mr.n, 0), mr.amt,
           coalesce(br.n, 0), br.billed, br.consumed,
           coalesce(br.billed, mr.amt),
           coalesce(br.ex, mr.ex),
           now()
    FROM base b
    LEFT JOIN mart_rob mr ON mr.ip_no = b.ip_no
    LEFT JOIN bill_rob br ON br.ip_no = b.ip_no`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fc.robotic_admission_classification');
    const { rowCount } = await client.query(sql, [roboByMapping, removeCodes]);
    await client.query('COMMIT');
    console.log(`[admissions] classified ${rowCount} admissions`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ----------------------------------------------------- 3) package level ---- */

async function refreshPackageClassification() {
  const sql = `
    WITH pkgs AS (
      SELECT tariff_code, package_code,
             min(package_name) AS package_name,
             bool_or(coalesce(package_name,'') ~* 'ROBO' OR coalesce(package_code,'') ~* 'ROBO') AS is_rob
      FROM fc.package_master
      GROUP BY tariff_code, package_code
    ),
    -- historical robotic billing per package CODE (code = package identity
    -- across tariffs, per the manager's own rule) from mart-linked admissions
    hist AS (
      SELECT package_code,
             count(*)::int AS total,
             count(*) FILTER (WHERE payor_bucket = 'Cash')::int                AS cash,
             count(*) FILTER (WHERE payor_bucket = 'GIPSA Insurance')::int     AS gipsa,
             count(*) FILTER (WHERE payor_bucket = 'Non-GIPSA Insurance')::int AS nongipsa,
             count(*) FILTER (WHERE robotic_billed)::int                       AS rob_total,
             count(*) FILTER (WHERE robotic_billed AND payor_bucket = 'Cash')::int                AS rob_cash,
             count(*) FILTER (WHERE robotic_billed AND payor_bucket = 'GIPSA Insurance')::int     AS rob_gipsa,
             count(*) FILTER (WHERE robotic_billed AND payor_bucket = 'Non-GIPSA Insurance')::int AS rob_nongipsa
      FROM fc.robotic_admission_classification
      WHERE in_mart AND package_code IS NOT NULL
      GROUP BY package_code
    )
    INSERT INTO fc.robotic_package_classification
      (tariff_code, package_code, package_name, is_robotic_package,
       robotic_addon_available, robotic_addon_item_code, robotic_addon_item_name,
       robotic_addon_rate, robotic_addon_match,
       hist_cases_total, hist_cases_cash, hist_cases_gipsa, hist_cases_nongipsa,
       robotic_cases_total, robotic_cases_cash, robotic_cases_gipsa, robotic_cases_nongipsa,
       robotic_presence_overall, robotic_presence_cash, robotic_presence_gipsa, robotic_presence_nongipsa,
       robotic_capable, refreshed_at)
    SELECT p.tariff_code, p.package_code, p.package_name, p.is_rob,
           a.service_cd IS NOT NULL,
           a.service_cd, a.service_name, a.charge_max,
           CASE WHEN a.service_cd IS NULL THEN NULL
                WHEN a.name_token THEN 'name_token' ELSE 'tariff_generic' END,
           h.total, h.cash, h.gipsa, h.nongipsa,
           h.rob_total, h.rob_cash, h.rob_gipsa, h.rob_nongipsa,
           round(100.0 * h.rob_total    / nullif(h.total, 0),    1),
           round(100.0 * h.rob_cash     / nullif(h.cash, 0),     1),
           round(100.0 * h.rob_gipsa    / nullif(h.gipsa, 0),    1),
           round(100.0 * h.rob_nongipsa / nullif(h.nongipsa, 0), 1),
           (p.is_rob OR a.service_cd IS NOT NULL OR coalesce(h.rob_total, 0) > 0),
           now()
    FROM pkgs p
    LEFT JOIN hist h USING (package_code)
    LEFT JOIN LATERAL (
      -- pick the tariff's contracted robotic item for THIS package: prefer an
      -- item sharing a meaningful word with the package name (e.g. TKR), then
      -- the highest contracted rate.
      SELECT r.service_cd, r.service_name, r.charge_max,
             EXISTS (
               SELECT 1
               FROM regexp_split_to_table(upper(coalesce(r.service_name,'')), '[^A-Z0-9]+') t
               WHERE length(t) >= 3
                 AND t NOT IN ('ROBOTIC','ROBOT','ROBO','CHARGES','CHARGE','FOR','THE','AND','WITH','ASSISTED','SURGERY')
                 AND upper(coalesce(p.package_name,'')) LIKE '%' || t || '%'
             ) AS name_token
      FROM fc.robotic_tariff_addon_rate r
      WHERE r.tariff_cd = p.tariff_code
      ORDER BY 4 DESC, r.charge_max DESC NULLS LAST
      LIMIT 1
    ) a ON true`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fc.robotic_package_classification');
    const { rowCount } = await client.query(sql);
    await client.query('COMMIT');
    console.log(`[packages] classified ${rowCount} (tariff, package_code) rows`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------ 4) family level ---- */

/**
 * The winning robotic-signal stats row — same walk as services.js
 * roboticPresenceInfo (which returns only rate + counts), kept in lockstep so
 * we can persist WHICH item carried the signal. The rate itself always comes
 * from roboticPresenceInfo for engine parity.
 */
function roboticSignalRow(statsRows, procedureCode) {
  let best = null;
  for (const r of statsRows) {
    if (isRemoveCategory(r.fc_estimate_bucket, r.grouping)) continue;
    const robotic = ROBO_RE.test(r.item_code || '') || ROBO_RE.test(r.item_name || '') ||
      ROBO_RE.test(r.grouping || '') || ROBO_RE.test(r.fc_estimate_bucket || '');
    if (!robotic) continue;
    if (r.item_code !== procedureCode && TEMPLATE_EXCLUDED_SERVICE_CODES.has(r.item_code)) continue;
    if (!best || (r.case_presence_rate ?? 0) > (best.case_presence_rate ?? 0)) best = r;
  }
  return best;
}

/**
 * Engine-parity per-family presence: fetch the family cohort exactly like a
 * build does (fetchCohortRows), split into payor bases (basisCohorts), run the
 * engine's own stats + roboticPresenceInfo. Also counts admissions with ANY
 * robotic-signal line (the broader admission-level view) via the same signal.
 */
async function refreshFamilyClassification({ mappingRows }) {
  const mapping = new Map(mappingRows.map((r) => [r.item_code, r]));
  const lineIsRobotic = (code, name) => {
    const m = mapping.get(code);
    if (m && isRemoveCategory(m.fc_estimate_bucket, m.grouping)) return false;
    return ROBO_RE.test(code || '') || ROBO_RE.test(name || '') ||
      (m != null && (ROBO_RE.test(m.grouping || '') || ROBO_RE.test(m.fc_estimate_bucket || '')));
  };

  const families = listFamilies();
  console.log(`[families] computing engine-parity presence for ${families.length} families × ${PAYOR_GROUPS.length} payor groups…`);

  const rows = [];
  let done = 0, failed = 0;
  for (const f of families) {
    try {
      const def = await getCohort(f.family);
      const cohortRows = await fetchCohortRows(def.whereSql, def.params);
      const cohorts = basisCohorts(cohortRows);
      const stats = await buildServiceStats(cohorts);
      const procedureCode = def.procedure?.code ?? null;
      const isRoboticFamily =
        roboticBaseOf(f.family) != null ||
        ROBO_RE.test(f.label || '') ||
        ROBO_RE.test(def.procedure?.label || '');

      for (const group of PAYOR_GROUPS) {
        const basisRows = cohorts[group] ?? [];
        const basisStats = stats.filter((s) => s.basis_label === group);
        const info = roboticPresenceInfo(basisStats, procedureCode);
        const best = roboticSignalRow(basisStats, procedureCode);
        const admRobotic = basisRows.filter((r) =>
          (Array.isArray(r.services_json) ? r.services_json : [])
            .some((s) => lineIsRobotic(s.service_code, s.service_name))
        ).length;
        rows.push([
          f.family, group, f.label, f.family_kind,
          isRoboticFamily, roboticBaseOf(f.family),
          basisRows.length,
          info.rate ?? 0,
          info.case_count,
          best?.item_code ?? null,
          best?.item_name ?? null,
          admRobotic,
          pct(admRobotic, basisRows.length),
          (info.rate ?? 0) > 0 || admRobotic > 0,
          (info.rate ?? 0) > 90,
        ]);
      }
    } catch (e) {
      failed++;
      console.warn(`[families] ${f.family} FAILED: ${e.message}`);
    }
    done++;
    if (done % 20 === 0) console.log(`  …${done}/${families.length}`);
  }

  const cols = [
    'family', 'payor_group', 'family_label', 'family_kind',
    'is_robotic_family', 'base_family', 'cohort_cases',
    'robotic_presence_rate', 'robotic_signal_cases',
    'robotic_signal_item_code', 'robotic_signal_item_name',
    'robotic_admission_cases', 'robotic_admission_rate',
    'robotic_capable', 'robotic_default_included',
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fc.robotic_family_classification');
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const values = chunk
        .map((_, ri) => '(' + cols.map((__, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ', now())')
        .join(',');
      const params = [];
      for (const r of chunk) params.push(...r);
      await client.query(
        `INSERT INTO fc.robotic_family_classification (${cols.join(',')}, refreshed_at) VALUES ${values}`,
        params
      );
    }
    await client.query('COMMIT');
    console.log(`[families] persisted ${rows.length} (family, payor_group) rows${failed ? `; ${failed} families failed` : ''}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ----------------------------------------------------------------- report */

async function report() {
  console.log('\n================ ROBOTIC CLASSIFICATION REPORT ================');

  const [fam, pkg, adm, addon] = await Promise.all([
    query(`SELECT count(*)::int n,
                  count(DISTINCT family) FILTER (WHERE robotic_capable)::int capable
           FROM fc.robotic_family_classification`),
    query(`SELECT count(*)::int n,
                  count(*) FILTER (WHERE robotic_capable)::int capable,
                  count(*) FILTER (WHERE is_robotic_package)::int robotic_named,
                  count(*) FILTER (WHERE robotic_addon_available)::int with_addon
           FROM fc.robotic_package_classification`),
    query(`SELECT count(*)::int n,
                  count(*) FILTER (WHERE robotic_billed)::int billed,
                  count(*) FILTER (WHERE robotic_billed AND in_mart)::int billed_mart,
                  count(*) FILTER (WHERE robotic_billed AND in_package_bills)::int billed_bills,
                  sum(robotic_amount) FILTER (WHERE robotic_billed) amt
           FROM fc.robotic_admission_classification`),
    query(`SELECT count(*)::int n, count(DISTINCT tariff_cd)::int tariffs FROM fc.robotic_tariff_addon_rate`),
  ]);
  const f = fam.rows[0], p = pkg.rows[0], a = adm.rows[0], t = addon.rows[0];
  console.log(`Families:   ${f.n} (family × payor_group) rows; ${f.capable} distinct families robotic-capable in ≥1 payor group`);
  console.log(`Packages:   ${p.n} (tariff, package_code) rows; ${p.capable} robotic-capable (${p.robotic_named} robotic-named, ${p.with_addon} with a contracted add-on in their tariff)`);
  console.log(`Admissions: ${a.n} classified; ${a.billed} billed robotic (${a.billed_mart} via mart service rows, ${a.billed_bills} via package-bill lines); robotic amount ${inr(a.amt)}`);
  console.log(`Add-ons:    ${t.n} contracted robotic (tariff, item) rows across ${t.tariffs} tariffs`);

  // The todo #9 parity table — per-payor presence for the TKR families.
  const { rows: tkr } = await query(`
    SELECT family, family_label,
           max(robotic_presence_rate) FILTER (WHERE payor_group = 'Cash')                cash,
           max(robotic_presence_rate) FILTER (WHERE payor_group = 'GIPSA Insurance')     gipsa,
           max(robotic_presence_rate) FILTER (WHERE payor_group = 'Non-GIPSA Insurance') nongipsa
    FROM fc.robotic_family_classification
    WHERE family ~* 'tkr|knee|hip|hemiarthro'
    GROUP BY 1, 2 ORDER BY 3 DESC NULLS LAST`);
  console.log('\nTKR/THR per-payor presence (todo #9 parity check):');
  console.log('family | cash% | gipsa% | nongipsa%');
  const fmt = (v) => (v == null ? '-' : `${Math.round(Number(v))}%`);
  for (const r of tkr) console.log(`${(r.family_label || r.family).slice(0, 55)} | ${fmt(r.cash)} | ${fmt(r.gipsa)} | ${fmt(r.nongipsa)}`);

  const { rows: rates } = await query(`
    SELECT tariff_cd, service_cd, service_name, charge_max
    FROM fc.robotic_tariff_addon_rate ORDER BY charge_max DESC NULLS LAST LIMIT 12`);
  console.log('\nTop contracted robotic items (tariff | item | rate):');
  for (const r of rates) console.log(`${r.tariff_cd} | [${r.service_cd}] ${r.service_name} | ${inr(r.charge_max)}`);

  console.log('===============================================================\n');
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`backfill-robotic-classification${skipFamilies ? ' (--skip-families)' : ''}`);
  await applyMigration();
  const lists = await mappingCodeLists();
  await refreshTariffAddonRates();
  await refreshAdmissionClassification(lists);
  await refreshPackageClassification();
  if (!skipFamilies) await refreshFamilyClassification(lists);
  await report();
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('FATAL:', e);
    pool.end().finally(() => process.exit(1));
  });
