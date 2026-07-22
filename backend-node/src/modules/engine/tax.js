/**
 * Tax (room-rent GST) — doc T16, manager 21-Jul. The highest-confidence tab.
 *
 * Statutory 5% GST on NON-ICU room rent > ₹5,000/day, on the FULL room-rent
 * amount (not just the excess); exactly ₹5,000 → ₹0. ICU/CCU/ICCU/NICU/HDU are
 * EXEMPT even above ₹5,000. Tax is by SERVICE CODE, not ward name (a regular
 * single-room code in a ward named "MICU" still carries 5%). Same GST math for
 * all payers; payer logic only decides who bears it. Room rent ONLY — never
 * nursing / pharmacy / consultations / bedside / meals / the whole bill.
 * (CBIC, effective 18-Jul-2022; 2.5% CGST + 2.5% SGST. Historical compliance
 * 99.68%.)
 *
 * Surfaced as a SEPARATE "GST on room rent @ 5%" line (estimate.tax) — additive,
 * never folded into the parity-pinned base total. Packages: tax only the
 * identifiable room component, never the whole package amount (avoid double-count
 * when the package already includes GST).
 *
 * Attendant room (18% GST): NO code/rate in the tariff yet → OFF by default; if
 * the FC selects it, show a flag (no default rate published). HDU: assume
 * untaxed for now (pending Finance).
 */

const THRESHOLD = 5000;          // per-day room rent; strictly ABOVE is taxed
const GST_ROOM = 0.05;
const BED_CODE = { general: 'ROM0001', twin: 'ROM0024', single: 'ROM0036' };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} p
 * @param {string} p.room       selected room key
 * @param {number} p.wardDays   ward (non-ICU) days
 * @param {number} p.icuDays    ICU days (exempt)
 * @param {(code:string)=>object} p.rateOf
 * @param {boolean} [p.attendantRoom]  FC selected an attendant room (18% GST, no code yet)
 * @returns {null | object}
 */
export function buildRoomTax({ room = 'general', wardDays = 0, icuDays = 0, rateOf, attendantRoom }) {
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const bedCode = BED_CODE[roomKey];
  const perDay = Number((rateOf(bedCode) || {}).general) || Number((rateOf(bedCode) || {})[roomKey]) || 0;
  const wd = Math.max(0, Number(wardDays) || 0);

  const taxable = perDay > THRESHOLD;                    // strictly above ₹5,000/day; ICU handled separately
  const wardBase = round2(perDay * wd);
  const gstAmount = taxable && wd > 0 ? round2(GST_ROOM * wardBase) : 0;

  const lines = [];
  if (wd > 0) {
    lines.push({
      component: 'patient_room_rent', code: bedCode, per_day: perDay, days: wd, base: wardBase,
      category: taxable ? 'PATIENT_ROOM_5_ABOVE_5000' : 'below_threshold_no_gst',
      gst_rate: taxable ? GST_ROOM : 0, gst_amount: gstAmount,
      note: taxable ? `5% GST on the full room rent (₹${perDay}/day > ₹5,000).` : `No GST — room rent ₹${perDay}/day ≤ ₹5,000.`,
    });
  }
  if (icuDays > 0) {
    lines.push({
      component: 'critical_care_room', days: Math.round(Number(icuDays) || 0),
      category: 'CRITICAL_CARE_ROOM_EXEMPT', gst_rate: 0, gst_amount: 0,
      note: 'ICU/CCU/ICCU/NICU/HDU room rent is GST-exempt even above ₹5,000.',
    });
  }

  const attendant = attendantRoom ? {
    category: 'ATTENDANT_ACCOMMODATION_18', status: 'no_code_flag_only', gst_rate: 0.18, gst_amount: null,
    note: 'Attendant room carries 18% GST but has no tariff code/rate yet — off by default. Flagged for the FC; no default rate published (pending Finance: code / SAC / daily rate / effective date).',
  } : null;

  return {
    applies_to: 'room_rent_only',                        // never other buckets
    basis: 'by_service_code_not_ward_name',
    statutory: 'CBIC 5% (2.5% CGST + 2.5% SGST), eff. 18-Jul-2022',
    all_payers_same_math: true,                          // payer only decides who bears it
    lines,
    gst_on_room_rent: gstAmount,                         // the separate "GST on room rent @ 5%" line
    attendant_room: attendant,
    package_rule: 'tax_identifiable_room_component_only', // never the whole package (avoid double-count)
    categories: ['PATIENT_ROOM_5_ABOVE_5000', 'CRITICAL_CARE_ROOM_EXEMPT', 'ATTENDANT_ACCOMMODATION_18'],
    note: 'GST is a separate line, additive to the base estimate (not folded into the parity-pinned total).',
  };
}
