/**
 * Emergency handling — a BILLING OVERLAY on Treatment A (doc T3, manager 21-Jul).
 *
 * Emergency is never a separate treatment and never one surcharge. Six
 * independent facts (clinically urgent / arrived via ER / emergency bed /
 * emergency-OT hours / MLC / payer emergency clause) each drive their own
 * component. Nothing is auto-added and NOTHING is inferred — every component is
 * gated on an EXPLICIT user answer (manager Q4: "we don't infer"). The engine
 * only computes what WOULD apply given the answers the FC has given.
 *
 * This overlay is additive and separate: it never mutates the parity-pinned base
 * line items or totals. buildEstimate attaches it as `estimate.emergency`; the
 * base estimate is byte-identical when no emergency input is set.
 *
 * Component pricing / provenance:
 *   - ER assessment (EME5060) + emergency bed (EME0065): live tariff (TR1 flat
 *     KIMS charge, carried into every payer tariff via the TR1 fallback).
 *   - ER physician (D000806): NOT in any tariff — priced from validated HIMS
 *     history median (source shown; never a silent hardcode).
 *   - Emergency OT: the existing `emergency_ot` control already prices the OT-E
 *     slot ladder in lineItems; here we only carry its provenance note. Manager
 *     Q2 ("need more info") + our validation (ZERO historical OT-E occurrences)
 *     → marked ACTIVE_POLICY, not history-validated.
 *   - Package emergency % (e.g. Bajaj 15% holiday/Sun, ICICI 10% 8PM–8AM): per
 *     org-agreement, mutually exclusive with OT-E (Q3). Surfaced as a flagged
 *     option requiring the agreement; never auto-computed without it.
 *
 * §5 validation (2026-07-22, fc.package_bill_lines over 17,002 admissions):
 *   D000806 median ₹1,000 (n≈91) · EME5060 ₹3,000 (n=56, ~96% insurance, ~0%
 *   cash) · EME0065 ₹1,310 (n=49) · OTC0054–0069 = 0 admissions.
 */

// Validated history reference for codes absent from the tariff (provenance-tagged).
const HISTORY = {
  D000806: { median: 1000, n: 91, note: 'validated 2026-07-22 · fc.package_bill_lines · median ₹1,000' },
};

const isInsurance = (bucket) => /insurance/i.test(String(bucket || ''));
const yes = (v) => String(v || '').toLowerCase() === 'yes' || v === true;

/** per-room amount for a tariff code from the resolved rate map (TR1 fallback already merged) */
function tariffAmount(rateOf, code, units = 1) {
  const r = rateOf(code) || {};
  const per = (k) => Math.round((Number(r[k]) || 0) * units * 100) / 100;
  return {
    general: per('general'), twin: per('twin'), single: per('single'),
    source: 'tariff', code, ...(r.tr1_fallback ? { tr1_fallback: true } : {}),
  };
}

/**
 * @param {object} p
 * @param {object} p.inputs   explicit emergency answers (all default off):
 *   { arrivedViaEr, clinicallyEmergency, emergencyBedExpected, emergencyBedHours,
 *     emergencyPricingMethod: 'none'|'ot_e'|'package_pct', mlc, emergencyOt }
 * @param {(code:string)=>object} p.rateOf  resolved payer-tariff rate lookup
 * @param {string} p.payorBucket
 * @param {string} p.room      'general'|'twin'|'single' (selected room, for the headline amount)
 * @returns {null | object}    the overlay, or null when there is no emergency context
 */
export function buildEmergencyOverlay({ inputs = {}, rateOf, payorBucket, room = 'general' }) {
  const arrivedViaEr = yes(inputs.arrivedViaEr);
  const bedExpected = yes(inputs.emergencyBedExpected);
  const method = String(inputs.emergencyPricingMethod || 'none').toLowerCase();
  const emergencyOt = yes(inputs.emergencyOt);

  // No explicit emergency context at all → no overlay (base estimate untouched).
  if (!arrivedViaEr && !bedExpected && method === 'none' && !emergencyOt && !yes(inputs.clinicallyEmergency)) {
    return null;
  }

  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const components = [];

  // 1) ER physician — arrived via ER, all payers. History-priced (no tariff row).
  if (arrivedViaEr) {
    const h = HISTORY.D000806;
    components.push({
      key: 'er_physician', name: 'ER Physician', code: 'D000806',
      gate: 'arrived_via_emergency_department = Yes', default_on: true,
      amount: { general: h.median, twin: h.median, single: h.median },
      source: 'history_median', provenance: h.note, sample: h.n,
    });
  }

  // 2) ER initial assessment — payer-sensitive: insurance default-ON when via ER,
  //    cash/corporate default-OFF (validation: ~96% of occurrences are insurance,
  //    ~0% cash). Still opt-in — never inferred, the FC confirms.
  if (arrivedViaEr) {
    const amt = tariffAmount(rateOf, 'EME5060');
    components.push({
      key: 'er_assessment', name: 'ER Initial Assessment', code: 'EME5060',
      gate: 'arrived_via_emergency_department = Yes', default_on: isInsurance(payorBucket),
      default_reason: isInsurance(payorBucket)
        ? 'insurance: ER assessment billed in ~96% of ER-origin insurance cases'
        : 'cash/corporate: ER assessment historically ~0% — off by default, confirm to add',
      amount: { general: amt.general, twin: amt.twin, single: amt.single },
      source: amt.source, ...(amt.tr1_fallback ? { tr1_fallback: true } : {}),
    });
  }

  // 3) Emergency bed 1–4h — only when ER-bed use is expected; ask, default OFF
  //    (usage fell sharply after Jul-2025). NOT the room category.
  if (bedExpected) {
    const units = Math.max(1, Math.ceil((Number(inputs.emergencyBedHours) || 1) / 4)); // 1 block per 1–4h
    const amt = tariffAmount(rateOf, 'EME0065', units);
    components.push({
      key: 'emergency_bed', name: `Emergency Bed (1–4h${units > 1 ? ` ×${units}` : ''})`, code: 'EME0065',
      gate: 'emergency_bed_expected = Yes', default_on: true,
      amount: { general: amt.general, twin: amt.twin, single: amt.single },
      source: amt.source, ...(amt.tr1_fallback ? { tr1_fallback: true } : {}), units,
    });
  }

  // included = default_on (the FC's explicit toggles refine this on the frontend)
  const included = components.filter((c) => c.default_on);
  const total = {
    general: included.reduce((t, c) => t + (c.amount.general || 0), 0),
    twin: included.reduce((t, c) => t + (c.amount.twin || 0), 0),
    single: included.reduce((t, c) => t + (c.amount.single || 0), 0),
  };

  // Package emergency % — per org-agreement, mutually exclusive with OT-E (Q3).
  const package_emergency = method === 'package_pct'
    ? { status: 'requires_agreement', mutually_exclusive_with: 'emergency_ot',
        note: 'Per org agreement only (e.g. Bajaj 15% holiday/Sunday, ICICI 10% 8PM–8AM). Not auto-computed — supply the org agreement % and the applicable-time confirmation.' }
    : null;

  // Emergency OT provenance (the emergency_ot control prices the OT-E slot in
  // lineItems; here we only mark its validation status).
  const ot_policy = emergencyOt
    ? { status: 'ACTIVE_POLICY', validated: false,
        note: 'OT-E slot priced from tariff (existing emergency_ot control). Zero historical OT-E occurrences (0/17,002) — tariff-backed policy, not history-validated (manager Q2 pending).' }
    : null;

  return {
    active: true,
    model: 'billing_overlay',           // overlay on Treatment A, never a separate treatment
    inference: 'none',                  // manager Q4 — every component gated on explicit input
    decision_workflow: {
      arrived_via_emergency_department: arrivedViaEr,
      is_clinically_emergency: yes(inputs.clinicallyEmergency),
      emergency_bed_expected: bedExpected,
      emergency_pricing_method: method,
      mlc: yes(inputs.mlc),             // MLC row is added in lineItems (independent yes/no)
    },
    components,
    total,                              // per-room sum of default-on components (advisory overlay — NOT folded into base total)
    total_selected: total[roomKey],
    package_emergency,
    ot_policy,
    // Variable emergency-care services (suturing/intubation/CPR…) — shown as a
    // RANGE from matched emergency history, never a surcharge. Range dataset not
    // yet wired; surfaced as a flagged display item.
    variable_services: { status: 'range_display', note: 'Variable emergency-care services (suturing, intubation, CPR…) shown as a historical range when a matched emergency-treatment cohort exists — never added as a surcharge.' },
    notes: [
      'Emergency is a billing overlay on Treatment A — components are user-selected, never inferred.',
      'This overlay total is separate from the base estimate total (advisory add-on).',
    ],
  };
}
