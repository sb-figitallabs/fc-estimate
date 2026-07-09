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
  }).optional(),
  room_eligibility: z.enum(['General', 'Twin', 'Single']).optional(),
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
    robotic: z.enum(['yes', 'no', 'auto']).default('auto'),
    emergency_ot: z.enum(['No', 'Yes']).default('No'), // switches OT pricing to the OT-E slot ladder
    mlc: z.enum(['No', 'Yes']).default('No'),          // applies the MLC charge row (HSP0047)
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
