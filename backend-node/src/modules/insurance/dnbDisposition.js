/**
 * DNB (Do-Not-Bill) four-value line model — doc T5 (N1), manager 21-Jul.
 *
 * "Do Not Bill" means patient-payable = ₹0: SI exhaustion never transfers these
 * to the patient, and a line appearing in the insurer/LAN bill does not make it
 * patient-payable. The FC estimate must show ONLY patient_payable; items where
 * the patient never pays (submit-and-waive-if-denied, bundled, ₹1 non-show) are
 * hidden from the FC estimate but carry a billing_disposition in METADATA
 * (manager: "UI could be only covered/non-covered, metadata could be these
 * fields … items [where] hospital waiver if denied should not show up in FC").
 *
 * This is a PURE ANNOTATION layer — it adds metadata to the already-computed
 * settlement rows and changes NO amount. The settlement's patient/insurer split
 * is unchanged (our classifyRow already routes DNB items off the patient:
 * monitor/intensivist/ICU-nursing → icu; asst-anaesthetist/asst-physician/DMO →
 * associated — insurer-side, not patient-NME).
 *
 * billing_disposition values (doc N1):
 *   CLAIM_AND_WAIVE_IF_DENIED   submitted to insurer, hospital waives if denied
 *   INCLUDED_IN_PARENT_TARIFF   bundled into a parent line, no separate charge
 *   LAN_NON_SHOW_RUPEE_ONE      shown at ₹1 in the LAN/insurer bill
 *   SUPPRESS_DO_NOT_BILL        never billed at all
 *   PATIENT_PAYABLE_NME_GIPSA   GIPSA-only: general instruments are patient NME
 *   PATIENT_PAYABLE             genuinely patient-borne (NME / copay / overflow)
 *   COVERED                     insurer-admissible, patient ₹0
 */

// ₹1 non-show items (history: DMO 46.5% · monitor 43.4% · asst-intensivist 49.8%
// · OT-disinfection 44.1% · general instruments 45.4% — from the manager's full
// open-bill history; our package-bill lines can't reproduce these shares).
const RUPEE_ONE = /\bDMO\b|MONITOR PER DAY|ASSISTANT INTENSIVIST|OT DISINFECTION|GENERAL INSTRUMENT|INSTRUMENT CHARGES/i;
// submit-and-waive-if-denied (insurer-side, hospital eats it if denied)
const CLAIM_WAIVE = /ASSISTANT PHYSICIAN|CRITICAL CARE CONSULT|INTENSIVIST/i;
// bundled / never separately patient-billed
const SUPPRESS = /ASSISTANT AN[A]?ESTHETIST|TRANSFUSION SERVICE|HOSPITAL \+? ?ALLIED|MEDICAL \+? ?ALLIED|DRUG ADMINISTRATION/i;
// GIPSA general-instrument NME exception (urology instruments excluded)
const GIPSA_INSTR = /GENERAL INSTRUMENT|INSTRUMENT CHARGES \(MAJOR\)/i;

const isGipsa = (b) => /gipsa/i.test(String(b || '')) && !/non/i.test(String(b || ''));

/** billing disposition for one settled row (metadata only). */
export function dispositionOf(row, payorBucket) {
  const name = String(row.name || '').toUpperCase();
  const patientBorne = row.class === 'nme';

  // GIPSA-only: general instruments are patient-payable NME (not urology).
  if (isGipsa(payorBucket) && GIPSA_INSTR.test(name) && !/UROLOGY/.test(name)) {
    return 'PATIENT_PAYABLE_NME_GIPSA';
  }
  if (patientBorne) return 'PATIENT_PAYABLE';
  if (SUPPRESS.test(name)) return 'SUPPRESS_DO_NOT_BILL';
  if (CLAIM_WAIVE.test(name)) return 'CLAIM_AND_WAIVE_IF_DENIED';
  if (RUPEE_ONE.test(name)) return 'LAN_NON_SHOW_RUPEE_ONE';
  if (row.class === 'associated' || row.class === 'icu') {
    return (row.admissible || 0) > 0 ? 'CLAIM_AND_WAIVE_IF_DENIED' : 'INCLUDED_IN_PARENT_TARIFF';
  }
  return 'COVERED';
}

// dispositions where the patient never pays → hidden from the FC (patient) estimate
const PATIENT_ZERO = new Set([
  'CLAIM_AND_WAIVE_IF_DENIED', 'INCLUDED_IN_PARENT_TARIFF',
  'LAN_NON_SHOW_RUPEE_ONE', 'SUPPRESS_DO_NOT_BILL', 'COVERED',
]);

/**
 * Annotate a settlement result with the N1 four-value model. Additive: every row
 * gains `billing_disposition` + a `four_value` metadata block + an `fc_hidden`
 * flag (true when the patient pays ₹0 → not shown in the FC estimate). No
 * settlement amount is changed.
 * @returns the same settlement object with annotated rows + a `dnb` summary.
 */
export function annotateDnbDisposition(settlement, payorBucket) {
  if (!settlement || !Array.isArray(settlement.rows)) return settlement;
  let hidden = 0;
  const rows = settlement.rows.map((r) => {
    const disposition = dispositionOf(r, payorBucket);
    const patient_payable = disposition === 'PATIENT_PAYABLE' || disposition === 'PATIENT_PAYABLE_NME_GIPSA'
      ? (r.admissible != null ? r._raw ?? null : null) : 0;
    const fc_hidden = PATIENT_ZERO.has(disposition);
    if (fc_hidden) hidden += 1;
    return {
      ...r,
      billing_disposition: disposition,
      fc_hidden,                              // patient pays ₹0 → hide from FC estimate
      four_value: {                           // metadata — never surfaced as separate FC charges
        gross_tariff: r._raw ?? null,
        insurer_submitted: disposition === 'SUPPRESS_DO_NOT_BILL' ? 0 : (r.admissible ?? null),
        expected_insurer_approved: r.admissible ?? null,
        patient_payable,
        hospital_waiver_if_denied: disposition === 'CLAIM_AND_WAIVE_IF_DENIED',
      },
    };
  });
  return {
    ...settlement,
    rows,
    dnb: {
      model: 'four_value_line',
      ui: 'covered_or_not_covered',           // FC UI shows only covered/non-covered; four_value lives in metadata
      fc_hidden_rows: hidden,                  // patient-₹0 lines hidden from the FC estimate
      rule: 'follow_final_bill_logic',         // manager D1 — GIPSA vs Non-GIPSA final-bill logic governs
      note: 'FC estimate shows only patient_payable. DNB items (patient ₹0) are hidden from FC; billing_disposition + four_value are metadata for the insurer/audit view.',
    },
  };
}
