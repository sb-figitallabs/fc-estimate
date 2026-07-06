import { query } from '../../db/pool.js';

/**
 * Payer-basis auto resolution (docs/14_payer_basis_and_payor_selection_rules.md).
 * Resolves independently for service / pharmacy / PF components.
 *
 * Fallback chain: exact target → Insurance All (GIPSA/Non-GIPSA only) → All Payers → Cash.
 * Exact thresholds: surgical=15, daycare=15, other=20. Fallback cohort threshold: 25.
 */
export const BASIS_OPTIONS = [
  'Auto (Recommended)', 'Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance',
  'Corporate', 'Insurance All', 'All Payers',
];

const EXACT_TARGETS = new Set(['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance', 'Corporate']);
const INSURANCE_TARGETS = new Set(['GIPSA Insurance', 'Non-GIPSA Insurance']);

export function exactThreshold(familyKind) {
  if (familyKind === 'surgical' || familyKind === 'daycare') return 15;
  return 20;
}
export const FALLBACK_THRESHOLD = 25;

/**
 * Count cohort cases per payor bucket for a cohort filter (SQL + params must
 * select from mart.main_table rows of the clinical family).
 */
export async function payorBucketCounts(cohortWhereSql, params) {
  const { rows } = await query(
    `SELECT payor_bucket, count(*)::int AS n
     FROM mart.main_table WHERE ${cohortWhereSql}
     GROUP BY payor_bucket`, params
  );
  const counts = {};
  for (const r of rows) counts[r.payor_bucket] = r.n;
  const insuranceAll = (counts['GIPSA Insurance'] || 0) + (counts['Non-GIPSA Insurance'] || 0);
  const allPayers = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, insuranceAll, allPayers };
}

/**
 * Resolve one component's basis.
 * @param {string} target - target payor bucket (e.g. 'Cash')
 * @param {{counts:Object, insuranceAll:number, allPayers:number}} cohort
 * @param {string} familyKind - 'surgical' | 'daycare' | other
 */
export function resolveBasis(target, cohort, familyKind) {
  const thr = exactThreshold(familyKind);
  const exact = cohort.counts[target] || 0;

  if (EXACT_TARGETS.has(target) && exact >= thr) {
    return {
      selected_basis: target, case_count: exact,
      status: 'recommended_exact', confidence: exact >= thr * 2 ? 'high' : 'medium',
      reason: `Exact ${target} cohort has ${exact} cases (threshold ${thr})`,
    };
  }
  if (INSURANCE_TARGETS.has(target) && cohort.insuranceAll >= FALLBACK_THRESHOLD) {
    return {
      selected_basis: 'Insurance All', case_count: cohort.insuranceAll,
      status: 'recommended_fallback_insurance_all', confidence: 'medium',
      reason: `Exact ${target} too small (${exact} < ${thr}); Insurance All has ${cohort.insuranceAll} cases`,
    };
  }
  if (cohort.allPayers >= FALLBACK_THRESHOLD) {
    return {
      selected_basis: 'All Payers', case_count: cohort.allPayers,
      status: 'recommended_fallback_all_payers', confidence: 'medium',
      reason: `Exact ${target} too small (${exact} < ${thr}); All Payers has ${cohort.allPayers} cases`,
    };
  }
  return {
    selected_basis: 'Cash', case_count: cohort.counts['Cash'] || 0,
    status: 'recommended_fallback_cash', confidence: 'low',
    reason: `All cohorts sparse (target=${exact}, insuranceAll=${cohort.insuranceAll}, allPayers=${cohort.allPayers}); falling back to Cash`,
  };
}

/** Resolve service/pharmacy/pf bases independently (same framework per doc 14). */
export function resolveComponentBases(target, cohort, familyKind) {
  return {
    service_basis: resolveBasis(target, cohort, familyKind),
    pharmacy_basis: resolveBasis(target, cohort, familyKind),
    pf_basis: resolveBasis(target, cohort, familyKind),
  };
}
