import { Router } from 'express';
import { z } from 'zod';
import { buildEstimate } from '../modules/engine/buildEstimate.js';
import { generateWorkbook } from '../modules/workbook/generateWorkbook.js';
import { interpretIntake } from '../modules/ai/intake.js';

const router = Router();

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
    room_type: z.string().optional(),           // GENERAL WARD | TWIN SHARING | SINGLE | DELUXE
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
  }).default({}),
});

/** POST /api/estimate/build — JSON estimate (resolved context, sections, totals, warnings) */
router.post('/build', async (req, res, next) => {
  try {
    const input = EstimateInput.parse(req.body);
    const estimate = await buildEstimate(input);
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

/** POST /api/estimate/intake — AI: free-text patient/clinical/insurance details → structured input */
router.post('/intake', async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const structured = await interpretIntake(text);
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

export default router;
