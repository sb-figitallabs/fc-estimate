/**
 * Cleaned services, default-included vs optional split, add-on prioritization,
 * robotic handling and grouped residual candidates (BUILD_SPEC §3b–3d, docs 10/17).
 */
import { quartilesInclusive } from './stats.js';

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
const isRoboticText = (...texts) => texts.some((t) => /ROBO/i.test(t || ''));

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

/** Robotic presence = MAX presence among robotic signal rows (BUILD_SPEC §3f). */
export function roboticPresenceRate(statsRows, procedureCode) {
  let max = 0;
  for (const r of statsRows) {
    if (isRemoveCategory(r.fc_estimate_bucket, r.grouping)) continue;
    const robotic = isRoboticText(r.item_code, r.item_name, r.grouping, r.fc_estimate_bucket);
    if (!robotic) continue;
    if (r.item_code !== procedureCode && TEMPLATE_EXCLUDED_SERVICE_CODES.has(r.item_code)) continue;
    max = Math.max(max, r.case_presence_rate ?? 0);
  }
  return max;
}

export function roboticDefaultSelection(mode, presenceRate, threshold = 90) {
  if (mode === 'yes') return 'Yes';
  if (mode === 'no') return 'No';
  return presenceRate > threshold ? 'Yes' : '';
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
