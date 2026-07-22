/**
 * Medical management — doc T11, manager 21-Jul.
 *
 * NOT one generic medical estimate — a menu of ~15 clinical families × setting
 * (ward / ICU-involved / daycare-observation). Exact room + governed PF (and
 * drug-admin for cash) are auto-calculated; pharmacy / investigations / variable
 * bedside services are POLICY-FIRST historical RANGES (only 7 of 1,071 medical
 * scenarios are historically estimable and none are production-certified —
 * present wide ranges + confidence flags, never a false-precise diagnosis).
 *
 * Setting bands validated 2026-07-22 (open-bill non-surgical): Ward P50 ₹75k ·
 * ICU-involved P50 ₹210k · Daycare/Obs P50 ₹36k.
 *
 * Hybrid mapping (Step 1 explicit treatment → dedicated pathway; 2 explicit
 * diagnosis → auto-select+confirm; 3 symptom-only → ranked suggestions; 4
 * "medical management" only → department + wide range; 5 multiple → one primary
 * + secondaries). The doctor-written indication is a STRUCTURED, confirmed input
 * (FC counselling remarks are not the indication).
 *
 * Procedure-like "medical" items are ROUTED OUT (their own pathway/name):
 * chemotherapy, immunotherapy, dialysis/CRRT, blood transfusion, bronchoscopy,
 * endoscopy, interventional radiology, planned procedures, medical-mgmt+procedure.
 *
 * Semi-manual fallback (manager): when no strong historical template, redirect to
 * a semi-manual FC builder — auto-add the calculable fields (room, drug-admin,
 * PF by LOS/logic) and let the FC manually add the non-calculable ones (pharmacy,
 * investigations).
 *
 * Additive: attached as estimate.medical_management; never mutates base totals.
 */

export const MEDICAL_FAMILIES = [
  'general_undifferentiated', 'fever_infection', 'sepsis', 'respiratory', 'cardiac',
  'neuro', 'gi_hepatology', 'renal', 'endocrine', 'onco_haem', 'paediatric',
  'neonatal', 'obstetric_observation', 'toxicology_trauma',
];

// procedure-like items that must NOT appear as medical-management options
const PROCEDURE_LIKE = /chemo|immunotherap|dialys|crrt|transfusion|bronchoscop|endoscop|interventional radiolog|angio|biopsy|planned procedure/i;

// families with a strong-enough historical template to range confidently (doc:
// only 7 estimable). Everything else → semi-manual fallback.
const ESTIMABLE = new Set(['fever_infection', 'respiratory', 'renal', 'cardiac', 'gi_hepatology', 'endocrine', 'general_undifferentiated']);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} p
 * @param {string} p.family        one of MEDICAL_FAMILIES (or raw text to route)
 * @param {string} p.setting       'ward' | 'icu' | 'daycare'
 * @param {number} p.losDays
 * @param {string} p.payorBucket
 * @param {{p25:number,p50:number,p75:number,n:number}} [p.settingBand]  validated cohort band
 * @param {Array<{name:string, amount?:number}>} [p.highValueItems]  doctor-written structured items
 * @param {string} [p.indicationText]  original doctor wording (preserved)
 * @param {boolean} [p.forceSemiManual]
 * @returns {null | object}
 */
export function buildMedicalManagement({ family, setting = 'ward', losDays = 1, payorBucket, settingBand, highValueItems = [], indicationText, forceSemiManual }) {
  const fam = String(family || '').trim().toLowerCase();
  if (!fam) return null;                                     // explicit selection only

  // procedure-like → route out to its own pathway (never a medical-mgmt option)
  if (PROCEDURE_LIKE.test(fam) || PROCEDURE_LIKE.test(String(indicationText || ''))) {
    return {
      active: true, route_out: true, family: fam,
      reason: 'procedure_like_not_medical_management',
      note: 'This is a procedure-like item (chemo/dialysis/transfusion/endoscopy/…) — it must not be estimated as generic medical management; route to its own dedicated pathway (separate UI name).',
    };
  }

  const settingKey = /icu/i.test(setting) ? 'icu' : /day/i.test(setting) ? 'daycare' : 'ward';
  const isCash = /cash/i.test(String(payorBucket || ''));
  const estimable = ESTIMABLE.has(fam) && !forceSemiManual && settingBand && settingBand.n >= 15;

  // fields the engine CAN calculate from LOS + logic (auto-added)
  const calculable_fields = [
    { field: 'room_charges', basis: 'setting × LOS', auto: true },
    { field: 'professional_fee', basis: 'governed PF (visits by setting: 1 ward / 2 ICU per day)', auto: true },
    ...(isCash ? [{ field: 'drug_administration', basis: 'cash only', auto: true }] : []),
  ];
  // fields that are historical ranges / manual (never invented as a point value)
  const range_fields = [
    { field: 'pharmacy', mode: estimable ? 'historical_range' : 'manual', per_day: true },
    { field: 'investigations', mode: estimable ? 'historical_range' : 'manual', per_day: true },
    { field: 'variable_bedside_services', mode: 'historical_range' },
  ];

  const band = settingBand ? { p25: round2(settingBand.p25), p50: round2(settingBand.p50), p75: round2(settingBand.p75), sample: settingBand.n } : null;

  const semi_manual = !estimable ? {
    active: true,
    reason: forceSemiManual ? 'forced' : (!ESTIMABLE.has(fam) ? 'family_not_historically_estimable' : 'insufficient_cohort'),
    auto_added: ['room_charges', 'professional_fee', ...(isCash ? ['drug_administration'] : [])],
    manual_entry: ['pharmacy', 'investigations'],
    note: 'No strong historical template — semi-manual FC builder: calculable fields (room, PF, drug-admin) auto-added by LOS/logic; the FC manually enters pharmacy and investigations.',
  } : null;

  return {
    active: true,
    route_out: false,
    family: fam,
    family_known: MEDICAL_FAMILIES.includes(fam),
    setting: settingKey,
    presentation: 'policy_first',            // wide ranges + confidence flags; never false-precise
    estimable,
    confidence: estimable ? 'ranged_policy' : 'semi_manual_fallback',
    setting_band: band,                       // ward/ICU/daycare cohort P25/P50/P75 (whole-stay reference)
    calculable_fields,
    range_fields,
    high_value_items: highValueItems.map((h) => ({ ...h, source: 'doctor_written', status: 'confirm_before_add' })),
    indication_text: indicationText || null,  // preserve original wording (mapping evidence)
    semi_manual,
    refresh_triggers: ['24h', 'icu_transfer', 'los_change', 'high_cost_investigation', 'pharmacy_escalation'],
    notes: [
      'Medical management is a family × setting menu — not one generic estimate.',
      'Room + PF (+ drug-admin for cash) are auto-calculated; pharmacy/investigations are historical ranges or manual.',
      estimable ? 'Ranged policy estimate — confidence flags shown; not production-certified.' : 'Semi-manual fallback — FC adds the non-calculable fields.',
      'Doctor-written high-value items are structured, confirm-before-add inputs; FC counselling remarks are not the indication.',
    ],
  };
}
