import { Router } from 'express';
import { z } from 'zod';
import { buildEstimate } from '../modules/engine/buildEstimate.js';
import { generateWorkbook } from '../modules/workbook/generateWorkbook.js';
import { interpretIntake } from '../modules/ai/intake.js';
import { settleManual } from '../modules/insurance/settlement.js';

/** Insurance policy input — shared by /build and /settle-manual. */
const InsuranceSchema = z.object({
  base_sum_insured: z.number().nonnegative(),
  consumed: z.number().nonnegative().default(0),
  ncb: z.number().nonnegative().default(0),
  top_up: z.object({
    amount: z.number().nonnegative().default(0),
    type: z.enum(['standard', 'super']).default('standard'),
    deductible: z.number().nonnegative().default(0),
  }).optional(),
  room_rent_cap: z.object({
    type: z.enum(['absolute', 'pct_of_si', 'room_category', 'none']).default('none'),
    value: z.number().nonnegative().optional(),      // absolute ₹/day
    icu_value: z.number().nonnegative().optional(),  // absolute ICU ₹/day (optional)
    ward_pct: z.number().positive().default(1),      // pct_of_si
    icu_pct: z.number().positive().default(2),
    category: z.string().optional(),                 // room_category: explicit allowed tier ('General'|'Twin'|'Single'); falls back to room_eligibility's highest tier when absent
  }).optional(),
  // one tier or a list of eligible tiers — the highest-rate tier governs the
  // cap / upgrade math (a policy allowing Twin implicitly allows General)
  room_eligibility: z.union([
    z.enum(['General', 'Twin', 'Single']),
    z.array(z.enum(['General', 'Twin', 'Single'])).min(1),
  ]).optional(),
  copay: z.object({
    type: z.enum(['percentage', 'absolute']).default('percentage'),
    value: z.number().nonnegative().default(0),
  }).optional(),
  sub_limits: z.array(z.object({
    label: z.string().optional(),
    applies_to: z.enum(['implants', 'pharmacy', 'investigations', 'procedure', 'total']),
    cap: z.number().positive(),
  })).optional(),
});

const router = Router();

/**
 * Canonicalize room names — line-item amounts are keyed general/twin/single,
 * so "TWIN SHARING", "General Ward", "Deluxe" etc. must resolve to one of
 * those or the settlement/coverage layers would silently read ₹0 everywhere.
 */
const normalizeRoom = (v) => {
  const s = String(v).toLowerCase();
  if (/twin/.test(s)) return 'Twin';
  if (/general|ward/.test(s)) return 'General';
  if (/single|deluxe|suite/.test(s)) return 'Single';
  return null;
};

export const EstimateInput = z.object({
  patient: z.object({
    name: z.string().optional(),
    age: z.union([z.string(), z.number()]).optional(),
    gender: z.string().optional(),
    umr_no: z.string().optional(),
    admission_no: z.string().optional(),
  }).default({}),
  clinical: z.object({
    procedure: z.string().default('robotic_tkr_unilateral_right'),
    /** Raw doctor's wording (intake note / treatment search). When present and
     *  no explicit package is given, package selection goes through the gate
     *  brain (alias + AI clinical ranking on the payor's tariff) instead of
     *  the cohort-dominant heuristic. */
    treatment_text: z.string().optional(),
    /** Gate resolution carried `robotic_addon: true` (payor-aware robotic
     *  redirect: base family + robotic add-on). Forces the built estimate to
     *  include the robotic add-on charge, priced from the payor tariff's
     *  contracted robotic item (cohort history as fallback). */
    robotic_addon: z.boolean().optional(),
    department_name: z.string().optional(),
    doctor_name: z.string().optional(),
    doctor_cd: z.string().optional(),
  }),
  payment: z.object({
    payor_bucket: z.string().default('Cash'),
    organization_cd: z.string().optional(),
  }),
  controls: z.object({
    room_type: z.string().optional()            // General | Twin | Single (accepts "General Ward", "Twin Sharing", "Deluxe"→Single)
      .transform((v) => (v == null ? v : normalizeRoom(v)))
      .refine((v) => v !== null, 'room_type must resolve to General / Twin / Single (aliases: "General Ward", "Twin Sharing", "Deluxe")'),
    estimate_mode: z.enum(['Low', 'Typical', 'High']).default('Typical'),
    payer_basis: z.string().default('Auto (Recommended)'),
    los_basis: z.string().default('P50'),
    los_manual: z.number().optional(),
    icu_basis: z.string().default('P50'),
    icu_manual: z.number().optional(),
    ward_basis: z.string().default('P50'),
    ward_manual: z.number().optional(),
    ot_hours_basis: z.string().default('P50'),
    ot_hours_manual: z.number().optional(),
    // Cath-lab hours (cath-lab families only — CAG / PTCA): mirrors ot_hours.
    // basis 'manual' + cath_hours_manual prices the Cath Lab row at manual
    // hours x the cohort's historical cath-lab ₹/hour.
    cath_hours_basis: z.string().default('P50'),
    cath_hours_manual: z.number().optional(),
    robotic: z.enum(['yes', 'no', 'auto']).default('auto'),
    emergency_ot: z.enum(['No', 'Yes']).default('No'), // switches OT pricing to the OT-E slot ladder
    mlc: z.enum(['No', 'Yes']).default('No'),          // applies the MLC charge row (HSP0047)
    // Emergency overlay (doc T3) — explicit answers only; NOTHING is inferred.
    // Drive the emergency billing overlay (ER physician / ER assessment /
    // emergency bed / package-% method). See modules/engine/emergency.js.
    arrived_via_emergency_department: z.enum(['No', 'Yes']).default('No'), // ER-origin — gates ER physician + assessment
    is_clinically_emergency: z.enum(['No', 'Yes']).default('No'),         // clinical urgency (context; no auto-charge)
    emergency_bed_expected: z.enum(['No', 'Yes']).default('No'),          // ER-bed use expected — gates emergency-bed row
    emergency_bed_hours: z.number().nonnegative().optional(),             // hours in the emergency bed (1–4h blocks)
    emergency_pricing_method: z.enum(['none', 'ot_e', 'package_pct']).default('none'), // Q3: mutually exclusive method
    // Positive-case (infective/seropositive) overlay (doc T4) — VERIFIED status
    // only, explicit toggle, never inferred from a test order. See
    // modules/engine/positiveCase.js.
    positive_status: z.enum(['NONE', 'HBSAG', 'HCV', 'HIV_SEROPOSITIVE', 'H1N1', 'OTHER_INFECTIVE']).default('NONE'),
    confirmation_source: z.enum(['green_sticker', 'lab', 'clinical', 'manual']).optional(), // status must be verified
    requires_isolation: z.enum(['No', 'Yes']).default('No'),
    isolation_room_days: z.number().nonnegative().optional(),
    isolation_icu_days: z.number().nonnegative().optional(),
    surgery_context: z.enum(['non_heart', 'ct', 'cath_lab', 'medical']).optional(), // resolves the HBsAg/HCV context code
    payer_agreement_id: z.string().optional(),
    // Newborn pathways (doc T6) — "newborn" never auto-adds a bed/PF; the FC
    // selects a pathway explicitly. See modules/engine/newborn.js.
    newborn_pathway: z.enum(['none', 'healthy_with_mother', 'well_baby_package', 'phototherapy', 'nicu']).default('none'),
    newborn_stay_days: z.number().nonnegative().optional(),
    nicu_days: z.number().nonnegative().optional(),                 // NICU room days — NOT the generic icu field
    newborn_twins: z.enum(['No', 'Yes']).default('No'),
    newborn_in_mother_package: z.enum(['No', 'Yes']).default('No'),
    phototherapy_double_surface: z.enum(['No', 'Yes']).default('No'),
    // Cross-consultations (doc T9) — FC-selected (suggest-and-confirm), never
    // auto-included. Priced at the contracted visit tariff by TR code. See
    // modules/engine/crossConsult.js.
    cross_consults: z.array(z.object({
      department: z.string(),
      visits: z.number().positive().optional(),
      doctor_cd: z.string().optional(),
    })).optional(),
    // Medical management (doc T11) — family × setting menu, policy-first, with a
    // semi-manual fallback. See modules/engine/medicalManagement.js.
    medical_management: z.object({
      family: z.string(),
      setting: z.enum(['ward', 'icu', 'daycare']).optional(),
      high_value_items: z.array(z.object({ name: z.string(), amount: z.number().optional() })).optional(),
      indication_text: z.string().optional(),
      semi_manual: z.boolean().optional(),
    }).optional(),
    // Daycare modifier (doc T12) — applies when setting = Daycare. See
    // modules/engine/daycare.js.
    daycare_expected_hours: z.number().nonnegative().optional(),  // drives strict(<=12h)/extended/cross-midnight status
    daycare_auto_suggested: z.boolean().optional(),               // suggested (not FC-picked) → needs confirm
    daycare_inpatient_conversion: z.boolean().optional(),         // model the conversion contingency
    // Chemotherapy / systemic therapy (doc T13) — conservative: sure things auto,
    // therapy drug cost is a structured doctor/user input. See modules/engine/chemo.js.
    chemo: z.object({
      route: z.enum(['routine_cytotoxic', 'immunotherapy_targeted', 'supportive_infusion_only', 'planned_inpatient', 'high_dose_bmt']).optional(),
      regimen_items: z.array(z.object({ drug: z.string(), brand: z.string().optional(), strength: z.string().optional(), vials: z.number().optional(), unit_price: z.number().optional() })).optional(),
      supportive_infusions: z.array(z.object({ name: z.string(), amount: z.number().optional() })).optional(),
      chemoport: z.boolean().optional(),
      prior_cycle_ref: z.object({ bill: z.number().optional(), note: z.string().optional() }).optional(),
    }).optional(),
    // Labour room (doc T15) — maternal location add-on, additive to the ward
    // charge. Default 0-4h slot. See modules/engine/labourRoom.js.
    labour_room: z.boolean().optional(),              // delivery pathway selected → enable
    labour_room_hours: z.number().nonnegative().optional(),  // projected occupancy hours
    // Tax (doc T16) — room-rent GST is computed automatically; attendant room is
    // an off-by-default flag (no tariff code yet). See modules/engine/tax.js.
    attendant_room: z.boolean().optional(),
    // Blood bank (doc T17) — doctor-inputted transfusion add-on; FC decides need,
    // not unit-level states. See modules/engine/bloodBank.js.
    blood_transfusion: z.boolean().optional(),
    blood_component: z.enum(['prbc', 'ffp']).optional(),
    blood_units: z.number().positive().optional(),
    // Narrow the clinical cohort to a specific care type / setting. Omitted =>
    // use the family's own mix. Drives cohort filter + template row structure.
    care_type: z.enum(['Surgical', 'Medical']).optional(),
    setting: z.enum(['Daycare', 'Inpatient']).optional(),
  }).default({}),
  package: z.object({
    package_code: z.string().optional(),
    package_name: z.string().optional(),
    text: z.string().optional(), // free text → alias + Gemini resolution
  }).optional(),
  insurance: InsuranceSchema.optional(),
  selections: z.object({
    add_ons: z.record(z.string(), z.enum(['Include', 'Exclude'])).optional(),
    grouped: z.record(z.string(), z.enum(['Include', 'Exclude'])).optional(),
    ot_consumables: z.record(z.string(), z.enum(['Include', 'Exclude'])).optional(),
    implants: z.object({
      mode: z.string().optional(), family: z.string().optional(),
      brand: z.string().optional(), itemCode: z.string().optional(),
    }).optional(),
  }).optional(),
});

/**
 * POST /api/estimate/build — JSON estimate (resolved context, sections, totals, warnings).
 * The internal `artifacts` block (raw cohort rows incl. patient identifiers + full
 * reference tables, ~5 MB) is stripped from HTTP responses — it exists for the
 * in-process workbook generator only.
 */
router.post('/build', async (req, res, next) => {
  try {
    const input = EstimateInput.parse(req.body);
    const { artifacts, ...estimate } = await buildEstimate(input);
    res.json(estimate);
  } catch (err) { next(err); }
});

/** POST /api/estimate/workbook — full FC Estimate Builder .xlsx download */
router.post('/workbook', async (req, res, next) => {
  try {
    const input = EstimateInput.parse(req.body);
    const estimate = await buildEstimate(input);
    const { buffer, filename } = await generateWorkbook(estimate, input);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
});

/**
 * POST /api/estimate/intake — AI: admission note → structured input.
 * Body: { text?, file?: { mimeType, data(base64) } } — at least one required.
 * Files (pdf/image) go to Gemini multimodal alongside any typed note.
 */
router.post('/intake', async (req, res, next) => {
  try {
    const { text, file } = req.body;
    if (!text && !file?.data) return res.status(400).json({ error: 'text or file is required' });
    const structured = await interpretIntake(text, file);
    res.json(structured);
  } catch (err) { next(err); }
});

/** POST /api/estimate/map-items — AI: fuzzy item descriptions → canonical item candidates */
router.post('/map-items', async (req, res, next) => {
  try {
    const { items } = req.body; // [{description, kind: 'service'|'pharmacy', context?}]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items[] required' });
    const { mapItems } = await import('../modules/ai/itemMapper.js');
    res.json(await mapItems(items));
  } catch (err) { next(err); }
});

/** POST /api/estimate/explain — AI: plain-language estimate summary for the FC conversation */
router.post('/explain', async (req, res, next) => {
  try {
    const input = EstimateInput.parse(req.body);
    const estimate = await buildEstimate(input);
    const { explainEstimate } = await import('../modules/ai/explain.js');
    const explanation = await explainEstimate(estimate);
    res.json({ final_estimate: estimate.final_estimate, bucket_totals: estimate.bucket_totals, explanation });
  } catch (err) { next(err); }
});

/**
 * POST /api/estimate/settle-manual — bucket-level insurance settlement for the
 * manual / open-billing fallback (no cohort estimate). Body:
 * { buckets: {<bucket>: number}, insurance: {...}, los_days?, icu_days?, nme_amount? }
 */
const ManualSettleInput = z.object({
  buckets: z.record(z.string(), z.number().nonnegative()).default({}),
  insurance: InsuranceSchema,
  los_days: z.number().nonnegative().default(0),
  icu_days: z.number().nonnegative().default(0),
  nme_amount: z.number().nonnegative().default(0),
});

router.post('/settle-manual', async (req, res, next) => {
  try {
    const input = ManualSettleInput.parse(req.body);
    res.json(settleManual(input));
  } catch (err) { next(err); }
});

export default router;
