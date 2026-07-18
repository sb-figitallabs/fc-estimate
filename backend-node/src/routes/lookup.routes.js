import { Router } from 'express';
import { query } from '../db/pool.js';
import { geminiJson } from '../modules/ai/gemini.js';
import { listFamilies, getCohort, applyCareControls, familyPayorCounts } from '../modules/engine/cohort.js';
import { fetchCohortRows, basisCohorts, buildBasisSummary } from '../modules/engine/artifacts.js';
import { payorBucketCounts, resolveBasis, resolveComponentBases } from '../modules/resolve/payerBasis.js';
import { quartilesInclusive, round2 } from '../modules/engine/stats.js';
import { packageGate } from '../modules/packages/packageGate.js';
import { familyMatches, payorAwareFamilies, rankPackageCandidates, applyCatchAllGuard } from '../modules/resolve/familyResolve.js';
import { resolveTariff } from '../modules/resolve/payorTariff.js';
import { detectCombo } from '../modules/flow2/comboDetect.js';

const router = Router();

/**
 * GET /api/lookup/families — clinical families (drives the UI dropdown; daycare
 * ⇒ no room selection). Each family additionally carries `payor_counts`
 * ({ "Cash": n, "GIPSA Insurance": n, ... } — cached, see familyPayorCounts)
 * so the UI can hint per-payor history; purely informational, nothing is
 * filtered. Fail-open: on any counts failure the families are served without
 * payor_counts — this endpoint must never break.
 */
router.get('/families', async (_req, res) => {
  const families = listFamilies();
  try {
    const counts = await familyPayorCounts();
    if (counts) {
      return res.json(families.map((f) => (counts[f.family] ? { ...f, payor_counts: counts[f.family] } : f)));
    }
  } catch { /* fall through — serve without payor_counts */ }
  res.json(families);
});

/**
 * POST /api/lookup/resolve-treatment  body: { text }
 * Free-text treatment wording ("Spine L4 L5 surgery", "gallbladder removal")
 * → top procedure-family matches, AI-ranked against the family registry.
 * Returned family keys are validated against listFamilies() (AI suggests,
 * the registry decides — unknown keys are dropped).
 */
router.post('/resolve-treatment', async (req, res, next) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    const payorBucket = typeof req.body?.payor_bucket === 'string' ? req.body.payor_bucket.trim() : '';
    const organizationCd = typeof req.body?.organization_cd === 'string' && req.body.organization_cd.trim()
      ? req.body.organization_cd.trim() : undefined;

    // family matching + (when the payor's tariff is resolvable) the package
    // hint run concurrently — the gate brain drives BOTH, so the builder's
    // suggestions match the flow view's classification exactly.
    const familyP = familyMatches(text);
    const hintP = (async () => {
      if (!payorBucket) return null;
      const tariff = await resolveTariff({ payorBucket, organizationCd }).catch(() => null);
      if (!tariff?.tariff_cd) return null;
      const { candidates, ranking } = await rankPackageCandidates({ treatment: text, tariff_code: tariff.tariff_cd, organization_cd: organizationCd });
      const top = candidates[0];
      if (!top) return null;
      return {
        tariff_cd: tariff.tariff_cd,
        package_code: top.package_code,
        package_name: top.package_name,
        package_amount: top.package_amount,
        // F1: per-room prices + provenance so the hint never reads as a ₹10 scalar
        ...(top.room_amounts ? { room_amounts: top.room_amounts } : {}),
        ...(top.package_amount_source ? { package_amount_source: top.package_amount_source } : {}),
        ...(ranking?.method === 'ai' ? { confidence: ranking.confidence } : {}),
      };
    })().catch(() => null);

    // combo detection (16-Jul #8): ADDITIVE — the key is present only when the
    // wording carries ≥2 fragments that BOTH resolve to a family; single
    // treatments keep the exact pre-combo response. Fail-open: detection must
    // never break the resolver.
    const comboP = detectCombo({ text, payorBucket, organizationCd }).catch(() => null);

    const { matches: payorMatches, payor_note } = await payorAwareFamilies(await familyP, payorBucket);
    // P4 catch-all guard — ADDITIVE: when specific/unnamed wording matched
    // only a generic catch-all cohort, the top match gains needs_confirmation
    // (+ confidence capped to 'low') and the response mirrors the flag at the
    // top level so the Simple flow can show its generic-match warning.
    const matches = applyCatchAllGuard(payorMatches, text);
    const package_hint = await hintP;
    const combo = await comboP;
    res.json({
      text, matches,
      ...(matches[0]?.needs_confirmation ? { needs_confirmation: true } : {}),
      ...(payor_note ? { payor_note } : {}),
      ...(package_hint ? { package_hint } : {}),
      ...(combo ? { combo } : {}),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/lookup/package-gate  body: { treatment, payor_bucket, organization_cd? }
 * Intake classification chain (manager 14-Jul): payor → tariff → package in
 * master? → details usable? → FC history? → route. Every step is returned
 * with its status and evidence so the flow can be audited even when data is
 * missing — this endpoint explains, it never estimates.
 */
router.post('/package-gate', async (req, res, next) => {
  try {
    const treatment = typeof req.body?.treatment === 'string' ? req.body.treatment.trim() : '';
    const payorBucket = typeof req.body?.payor_bucket === 'string' ? req.body.payor_bucket.trim() : '';
    if (!treatment) return res.status(400).json({ error: 'treatment is required' });
    if (!payorBucket) return res.status(400).json({ error: 'payor_bucket is required' });
    const organizationCd = typeof req.body?.organization_cd === 'string' && req.body.organization_cd.trim()
      ? req.body.organization_cd.trim() : undefined;
    // B3: the FC's robotic answer re-biases the candidate ranking
    const robotic = req.body?.robotic === 'yes' || req.body?.robotic === 'no' ? req.body.robotic : undefined;
    res.json(await packageGate({ treatment, payorBucket, organizationCd, robotic }));
  } catch (err) { next(err); }
});

/**
 * POST /api/lookup/ask  body: { question, history?, context?, screenshot? }
 * Ask-AI over the engine's data: Gemini with a READ-ONLY SQL tool (single
 * SELECT statements inside READ ONLY transactions, 12s timeout, 50-row cap).
 * Answers questions the page context can't — package catalogs, past billed
 * cases, tariffs, cohort history. Never writes.
 */
router.post('/ask', async (req, res, next) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'question is required' });
    const { askData } = await import('../modules/ai/askData.js');
    res.json(await askData({
      question,
      history: Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [],
      context: req.body?.context,
      screenshot: req.body?.screenshot,
      images: Array.isArray(req.body?.images) ? req.body.images.slice(0, 6) : undefined,
    }));
  } catch (err) { next(err); }
});

/**
 * GET /api/lookup/stay-stats?procedure=&payor_bucket=
 * Lightweight cohort stay stats (LOS / ward / ICU day + OT hour quartiles) for the
 * resolved payer basis — lets the UI show the typical stay before a full build.
 */
router.get('/stay-stats', async (req, res, next) => {
  try {
    const procedure = String(req.query.procedure || '');
    const payorBucket = String(req.query.payor_bucket || 'Cash');
    const def = await getCohort(procedure); // throws 400 for unknown family
    const rows = await fetchCohortRows(def.whereSql, def.params);
    if (!rows.length) return res.json({ procedure, basis: null, case_count: 0 });
    const cohorts = basisCohorts(rows);
    const counts = await payorBucketCounts(def.whereSql, def.params);
    const { selected_basis: basis } = resolveBasis(payorBucket, counts, def.familyKind);
    const b = buildBasisSummary(cohorts).find((r) => r.basis_label === basis);
    res.json({
      procedure, basis, case_count: (cohorts[basis] ?? []).length,
      los: { p25: b?.los_p25, p50: b?.los_p50, p75: b?.los_p75 },
      ward: { p25: b?.ward_p25, p50: b?.ward_p50, p75: b?.ward_p75 },
      icu: { p25: b?.icu_p25, p50: b?.icu_p50, p75: b?.icu_p75 },
      ot: { p25: b?.ot_p25, p50: b?.ot_p50, p75: b?.ot_p75 },
      // cath-lab families only: typical billed cath-lab hours (parsed from the
      // cohort's cath-lab slot-family rows). 0s when the wording carries no
      // hour token — the UI treats a falsy p50 as "no typical available".
      ...(def.rows?.cathLab === true
        ? { cath: { p25: b?.cath_hours_p25, p50: b?.cath_hours_p50, p75: b?.cath_hours_p75 } }
        : {}),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/lookup/provenance?procedure=&payor_bucket=&care_type=&setting=
 * Read-only admin audit view: where an estimate's numbers come from — which
 * hospital package display names the cohort combines (and how many IPs each
 * contributes), the payor/care/daycare splits, and which payer basis
 * (Cash / GIPSA / Insurance All / All Payers …) each estimate component
 * resolved to for the requested payor bucket.
 */
router.get('/provenance', async (req, res, next) => {
  try {
    const procedure = String(req.query.procedure || '');
    const payorBucket = String(req.query.payor_bucket || 'Cash');
    const base = await getCohort(procedure); // throws 400 for unknown family

    // optional cohort narrowing — only the exact literals are applied;
    // anything else is ignored (applyCareControls validates the same way)
    const careType = ['Surgical', 'Medical'].includes(req.query.care_type) ? req.query.care_type : null;
    const setting = ['Daycare', 'Inpatient'].includes(req.query.setting) ? req.query.setting : null;
    const def = applyCareControls(base, { care_type: careType, setting });

    // def.whereSql is a trusted server-side literal from the family registry
    // (never user input) — interpolated the same way artifacts.js does.
    const [agg, pkgs, buckets, samples, counts] = await Promise.all([
      query(
        `SELECT count(*)::int AS total_cases,
                count(*) FILTER (WHERE surgical_medical = 'Surgical')::int AS surgical,
                count(*) FILTER (WHERE surgical_medical = 'Medical')::int AS medical,
                count(*) FILTER (WHERE is_daycare_broad IS TRUE)::int AS daycare,
                count(*) FILTER (WHERE is_daycare_broad IS NOT TRUE)::int AS inpatient
         FROM mart.main_table WHERE ${def.whereSql}`, def.params
      ),
      query(
        // package_code: the master code for each billed name (task #24 — code
        // is package identity); null for '(none)'/combo/unmapped names.
        `SELECT g.package_name, g.cases,
                (SELECT pm.package_code FROM fc.package_master pm
                  WHERE upper(btrim(pm.package_name)) = upper(btrim(g.package_name)) LIMIT 1) AS package_code
         FROM (
           SELECT COALESCE(NULLIF(package_name, ''), '(none)') AS package_name, count(*)::int AS cases
           FROM mart.main_table WHERE ${def.whereSql}
           GROUP BY 1 ORDER BY cases DESC, package_name LIMIT 20
         ) g ORDER BY g.cases DESC, g.package_name`, def.params
      ),
      query(
        `SELECT payor_bucket, count(*)::int AS cases
         FROM mart.main_table WHERE ${def.whereSql}
         GROUP BY 1 ORDER BY cases DESC`, def.params
      ),
      query(
        `SELECT admission_no FROM mart.main_table WHERE ${def.whereSql}
         ORDER BY admission_no DESC LIMIT 10`, def.params
      ),
      payorBucketCounts(def.whereSql, def.params),
    ]);

    const a = agg.rows[0];
    res.json({
      family: def.family,
      template_name: def.templateName,
      family_kind: def.familyKind,
      daycare: def.daycare === true,
      applied_controls: { care_type: careType, setting },
      cohort: {
        total_cases: a.total_cases,
        package_names: pkgs.rows,
        payor_buckets: buckets.rows,
        care_split: { surgical: a.surgical, medical: a.medical },
        daycare_split: { daycare: a.daycare, inpatient: a.inpatient },
        sample_admissions: samples.rows.map((r) => r.admission_no),
      },
      // service/pharmacy/PF resolve independently per doc 14 (currently the
      // same framework — all three keys emitted for forward-compat)
      bases: { ...resolveComponentBases(payorBucket, counts, def.familyKind), counts },
    });
  } catch (err) { next(err); }
});

// ——— Bucket-level audit (admin) ——————————————————————————————————————————
// Registry of auditable estimate buckets + drivers. `component` picks which
// resolved payer basis applies (doc 14: service / pharmacy / PF resolve
// independently; LOS/OT-hour drivers ride the SERVICE basis — resolveDrivers
// reads the service-basis summary row in buildEstimate). `valueOf` extracts
// the per-case value exactly the way artifacts.js buildBasisSummary /
// buildActualBasisMetrics compute the basis stats the estimate is priced on.
const bucketAmt = (r, key) => Number(r.buckets?.[key] ?? 0);
const stayOf = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);
const AUDIT_BUCKETS = [
  { key: 'pharmacy_total', label: 'Pharmacy (total)', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'pharmacy_total') },
  { key: 'ip_drugs', label: 'IP Drugs', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'ip_drugs') },
  { key: 'ip_consumables', label: 'IP Consumables', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'ip_consumables') },
  { key: 'ot_drugs', label: 'OT Drugs', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'ot_drugs') },
  { key: 'ot_consumables', label: 'OT Consumables', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'ot_consumables') },
  { key: 'implants', label: 'Implants', component: 'pharmacy', valueOf: (r) => bucketAmt(r, 'implants') },
  { key: 'professional_fees', label: 'Professional Fees', component: 'pf', valueOf: (r) => bucketAmt(r, 'professional_fees') },
  { key: 'investigations', label: 'Investigations', component: 'service', valueOf: (r) => bucketAmt(r, 'investigations') },
  { key: 'procedure_ot_charges', label: 'Procedure / OT Charges', component: 'service', valueOf: (r) => bucketAmt(r, 'procedure_ot_charges') },
  { key: 'room_charges', label: 'Room Charges', component: 'service', valueOf: (r) => bucketAmt(r, 'room_charges') },
  { key: 'bedside_services', label: 'Bedside Services', component: 'service', valueOf: (r) => bucketAmt(r, 'bedside_services') },
  // drivers — null OT hours are dropped by quartilesInclusive, matching buildBasisSummary;
  // LOS = normalized billable stay days (ceil-style), per the reviewed builder
  { key: 'ot_hours', label: 'OT hours (driver)', component: 'driver', unit: 'hours', valueOf: (r) => r.ot_hours },
  { key: 'los_days', label: 'Length of stay (driver)', component: 'driver', unit: 'days', valueOf: (r) => stayOf(r) },
];
const basisKeyOf = (component) =>
  component === 'pharmacy' ? 'pharmacy_basis' : component === 'pf' ? 'pf_basis' : 'service_basis';

/** Shared audit context for bucket-provenance / bucket-cases.csv: cohort rows,
 *  basis cohorts and the resolved per-component bases for the target payor. */
async function bucketAuditContext(req) {
  const procedure = String(req.query.procedure || '');
  const payorBucket = String(req.query.payor_bucket || 'Cash');
  const base = await getCohort(procedure); // throws 400 for unknown family
  const careType = ['Surgical', 'Medical'].includes(req.query.care_type) ? req.query.care_type : null;
  const setting = ['Daycare', 'Inpatient'].includes(req.query.setting) ? req.query.setting : null;
  const def = applyCareControls(base, { care_type: careType, setting });
  const rows = await fetchCohortRows(def.whereSql, def.params);
  const counts = await payorBucketCounts(def.whereSql, def.params);
  const bases = resolveComponentBases(payorBucket, counts, def.familyKind);
  return { payorBucket, careType, setting, def, rows, counts, bases, cohorts: basisCohorts(rows) };
}

/**
 * GET /api/lookup/bucket-provenance?procedure=&payor_bucket=&care_type=&setting=
 * Admin audit: for every estimate bucket + driver, which payer basis it is
 * priced on, how many cohort cases back it, and the P25/P50/P75 the engine
 * derives from them. Companion to /provenance (cohort-level view).
 */
router.get('/bucket-provenance', async (req, res, next) => {
  try {
    const ctx = await bucketAuditContext(req);

    // Package bills — converted actuals (manager i16): the P25/P50/P75 of the
    // ACTUAL final package-bill amounts (package + exclusions, excl. F&B) for
    // this family cohort, per payor group, so a quoted package amount can be
    // validated against what converted bills really closed at. Value per case:
    // final_pkg_bill_excl_fnb (line-derived) when present, else pkg_gross_amount.
    // whereSql references unqualified mart columns (package_name also exists on
    // the actuals table), so it is applied inside a subquery over the bare
    // mart.main_table — same trusted-registry-literal interpolation as above.
    // Additive + fail-open: environments without fc.package_bill_admissions
    // simply omit the block; this must never break bucket-provenance.
    let packageBills = null;
    try {
      const { rows } = await query(
        `SELECT payor_bucket, count(*)::int AS cases,
                percentile_cont(0.25) WITHIN GROUP (ORDER BY final_amt) AS p25,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY final_amt) AS p50,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY final_amt) AS p75
         FROM (
           SELECT m.payor_bucket,
                  COALESCE(NULLIF(a.final_pkg_bill_excl_fnb, 0), a.pkg_gross_amount) AS final_amt
           FROM fc.package_bill_admissions a
           JOIN (SELECT admission_no, payor_bucket FROM mart.main_table WHERE ${ctx.def.whereSql}) m
             ON m.admission_no = a.ip_no
           WHERE a.open_bill_or_pkg_bill = 'Package Bill'
         ) t
         WHERE final_amt > 0
         GROUP BY payor_bucket
         ORDER BY cases DESC`,
        ctx.def.params
      );
      packageBills = {
        total_cases: rows.reduce((s, r) => s + r.cases, 0),
        groups: rows.map((r) => ({
          payor_bucket: r.payor_bucket,
          cases: r.cases,
          p25: round2(Number(r.p25)),
          p50: round2(Number(r.p50)),
          p75: round2(Number(r.p75)),
        })),
      };
    } catch {
      // actuals table absent on this environment — omit the block
    }

    const buckets = AUDIT_BUCKETS.map((b) => {
      const basisInfo = ctx.bases[basisKeyOf(b.component)];
      const basis = basisInfo.selected_basis;
      const basisRows = ctx.cohorts[basis] ?? [];
      const vals = basisRows.map(b.valueOf);
      const q = quartilesInclusive(vals);
      return {
        bucket: b.key,
        label: b.label,
        component: b.component,
        unit: b.unit ?? 'inr',
        basis,
        basis_status: basisInfo.status,
        confidence: basisInfo.confidence,
        case_count: basisRows.length,
        cases_with_value: vals.filter((v) => Number(v) > 0).length,
        p25: round2(q.p25), p50: round2(q.p50), p75: round2(q.p75),
      };
    });
    res.json({
      family: ctx.def.family,
      template_name: ctx.def.templateName,
      family_kind: ctx.def.familyKind,
      payor_bucket: ctx.payorBucket,
      applied_controls: { care_type: ctx.careType, setting: ctx.setting },
      cohort_total_cases: ctx.rows.length,
      bases: { ...ctx.bases, counts: ctx.counts },
      buckets,
      ...(packageBills ? { package_bills: packageBills } : {}),
    });
  } catch (err) { next(err); }
});

// Admission/discharge date columns are not part of fetchCohortRows; different
// mart builds name them differently (or lack them). Discover once via
// information_schema and cache — the CSV simply omits date columns when the
// mart has none, instead of failing at runtime.
const DATE_COL_CANDIDATES = [
  'admission_date', 'discharge_date', 'admission_dt', 'discharge_dt',
  'date_of_admission', 'date_of_discharge', 'admission_datetime', 'discharge_datetime',
  'doa', 'dod',
];
let admissionDateColsPromise = null;
function admissionDateColumns() {
  admissionDateColsPromise ??= query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'mart' AND table_name = 'main_table' AND column_name = ANY($1)`,
    [DATE_COL_CANDIDATES]
  ).then(
    ({ rows }) => DATE_COL_CANDIDATES.filter((c) => rows.some((r) => r.column_name === c)),
    () => { admissionDateColsPromise = null; return []; } // transient DB error: retry next request
  );
  return admissionDateColsPromise;
}

/**
 * GET /api/lookup/bucket-cases.csv?procedure=&payor_bucket=&bucket=&care_type=&setting=
 * Downloads the underlying cohort cases behind one audit bucket as CSV:
 * one row per admission of the basis cohort the bucket is priced on, with the
 * bucket's per-case value. `bucket` must be an AUDIT_BUCKETS key.
 */
router.get('/bucket-cases.csv', async (req, res, next) => {
  try {
    const bucketKey = String(req.query.bucket || '');
    const spec = AUDIT_BUCKETS.find((b) => b.key === bucketKey);
    if (!spec) {
      return res.status(400).json({
        error: `Unknown bucket '${bucketKey}'`,
        valid_buckets: AUDIT_BUCKETS.map((b) => b.key),
      });
    }
    const ctx = await bucketAuditContext(req);
    const basisInfo = ctx.bases[basisKeyOf(spec.component)];
    const basis = basisInfo.selected_basis;
    const cases = ctx.cohorts[basis] ?? [];

    const dateCols = await admissionDateColumns();
    const dates = new Map();
    if (dateCols.length && cases.length) {
      // dateCols come from the fixed DATE_COL_CANDIDATES whitelist (never user
      // input); def.whereSql is a trusted registry literal, as in /provenance.
      const sel = dateCols.map((c) => `${c}::text AS ${c}`).join(', ');
      const { rows } = await query(
        `SELECT admission_no, ${sel} FROM mart.main_table WHERE ${ctx.def.whereSql}`, ctx.def.params
      );
      for (const r of rows) dates.set(r.admission_no, r);
    }

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'admission_no', 'payor_bucket', 'organization_name', 'package_name',
      ...dateCols, 'los_days', 'normalized_stay_days', 'ot_hours',
      'bucket', 'basis', 'value',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="bucket_cases_${ctx.def.family}_${spec.key}_${basis.replace(/\s+/g, '_')}.csv"`
    );
    res.write(header.join(',') + '\n');
    for (const r of cases) {
      const d = dates.get(r.admission_no) ?? {};
      const v = spec.valueOf(r);
      res.write([
        r.admission_no, r.payor_bucket, r.organization_name, r.package_name,
        ...dateCols.map((c) => d[c]),
        r.los_days, stayOf(r), r.ot_hours,
        spec.key, basis, v == null ? '' : round2(Number(v)),
      ].map(esc).join(',') + '\n');
    }
    res.end();
  } catch (err) { next(err); }
});

/**
 * GET /api/lookup/organizations — payor organizations with tariff mapping,
 * enriched with the payor bucket(s) each org was historically billed under
 * (admission counts) and how many packages apply to it. The UI uses `buckets`
 * to show only the insurers that belong to the selected payor bucket.
 */
router.get('/organizations', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.organization_cd, m.organization_name, m.tariff_cd, m.tariff_name, m.priority_type,
              COALESCE(h.buckets, '{}'::jsonb) AS buckets,
              COALESCE(p.packages, 0)::int AS packages,
              COALESCE(p.packages_priced, 0)::int AS packages_priced
       FROM fc.organization_tariff_mapping m
       LEFT JOIN (
         SELECT organization_cd, jsonb_object_agg(payor_bucket, n) AS buckets
         FROM (SELECT organization_cd, payor_bucket, count(*) AS n
               FROM mart.main_table WHERE organization_cd <> '' GROUP BY 1, 2) t
         GROUP BY organization_cd
       ) h USING (organization_cd)
       LEFT JOIN (
         SELECT a.organization_cd, count(*) AS packages,
                count(*) FILTER (WHERE pm.can_generate_estimate AND pm.package_amount > 1000) AS packages_priced
         FROM fc.package_organization_applicability a
         JOIN fc.package_master pm
           ON pm.tariff_code = a.tariff_code AND pm.package_code = a.package_code
         WHERE a.organization_cd <> ''
         GROUP BY a.organization_cd
       ) p USING (organization_cd)
       ORDER BY m.organization_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/service-items?q= — search canonical service items */
router.get('/service-items', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await query(
      `SELECT canonical_item_key, item_code, item_name, fc_estimate_bucket, grouping,
              billing_head, sub_head, room_category_dependent
       FROM fc.service_item_mapping
       WHERE item_name ILIKE $1 OR item_code ILIKE $1 OR canonical_item_key ILIKE $1
       ORDER BY item_name LIMIT 50`, [q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/pharmacy-items?q= — search canonical pharmacy items */
router.get('/pharmacy-items', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await query(
      `SELECT m.canonical_item_key, m.item_code, m.item_name, m.classification,
              m.fc_estimate_bucket, m.grouping, r.mrp, r.sale_rate
       FROM fc.pharmacy_item_mapping m
       LEFT JOIN fc.pharmacy_catalog_rate_reference r USING (canonical_item_key)
       WHERE m.item_name ILIKE $1 OR m.item_code ILIKE $1
       ORDER BY m.item_name LIMIT 50`, [q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/doctors?q=&tariff_name= — consultation doctors */
router.get('/doctors', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const tariff = req.query.tariff_name || 'KIMS';
    const { rows } = await query(
      `SELECT DISTINCT doctor_cd, doctor_name
       FROM fc.consultation_tariff_rate_matrix
       WHERE tariff_name = $2 AND (doctor_name ILIKE $1 OR doctor_cd ILIKE $1)
       ORDER BY doctor_name LIMIT 50`, [q, tariff]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
