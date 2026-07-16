/**
 * Cleaned services, default-included vs optional split, add-on prioritization,
 * robotic handling and grouped residual candidates (BUILD_SPEC §3b–3d, docs 10/17).
 */
import { quartilesInclusive } from './stats.js';
import { inferRoomCategory } from '../drivers/normalization.js';

export const FIXED_ESTIMATE_TEMPLATE_SERVICE_CODES = new Set([
  'XRY5090', 'PHY5082', 'PAT0045', 'PAT0042', 'OTI0098', 'EME0087', 'EME0017',
  'DIE0001', 'CAS0007', 'CAR5341', 'BIO0162', 'BIO0004', 'BIO0003', 'BIO0002', 'BIO0001',
]);
export const LOGIC_DRIVEN_SERVICE_CODES = new Set([
  'ROM5189', 'ROM0093', 'ROM5009', 'ROM0001', 'ROM0024', 'ROM0036', 'ICC0002', 'ICC0001',
  'HSP5013', 'EME0019', 'OTC0010', 'RNS0120', 'RNS5005', 'OTI0018', 'OTI0015', 'OTC5005', 'HSP0047',
  'MSC10', // MEDICAL RECORDS-1 DAY — daycare variant of RNS0120; the Medical Records logic row picks by family
]);
export const TEMPLATE_EXCLUDED_SERVICE_CODES = new Set([
  ...FIXED_ESTIMATE_TEMPLATE_SERVICE_CODES, ...LOGIC_DRIVEN_SERVICE_CODES,
]);

const isOtSlotName = (name) => /^OT(-E)? - .*HOURS?/i.test(name || '');
export const isRoboticText = (...texts) => texts.some((t) => /ROBO/i.test(t || ''));

/**
 * 'remove'-category rows are room-linked services (BED CHARGES, OXYGEN PER DAY…)
 * already priced via the room logic rows. The classification may mark them in
 * fc_estimate_bucket OR grouping — treat either as remove (manager review:
 * they must never surface as Service add-ons).
 */
export const isRemoveCategory = (bucket, grouping) =>
  /remove/i.test(bucket || '') || /remove/i.test(grouping || '');

/**
 * Clean service stats rows for one basis into the FC template set:
 * mapped, non-"remove" bucket, not a fixed/logic template code, not an OT slot row.
 */
/**
 * @param {object} opts
 * @param {boolean} opts.excludeFixed - 'fixed' template families (TKR) pre-bake their
 *   template rows, so those codes are excluded from the cleaned set. 'auto' families
 *   (THR…) keep them: their template rows ARE the default-included cleaned rows.
 */
export function cleanServiceRows(statsRows, { excludeFixed = true, excludeCathLab = false } = {}) {
  return statsRows.filter((r) =>
    r.mapped &&
    !isRemoveCategory(r.fc_estimate_bucket, r.grouping) &&
    (r.grouping || '').trim() !== '' && // doctor-fee and F&B rows carry no grouping
    !LOGIC_DRIVEN_SERVICE_CODES.has(r.item_code) &&
    !(excludeFixed && FIXED_ESTIMATE_TEMPLATE_SERVICE_CODES.has(r.item_code)) &&
    !(excludeCathLab && /CATH ?LAB/i.test(r.item_name || '')) && // routed through the cath-lab history row
    !isOtSlotName(r.item_name)
  );
}

export function isDefaultIncluded(row) {
  const p = row.case_presence_rate ?? 0;
  return p > 90 || (p >= 75 && (row.amount_cash_typical ?? 0) <= 1000);
}

export function splitCleanedRows(cleaned) {
  const auto = [], optional = [];
  for (const r of cleaned) (isDefaultIncluded(r) ? auto : optional).push(r);
  return { auto, optional };
}

/** Rate used for add-on expected contribution (single→twin→general→icu fallback). */
export function addOnRate(row) {
  return row.tariff_single ?? row.tariff_twin ?? row.tariff_general ?? row.tariff_icu ??
    ((row.quantity_p50 ?? 0) > 0 ? (row.amount_cash_typical ?? 0) / row.quantity_p50 : 0);
}

export function expectedAddOnContribution(row) {
  return (row.quantity_p50 ?? 0) * (addOnRate(row) ?? 0) * ((row.case_presence_rate ?? 0) / 100);
}

/** Prioritize optional rows (BUILD_SPEC §3c). */
export function prioritizeOptionalRows(optional) {
  return [...optional].sort((a, b) =>
    expectedAddOnContribution(b) - expectedAddOnContribution(a) ||
    (b.case_presence_rate ?? 0) - (a.case_presence_rate ?? 0) ||
    (addOnRate(b) ?? 0) - (addOnRate(a) ?? 0) ||
    (a.grouping || '').localeCompare(b.grouping || '') ||
    (a.item_name || '').localeCompare(b.item_name || '') ||
    (a.item_code || '').localeCompare(b.item_code || '')
  );
}

/** Split robotic optional rows out (BUILD_SPEC §3c). */
export function splitRoboticOptional(optional, procedureCode) {
  const robotic = [], rest = [];
  for (const r of optional) {
    if (r.item_code !== procedureCode &&
        isRoboticText(r.item_code, r.item_name, r.grouping, r.fc_estimate_bucket)) robotic.push(r);
    else rest.push(r);
  }
  return { optional: rest, roboticRows: robotic };
}

/**
 * Robotic presence = MAX presence among robotic signal rows (BUILD_SPEC §3f).
 * Returns the rate plus the exact case counts behind it (workbook provenance):
 * { rate, case_count, basis_case_count } — counts are null when no robotic
 * signal row exists in the basis cohort.
 */
export function roboticPresenceInfo(statsRows, procedureCode) {
  let best = null;
  for (const r of statsRows) {
    if (isRemoveCategory(r.fc_estimate_bucket, r.grouping)) continue;
    const robotic = isRoboticText(r.item_code, r.item_name, r.grouping, r.fc_estimate_bucket);
    if (!robotic) continue;
    if (r.item_code !== procedureCode && TEMPLATE_EXCLUDED_SERVICE_CODES.has(r.item_code)) continue;
    if (!best || (r.case_presence_rate ?? 0) > (best.case_presence_rate ?? 0)) best = r;
  }
  return {
    rate: best?.case_presence_rate ?? 0,
    case_count: best?.case_count ?? null,
    basis_case_count: best?.basis_case_count ?? null,
  };
}

export function roboticPresenceRate(statsRows, procedureCode) {
  return roboticPresenceInfo(statsRows, procedureCode).rate;
}

export function roboticDefaultSelection(mode, presenceRate, threshold = 90) {
  if (mode === 'yes') return 'Yes';
  if (mode === 'no') return 'No';
  return presenceRate > threshold ? 'Yes' : '';
}

/** Per-payor robotic prompt threshold (15-Jul #9): presence >90% ⇒ include by
 *  default; ≥30% (but ≤90%) ⇒ offer the add-on as optional + a convert prompt. */
export const ROBOTIC_PROMPT_THRESHOLD = 30;

/**
 * Price the robotic add-on charge (15-Jul #27). Candidate items are the
 * family's registered contracted robotic codes (cohort.js roboticAddonItemsOf)
 * followed by the cohort's own billed robotic rows (highest presence first).
 * Pricing order:
 *   1. tariff_contracted — the payor tariff carries a real (non-TR1-backfilled)
 *      rate row for a candidate code (e.g. TR290 OTI0098 ₹1,20,000);
 *   2. cohort_history    — typical billed robotic amount from this basis' rows;
 *   3. tariff_tr1_fallback — TR1 (cash) rate flagged tr1_rate, last resort.
 * Returns { source, pricing: 'tariff'|'amount', item_code, item_name,
 *           rate?{general,twin,single}, amount?, tr1_rate? } or null.
 */
export function resolveRoboticAddonPricing({ addonItems = [], roboticRows = [], rates }) {
  const candidates = [];
  for (const it of addonItems) candidates.push({ code: it.code, name: it.label });
  for (const r of [...roboticRows].sort((a, b) => (b.case_presence_rate ?? 0) - (a.case_presence_rate ?? 0))) {
    if (!candidates.some((c) => c.code === r.item_code)) {
      candidates.push({ code: r.item_code, name: r.item_name, statsRow: r });
    }
  }
  const roomRates = (rate) => ({
    general: rate.general ?? rate.twin ?? rate.single ?? 0,
    twin: rate.twin ?? rate.single ?? rate.general ?? 0,
    single: rate.single ?? rate.twin ?? rate.general ?? 0,
  });
  const hasRate = (rate) => rate && ((rate.single ?? rate.twin ?? rate.general ?? 0) > 0);

  // 1. contracted rate on the resolved tariff itself
  for (const c of candidates) {
    const rate = rates.get(c.code);
    if (hasRate(rate) && !rate.tr1_fallback) {
      return {
        source: 'tariff_contracted', pricing: 'tariff',
        item_code: c.code, item_name: rate.name ?? c.name, rate: roomRates(rate),
      };
    }
  }
  // 2. billed robotic history in this cohort basis
  for (const c of candidates) {
    if ((c.statsRow?.amount_cash_typical ?? 0) > 0) {
      return {
        source: 'cohort_history', pricing: 'amount',
        item_code: c.statsRow.item_code, item_name: c.statsRow.item_name,
        amount: c.statsRow.amount_cash_typical,
      };
    }
  }
  // 3. TR1-backfilled tariff rate — better than silently dropping the charge
  for (const c of candidates) {
    const rate = rates.get(c.code);
    if (hasRate(rate)) {
      return {
        source: 'tariff_tr1_fallback', pricing: 'tariff', tr1_rate: true,
        item_code: c.code, item_name: rate.name ?? c.name, rate: roomRates(rate),
      };
    }
  }
  return null;
}

/**
 * Grouping gap analysis (BUILD_SPEC §3d):
 * exact group quartiles across admissions WHERE the grouping is present,
 * captured = Σ amount_cash_typical of default-included children.
 */
export function buildGroupingGaps(cohortRows, cleaned, mappingByCode) {
  const { auto, optional } = splitCleanedRows(cleaned);
  // "default rows" = fixed template codes + default-included cleaned rows
  const defaultCodes = new Set([
    ...FIXED_ESTIMATE_TEMPLATE_SERVICE_CODES,
    ...auto.map((r) => r.item_code),
  ]);
  const optionalCount = new Map();
  for (const r of optional) optionalCount.set(r.grouping, (optionalCount.get(r.grouping) || 0) + 1);

  // per-admission totals per grouping — ALL mapped items with a grouping
  const groupTotals = new Map();   // grouping -> [per-admission totals]
  const capturedTotals = new Map(); // grouping -> [per-admission default-item totals]
  const cohortSize = cohortRows.length;
  for (const adm of cohortRows) {
    const per = new Map(), perDefault = new Map();
    for (const s of (adm.services_json || [])) {
      const m = mappingByCode.get(s.service_code);
      if (!m || !(m.grouping || '').trim() || isRemoveCategory(m.fc_estimate_bucket, m.grouping)) continue;
      // logic-driven codes are modeled as LID logic rows, not template gaps
      if (LOGIC_DRIVEN_SERVICE_CODES.has(s.service_code)) continue;
      if (isOtSlotName(s.service_name)) continue;
      const amt = Number(s.amount ?? 0);
      per.set(m.grouping, (per.get(m.grouping) || 0) + amt);
      if (defaultCodes.has(s.service_code)) {
        perDefault.set(m.grouping, (perDefault.get(m.grouping) || 0) + amt);
      }
    }
    for (const [g, total] of per) {
      if (!groupTotals.has(g)) groupTotals.set(g, []);
      groupTotals.get(g).push(total);
      if (!capturedTotals.has(g)) capturedTotals.set(g, []);
      capturedTotals.get(g).push(perDefault.get(g) || 0);
    }
  }

  const bucketByGrouping = new Map();
  for (const m of mappingByCode.values()) {
    if ((m.grouping || '').trim() && !bucketByGrouping.has(m.grouping)) {
      bucketByGrouping.set(m.grouping, m.fc_estimate_bucket);
    }
  }

  const gaps = [];
  for (const [grouping, totals] of groupTotals) {
    const q = quartilesInclusive(totals);
    const captured = quartilesInclusive(capturedTotals.get(grouping) || [0]).p50;
    const presence = cohortSize ? (totals.length / cohortSize) * 100 : 0;
    const bucket = bucketByGrouping.get(grouping) || '';
    const residualP50 = Math.max(0, q.p50 - captured);
    const leftOut = q.p50 - captured;
    gaps.push({
      grouping, bucket, presence,
      p25Exact: q.p25, p50Exact: q.p50, p75Exact: q.p75,
      captured, leftOut, residualP50,
      optionalChildCount: optionalCount.get(grouping) || 0,
      status: presence > 90 && leftOut > 0 ? 'material_gap' : 'ok',
    });
  }
  return gaps;
}

/** Grouped residual candidates: auto/optional bands + investigation promotion (doc 17). */
export function buildGroupedResidualCandidates(gaps) {
  const out = [];
  for (const g of gaps) {
    if (!(g.residualP50 > 0 && g.leftOut > 0)) continue;
    let band = null;
    let why = null;
    if (g.presence > 90) { band = 'auto'; why = 'Auto common-case residual'; }
    else if (g.presence >= 75 && g.presence <= 90) { band = 'optional'; why = 'Optional common-case residual'; }
    else if (
      /investigation/i.test(g.bucket) && g.presence >= 50 && g.residualP50 >= 1000 &&
      g.leftOut > 0 && g.optionalChildCount >= 1
    ) {
      // Investigation promotion: SURFACED for visibility but NOT auto-included —
      // auto requires presence > 90% (manager correction i5.md; the reference
      // script wrongly promoted these to auto and the finalized Excel inherited it).
      band = 'optional';
      why = `Investigation residual (presence ${g.presence.toFixed(0)}% < 90% — review before including)`;
    }
    if (!band) continue;
    out.push({
      ...g, band,
      selected: band === 'auto' ? 'Include' : 'Exclude',
      why,
    });
  }
  out.sort((a, b) => b.residualP50 - a.residualP50 || b.presence - a.presence ||
    a.grouping.localeCompare(b.grouping));
  return out;
}

// ——— Professional-Fees room-matched fallback (16-Jul note ¶2) ————————————————
/**
 * Manager's rule, verbatim: "look at the same room category for a patient,
 * fetch the professional fee from that, given the fact that the patient
 * you're fetching the data from is a standard case with not multiple
 * procedures or something. And the value of their bill is close to the P50
 * value."
 *
 * From the decided cohort's admissions, keep only:
 *   (a) same room category as the estimate's room type (mart.main_table
 *       room_category is already 'General'/'Twin'/'Single'/'Deluxe'; both
 *       sides are normalized through inferRoomCategory),
 *   (b) standard single-procedure cases — no multi-template curation
 *       (curated_template_names_jsonb length > 1) and no combo package name
 *       (comma / " + " separators),
 *   (c) gross bill within ±PF_FALLBACK_GROSS_BAND_PCT% of the cohort's gross
 *       P50, and a real (>0) billed PF to fetch.
 *
 * Returns { pf_p50, pf_p25, pf_p75, cases, sample_ips, criteria } or null
 * when fewer than PF_FALLBACK_MIN_CASES admissions qualify (fail-open — the
 * caller keeps its existing PF story).
 */
export const PF_FALLBACK_MIN_CASES = 3;
export const PF_FALLBACK_GROSS_BAND_PCT = 15;

const pfGrossOf = (r) => Number(r.total_plus_drug_admin ?? r.services_total_ex_fnb ?? 0);
const pfOf = (r) => Number(r.buckets?.professional_fees ?? 0);

/** Standard case = exactly one procedure: no multi-template curation, no combo package name. */
export function isStandardSingleProcedure(r) {
  const templates = Array.isArray(r.curated_templates) ? r.curated_templates : [];
  if (templates.length > 1) return false;
  const pkg = String(r.package_name || '');
  if (pkg.includes(',') || /\s\+\s/.test(pkg)) return false;
  return true;
}

export function roomMatchedPfFallback({ cohortRows, roomType, payorGroup } = {}) {
  let rows = Array.isArray(cohortRows) ? cohortRows : [];
  const roomKey = inferRoomCategory(roomType) ?? String(roomType || '').trim().toLowerCase();
  if (!rows.length || !roomKey) return null;
  // optional payor narrowing (callers usually pass an already payor-scoped set)
  if (payorGroup) {
    const scoped = rows.filter((r) => r.payor_bucket === payorGroup);
    if (scoped.length) rows = scoped;
  }
  const grossVals = rows.map(pfGrossOf).filter((v) => v > 0);
  if (!grossVals.length) return null;
  const grossP50 = quartilesInclusive(grossVals).p50;
  const lo = grossP50 * (1 - PF_FALLBACK_GROSS_BAND_PCT / 100);
  const hi = grossP50 * (1 + PF_FALLBACK_GROSS_BAND_PCT / 100);
  const qualifying = rows.filter((r) => {
    if (inferRoomCategory(r.room_category) !== roomKey) return false;
    if (!isStandardSingleProcedure(r)) return false;
    const gross = pfGrossOf(r);
    if (!(gross >= lo && gross <= hi)) return false;
    return pfOf(r) > 0; // a bill with no PF has no PF to fetch
  });
  if (qualifying.length < PF_FALLBACK_MIN_CASES) return null;
  const pf = quartilesInclusive(qualifying.map(pfOf));
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    pf_p50: r2(pf.p50),
    pf_p25: r2(pf.p25),
    pf_p75: r2(pf.p75),
    cases: qualifying.length,
    sample_ips: qualifying.slice(0, 10).map((r) => r.admission_no),
    criteria: {
      room_type: roomKey,
      band_pct: PF_FALLBACK_GROSS_BAND_PCT,
      standard_only: true,
      cohort_gross_p50: Math.round(grossP50),
      cohort_cases: rows.length,
    },
  };
}
