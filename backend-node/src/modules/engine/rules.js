/**
 * Canonical thresholds & rules from new2 docs 04/09/10/17.
 * All constants below are quoted from the reviewed finalized builders.
 */

/** Cash drug administration: 12.5% of pharmacy_total, cash only (doc 04). */
export const CASH_DRUG_ADMIN_RATE = 0.125;
export function cashDrugAdminCharge(pharmacyTotal, isCash) {
  return isCash ? pharmacyTotal * CASH_DRUG_ADMIN_RATE : 0;
}

/** Default-included service rule (docs 10/17). */
export function isDefaultIncluded({ presenceRate, typicalAmount }) {
  if (presenceRate > 90) return true;
  if (presenceRate >= 75 && typicalAmount <= 1000) return true;
  return false;
}

/** Add-on prioritization comparator (doc 17): expected contribution, presence, rate, stable identity. */
export function addOnComparator(a, b) {
  if (b.expected_contribution !== a.expected_contribution) return b.expected_contribution - a.expected_contribution;
  if (b.presence_rate !== a.presence_rate) return b.presence_rate - a.presence_rate;
  if (b.rate !== a.rate) return b.rate - a.rate;
  return (a.grouping || '').localeCompare(b.grouping || '')
    || (a.item_name || '').localeCompare(b.item_name || '')
    || (a.item_code || '').localeCompare(b.item_code || '');
}

/** Grouped residual classification (docs 10/17). */
export function classifyGroupedResidual({ presenceRate, residualP50, bucket, leftOutPositive, hasOptionalChild }) {
  if (presenceRate > 90 && residualP50 > 0) return 'auto';
  if (presenceRate >= 75 && presenceRate <= 90 && residualP50 > 0) return 'optional';
  // investigation-group promotion rule
  if (
    bucket === 'Investigations' && presenceRate >= 50 && residualP50 >= 1000 &&
    leftOutPositive && hasOptionalChild
  ) return 'auto';
  return null; // not rendered as a residual row
}

/** OT-consumables shortlist share → percentile band (docs 09/17). */
export function otConsumablesBandFromShare(share) {
  if (share <= 0.30) return 'P25';
  if (share <= 0.50) return 'P50';
  return 'P75';
}

/** Robotic default selection (doc 17). presence threshold 90.0, max presence among robotic rows. */
export const ROBOTIC_PRESENCE_THRESHOLD = 90.0;
export function roboticDefaultSelected(mode, presenceRate) {
  if (mode === 'yes') return true;
  if (mode === 'no') return false;
  return presenceRate > ROBOTIC_PRESENCE_THRESHOLD; // 'auto'
}

/** Robotic row detection markers (doc 17). */
export function isRoboticRow({ itemCode, itemName, grouping, bucket }) {
  const hay = [itemCode, itemName, grouping, bucket].map((s) => (s || '').toUpperCase());
  return hay.some((s) => s.includes('ROBO'));
}

/** Service-line-count alert vs historical band (doc 09). */
export function serviceLineCountAlert({ current, p25, p75 }) {
  if (current < p25) return 'below historical range';
  if (current > p75) return 'above historical range';
  return 'within historical range';
}

/** Estimate mode → percentile mapping (doc 09). */
export const MODE_TO_PERCENTILE = { Low: 'P25', Typical: 'P50', High: 'P75' };
