import { geminiJson } from './gemini.js';
import { query } from '../../db/pool.js';

const SYSTEM = `You convert free-text hospital financial-counselling intake notes into
structured JSON for the FC Estimate Builder. Extract patient details, clinical details
(procedure, department, doctor), and payment details (cash vs insurance, insurer name).
Known procedure families: robotic_tkr_unilateral_right.
Return JSON: { patient: {name, age, gender}, clinical: {procedure, department_name, doctor_name},
payment: {payor_bucket: "Cash"|"GIPSA Insurance"|"Non-GIPSA Insurance"|"Corporate", organization_name},
notes: string[] }.
If the note implies insurance, set payor_bucket to the best-guess bucket and include the insurer
name verbatim in payment.organization_name. Do not invent values; omit unknown fields.`;

/** AI step 1: free text → structured estimate input. */
export async function interpretIntake(text) {
  const structured = await geminiJson(text, { system: SYSTEM });

  // Ground insurer name → organization_cd via DB (AI suggests, DB decides)
  if (structured?.payment?.organization_name && structured.payment.payor_bucket !== 'Cash') {
    const { rows } = await query(
      `SELECT organization_cd, organization_name, tariff_cd, tariff_name
       FROM fc.organization_tariff_mapping
       WHERE organization_name ILIKE '%' || $1 || '%' LIMIT 5`,
      [structured.payment.organization_name]
    );
    structured.payment.organization_candidates = rows;
    if (rows.length === 1) structured.payment.organization_cd = rows[0].organization_cd;
  }
  return structured;
}
