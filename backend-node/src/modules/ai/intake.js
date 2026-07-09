import { geminiJson } from './gemini.js';
import { query } from '../../db/pool.js';
import { listFamilies } from '../engine/cohort.js';

const SYSTEM = () => `You convert hospital financial-counselling intake material (free-text
notes and/or an uploaded admission note) into structured JSON for the FC Estimate Builder.
Extract patient details, clinical details (procedure, department, doctor), payment details
(cash vs insurance, insurer name) and any stated insurance-policy details.

Known procedure families (use the exact key; omit if none fits):
${listFamilies().map((f) => `- ${f.family}: ${f.label}`).join('\n')}

Return JSON: {
  patient: {name, age, gender},
  clinical: {procedure, procedure_text, department_name, doctor_name},
  payment: {payor_bucket: "Cash"|"GIPSA Insurance"|"Non-GIPSA Insurance"|"Corporate", organization_name},
  insurance: {base_sum_insured, consumed, ncb, copay_pct, room_rent_cap_per_day, room_eligibility: "General"|"Twin"|"Single"},
  flags: {emergency_ot: boolean, mlc: boolean},
  notes: string[]
}.
clinical.procedure_text: ALWAYS include the procedure/surgery/treatment wording verbatim from the
note whenever any is mentioned (e.g. "Lap ovarian cystectomy"), even when no known family fits;
clinical.procedure: only when one of the known family keys clearly fits — never force a match.
If the note implies insurance, set payor_bucket to the best-guess bucket and include the insurer
name verbatim in payment.organization_name. Amounts must be plain numbers in rupees.
Do not invent values; omit unknown fields. Set flags.mlc true only for medico-legal cases
(accidents, assault, poisoning); flags.emergency_ot true only for emergency surgery.`;

/**
 * AI step 1: intake material → structured estimate input.
 * @param {string} text        free-text note (optional when file given)
 * @param {{mimeType:string,data:string}} [file]  admission note upload (base64) — pdf/image
 */
export async function interpretIntake(text, file) {
  const parts = [];
  if (file?.data) parts.push({ inlineData: { mimeType: file.mimeType || 'application/pdf', data: file.data } });
  if (text) parts.push({ text });
  const structured = await geminiJson(parts.length === 1 && text ? text : [{ role: 'user', parts }], { system: SYSTEM() });

  // Ground the procedure: `procedure` must be a known family key. Models often
  // put the verbatim wording there despite the prompt — move it to
  // procedure_text so the UI can say "not in our database" instead of
  // silently dropping it.
  const known = new Set(listFamilies().map((f) => f.family));
  if (structured?.clinical?.procedure && !known.has(structured.clinical.procedure)) {
    structured.clinical.procedure_text = structured.clinical.procedure_text || structured.clinical.procedure;
    structured.clinical.procedure = null;
  }

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
