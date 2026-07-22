/**
 * Blood bank — doc T17, manager 21-Jul.
 *
 * DELIBERATELY MINIMAL for the FC estimate. The manager's direction: blood bank
 * is a doctor-inputted add-on only; the FC should just decide whether a
 * transfusion is needed — NOT get into unit-level states, reserve/issue/
 * transfuse registers, or cross-match reversal (those are real-time billing
 * concerns, not FC-estimate concerns). "We don't need unit-level for FC unless
 * it has a significant impact."
 *
 * So: a transfusion flag → add the transfusion service (EME0088) + a blood
 * component (default 1 unit PRBC BLD0024), priced from the tariff. No reversal
 * logic, no unit-state machine. The history's 99.6% component+cross-match
 * double-charge is IGNORED for now (manager will validate with the hospital —
 * "don't act on it").
 *
 * Scope: this covers the transfusion service (EME0088) + components only. It does
 * NOT suppress cross-matching as a distinct service, blood-bank investigations,
 * processing charges, or products under separate codes.
 *
 * Additive: attached as estimate.blood_bank; base estimate unchanged.
 */

const COMPONENT_CODE = { prbc: 'BLD0024', ffp: 'BLD0027' };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rate = (rateOf, code, room) => {
  const r = rateOf(code) || {};
  return Number(r[room]) || Number(r.general) || 0;
};

/**
 * @param {object} p
 * @param {boolean} p.transfusionNeeded  the FC's only real decision (doctor-inputted)
 * @param {string}  [p.component]        'prbc' (default) | 'ffp'
 * @param {number}  [p.units]            optional — default 1 (don't get into units unless significant)
 * @param {(code:string)=>object} p.rateOf
 * @param {string}  p.room
 * @returns {null | object}
 */
export function buildBloodBank({ transfusionNeeded, component, units, rateOf, room = 'general' }) {
  if (!transfusionNeeded) return null;                 // doctor-inputted only
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const compKey = String(component || 'prbc').toLowerCase();
  const compCode = COMPONENT_CODE[compKey] || 'BLD0024';
  const u = Math.max(1, Math.round(Number(units) || 1));   // default 1 unit

  const svcRate = rate(rateOf, 'EME0088', roomKey) || 1270;      // transfusion service
  const compRate = rate(rateOf, compCode, roomKey) || (compCode === 'BLD0024' ? 2650 : 500);

  const components = [
    { name: 'Transfusion Service', code: 'EME0088', qty: u, unit_rate: round2(svcRate), amount: round2(svcRate * u), per: 'per_unit_transfused' },
    { name: compKey === 'ffp' ? 'Fresh Frozen Plasma (FFP)' : 'Packed Red Blood Cells (PRBC)', code: compCode, qty: u, unit_rate: round2(compRate), amount: round2(compRate * u), per: 'per_component_issued' },
  ];
  const total = round2(components.reduce((t, c) => t + c.amount, 0));

  return {
    active: true,
    trigger: 'doctor_inputted',
    fc_decision: 'transfusion_needed_yes_no',           // FC decides need, not units/states
    unit_level_model: false,                            // no reserve/issue/transfuse register
    reversal_logic: 'not_applicable_fc',                // cross-match reversal is a real-time billing concern
    components,
    total,                                              // additive — NOT folded into the base total
    scope_note: 'Covers the transfusion service (EME0088) + component only; does not suppress cross-matching as a distinct service, blood-bank investigations, processing charges, or products under separate codes.',
    double_charge_note: 'History retains both component + cross-match in 99.6% of cases — NOT reproduced here, and not acted on (manager validating with the hospital).',
    notes: [
      'Blood bank is a doctor-inputted add-on — the FC only decides whether a transfusion is needed.',
      units != null ? `Units specified: ${u}.` : 'Default 1 unit (units not modelled unless the doctor specifies a significant count).',
    ],
  };
}
