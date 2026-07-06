/**
 * Normalization, rounding, and derived fields
 * (new2/docs/15_normalization_rounding_and_derived_fields.md)
 */

export const ICU_LABELS = ['MICU', 'SICU', 'PICU', 'NICU', 'ICCU', 'ICU'];
export const ICU_DISPLAY_PRECEDENCE = ['SICU', 'MICU', 'ICCU', 'ICU', 'HDU'];
export const COMMERCIAL_ROOM_PRECEDENCE = ['DELUXE', 'SINGLE', 'TWIN SHARING', 'GENERAL WARD', 'DAYCARE'];

/** Room-category inference from ward/service labels (doc 04 + 15). */
export function inferRoomCategory(label) {
  const s = (label || '').toUpperCase();
  if (ICU_LABELS.some((l) => s.includes(l))) return 'icu';
  if (s.includes('HDU')) return 'hdu';
  if (s.includes('SINGLE')) return 'single';
  if (s.includes('TWIN')) return 'twin';
  if (s.includes('GENERAL')) return 'general';
  if (s.includes('DAY CARE') || s.includes('DAYCARE')) return 'daycare';
  if (s.includes('DELUXE')) return 'deluxe';
  return null;
}

/**
 * Normalize LOS per reviewed rules. Returns { los, reason }.
 * @param {{losDays:number|null, isDaycare:boolean, sameDay:boolean|null, crossDay:boolean|null,
 *          lateAdmission:boolean, datesMissing:boolean}} ctx
 */
export function normalizeLos(ctx) {
  const { losDays, isDaycare, sameDay, lateAdmission, datesMissing } = ctx;
  if (datesMissing) {
    if (isDaycare && losDays !== null && losDays < 1) {
      return { los: 0, reason: 'missing_dates_daycare_los_lt_1' };
    }
    return { los: Math.ceil(losDays ?? 1), reason: 'missing_dates_fallback_ceil_los' };
  }
  if (sameDay) {
    if (isDaycare) return { los: 0, reason: 'same_day_daycare_fractional_los' };
    return { los: 1, reason: 'same_day_room_based_stay' };
  }
  // cross-day
  let los = Math.max(1, Math.round(losDays));
  let reason = 'cross_day_inclusive';
  if (lateAdmission && los > 1) {
    los -= 1;
    reason = 'cross_day_late_admission_adjusted';
  }
  if (!isDaycare && los < 1) los = 1; // never below 1 for non-daycare cross-day
  return { los, reason };
}

/** OT slot snapping: nearest supported slot-hours value (3.625→3.5, 3.75→4.0). */
export const SUPPORTED_OT_SLOTS = [2.0, 2.5, 3.0, 3.5, 4.0];

export function snapToOtSlot(hours, slots = SUPPORTED_OT_SLOTS) {
  if (hours == null || Number.isNaN(hours)) return null;
  let best = slots[0];
  let bestDist = Math.abs(hours - best);
  for (const s of slots.slice(1)) {
    const d = Math.abs(hours - s);
    // ties round up (3.75 → 4.0): later (larger) slot wins on equal distance
    if (d <= bestDist) { best = s; bestDist = d; }
  }
  return best;
}

/** Parse OT hours from service-row names like "OT - 2 1/2 HOURS". */
export function parseOtHours(serviceName) {
  const s = (serviceName || '').toUpperCase();
  if (!s.includes('OT')) return null;
  // patterns: "2 1/2 HOURS", "2.5 HOURS", "3 HOURS", "1/2 HOUR"
  const frac = s.match(/(\d+)\s+(\d+)\s*\/\s*(\d+)\s*HOURS?/);
  if (frac) return parseInt(frac[1], 10) + parseInt(frac[2], 10) / parseInt(frac[3], 10);
  const onlyFrac = s.match(/(?:^|\s)(\d+)\s*\/\s*(\d+)\s*HOURS?/);
  if (onlyFrac) return parseInt(onlyFrac[1], 10) / parseInt(onlyFrac[2], 10);
  const dec = s.match(/(\d+(?:\.\d+)?)\s*HOURS?/);
  if (dec) return parseFloat(dec[1]);
  return null;
}

/** Percentile helper (linear interpolation, numpy-style) for driver bands. */
export function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

/** Selected value from basis: P25/P50/P75/Manual (doc 09). */
export function selectDriverValue({ p25, p50, p75, basis, manual }) {
  switch (basis) {
    case 'P25': return p25;
    case 'P50': return p50;
    case 'P75': return p75;
    case 'Manual': return manual ?? p50;
    default: return p50;
  }
}
