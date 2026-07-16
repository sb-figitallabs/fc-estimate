import { Router } from 'express';
import { z } from 'zod';
import { evaluateFlow2 } from '../modules/flow2/flow2.service.js';

/**
 * Flow 2 (manager's 16-Jul flow note) — stateless SOP evaluation.
 * The request/response contract is FROZEN (a UI is built against it):
 * every selections field is declared explicitly — zod strips undeclared
 * keys, which silently dropped fields in a past bug.
 */
const CaseFiltersSchema = z.object({
  payor_scope: z.enum(['exact', 'insurance_all', 'all']).nullable().optional(),
  setting: z.enum(['Daycare', 'Inpatient']).nullable().optional(),
  robotic: z.enum(['yes', 'no']).nullable().optional(),
  care_type: z.enum(['Surgical', 'Medical']).nullable().optional(),
});

/** Combo only: one treatment path's selections (indexed by fragment). */
const PathSelectionsSchema = z.object({
  care_type: z.enum(['Surgical', 'Medical']).nullable().optional(),
  setting: z.enum(['Daycare', 'Inpatient']).nullable().optional(),
  robotic: z.enum(['yes', 'no']).nullable().optional(),
  family: z.string().nullable().optional(),
  package_code: z.string().nullable().optional(),
  case_filters: CaseFiltersSchema.nullable().optional(),
});

const SelectionsSchema = z.object({
  care_type: z.enum(['Surgical', 'Medical']).nullable().optional(),
  setting: z.enum(['Daycare', 'Inpatient']).nullable().optional(),
  robotic: z.enum(['yes', 'no']).nullable().optional(),
  family: z.string().nullable().optional(),
  package_code: z.string().nullable().optional(),
  case_filters: CaseFiltersSchema.nullable().optional(),
  /** logic/both only: the room the logic build prices at (history is room-agnostic; shared across combo paths). */
  room_type: z.enum(['General', 'Twin', 'Single']).nullable().optional(),
  /**
   * Combo only: per-path selections, indexed by splitFragments order.
   * paths[i] wins over the flat fields for its index; the flat fields keep
   * applying to path 0 (backward compat). Ignored for single treatments.
   */
  paths: z.array(PathSelectionsSchema.nullable()).nullable().optional(),
});

const Flow2Input = z.object({
  treatment_text: z.string().trim().min(1, 'treatment_text is required'),
  payment: z.object({
    payor_bucket: z.string().trim().min(1, 'payor_bucket is required'),
    organization_cd: z.string().nullable().optional(),
  }),
  selections: SelectionsSchema.nullable().optional()
    .transform((v) => {
      if (!v) return {};
      // normalize nulls away so the service can use plain ?? / truthiness
      const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, val]) => val != null));
      const out = clean(v);
      // paths entries keep their index (null entry → {}), nulls cleaned per entry
      if (Array.isArray(out.paths)) out.paths = out.paths.map((p) => (p == null ? {} : clean(p)));
      return out;
    }),
  mode: z.enum(['historic', 'logic', 'both']).default('historic'),
});

const router = Router();

/**
 * POST /api/flow2/evaluate — stateless: re-evaluates the whole SOP with the
 * caller's accumulated selections; returns the full step trail and stops
 * (pending_question) where a human answer is required. numbers is null while
 * a question is pending; otherwise pure-history quartiles (no logic math).
 */
router.post('/evaluate', async (req, res, next) => {
  try {
    const input = Flow2Input.parse(req.body);
    res.json(await evaluateFlow2(input));
  } catch (err) { next(err); }
});

export default router;
