import { Router } from 'express';
import { query } from '../db/pool.js';
import { geminiJson } from '../modules/ai/gemini.js';
import { listFamilies, getCohort, applyCareControls } from '../modules/engine/cohort.js';
import { fetchCohortRows, basisCohorts, buildBasisSummary } from '../modules/engine/artifacts.js';
import { payorBucketCounts, resolveBasis, resolveComponentBases } from '../modules/resolve/payerBasis.js';
import { quartilesInclusive, round2 } from '../modules/engine/stats.js';

const router = Router();

/** GET /api/lookup/families — clinical families (drives the UI dropdown; daycare ⇒ no room selection) */
router.get('/families', (_req, res) => res.json(listFamilies()));

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

    const families = listFamilies();
    const system = `You map a doctor's free-text treatment/surgery wording to a hospital's
known procedure families for cost estimation.

Known procedure families (use the exact key):
${families.map((f) => `- ${f.family}: ${f.label}`).join('\n')}

Return STRICT JSON: { "matches": [{ "family": "<exact key from the list>",
"confidence": "high"|"medium"|"low", "reason": "<one line why it matches>" }] }.
Return at most the top 3 matches ordered best-first; fewer if fewer plausibly fit,
and an empty array if nothing fits. Never invent family keys not in the list.`;

    const out = await geminiJson(`Doctor's wording: ${text}`, { system });

    const byKey = new Map(families.map((f) => [f.family, f]));
    const seen = new Set();
    const matches = (Array.isArray(out?.matches) ? out.matches : [])
      .filter((m) => m && byKey.has(m.family) && !seen.has(m.family) && seen.add(m.family))
      .slice(0, 3)
      .map((m) => ({
        family: m.family,
        label: byKey.get(m.family).label,
        confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'low',
        reason: typeof m.reason === 'string' ? m.reason : '',
      }));

    res.json({ text, matches });
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
        `SELECT COALESCE(NULLIF(package_name, ''), '(none)') AS package_name, count(*)::int AS cases
         FROM mart.main_table WHERE ${def.whereSql}
         GROUP BY 1 ORDER BY cases DESC, package_name LIMIT 20`, def.params
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
