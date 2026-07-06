import { resolveTariff } from '../resolve/payorTariff.js';
import { payorBucketCounts, resolveBasis } from '../resolve/payerBasis.js';
import { getCohort } from './cohort.js';

/**
 * Core estimate pipeline (docs 03/04/05/09/10/14-17).
 * Phase 1 target family: robotic_tkr_unilateral_right (cash, TR1).
 *
 * NOTE: engine sections are being implemented against the extracted spec
 * (spec/BUILD_SPEC.md). This file currently resolves context + cohort and
 * returns a partial payload.
 */
export async function buildEstimate(input) {
  const warnings = [];

  // 1-4. payor + tariff resolution
  const tariff = await resolveTariff({
    payorBucket: input.payment.payor_bucket,
    organizationCd: input.payment.organization_cd,
  });
  warnings.push(...tariff.warnings);
  if (!tariff.tariff_cd) {
    return { resolved_context: { tariff }, warnings, unresolved: ['tariff'] };
  }

  // 5. cohort + payer basis
  const cohort = await getCohort(input.clinical.procedure);
  const bucketCounts = await payorBucketCounts(cohort.whereSql, cohort.params);
  const target = input.payment.payor_bucket === 'Cash' ? 'Cash' : input.payment.payor_bucket;
  const bases = {
    service_basis: resolveBasis(target, bucketCounts, cohort.familyKind),
    pharmacy_basis: resolveBasis(target, bucketCounts, cohort.familyKind),
    pf_basis: resolveBasis(target, bucketCounts, cohort.familyKind),
  };

  return {
    resolved_context: {
      payor_bucket: input.payment.payor_bucket,
      tariff,
      family: cohort.family,
      family_kind: cohort.familyKind,
      cohort_case_count: bucketCounts.allPayers,
      payer_bases: bases,
      estimate_mode: input.controls.estimate_mode,
    },
    // sections to be filled by engine implementation:
    drivers: null,
    consultations: [],
    services: [],
    pharmacy: [],
    totals: null,
    warnings,
    unresolved_items: [],
  };
}
