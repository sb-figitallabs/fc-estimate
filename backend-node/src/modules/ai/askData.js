import { GoogleGenAI } from '@google/genai';
import { pool } from '../../db/pool.js';

/**
 * Ask-AI over the ENGINE's data (read-only): a small tool loop where Gemini
 * may run guarded SELECTs against fc.* / mart.* to answer the FC's question.
 * Never writes — enforced by a single-statement SELECT/WITH whitelist AND a
 * READ ONLY transaction with a statement timeout.
 */

const ai = process.env.VERTEX_AI_PROJECT
  ? new GoogleGenAI({
    vertexai: true,
    project: process.env.VERTEX_AI_PROJECT,
    location: process.env.VERTEX_AI_LOCATION || 'global',
  })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const MAX_TOOL_CALLS = 6;
const MAX_ROWS = 50;

const SCHEMA_DOC = `Database (PostgreSQL). You may read ONLY these:

mart.main_table — one row per past admission (the historical cohort base).
  Key columns: payor_bucket ('Cash'|'GIPSA Insurance'|'Non-GIPSA Insurance'|'Corporate'|'International'),
  curated_template_names_jsonb (jsonb array of procedure-template names — match with: curated_template_names_jsonb ? 'Template Name',
  or unnest via jsonb_array_elements_text), fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin (the bill total used everywhere),
  is_daycare_broad (boolean), los_days, icu_days, ot_hours numeric columns may vary — discover with information_schema when unsure.

fc.package_master — hospital package catalog per tariff. tariff_code (TR1=cash/KIMS, TR290=GIPSA, TR285/TR287/TR288/TR201/TR289…=insurer tariffs),
  package_code, package_name, package_amount (⚠ ₹10/₹0 = placeholder, not a real price), package_atl_amount, department_name,
  inclusions_text, exclusions_text, tariff_information (markdown table often holding real per-room prices), pre_days, post_days.
fc.package_alias — alias_text/normalized_alias_text → (tariff_code, package_code, package_name); alias_confidence.
fc.v_package_runtime_lookup — package_master joined with readiness: runtime_status, can_generate_estimate, primary_blocker,
  fc_template_package_code, fc_case_count_total, room_rates_jsonb, documentation_status.
fc.v_package_case_history — admission_count, min/max observed package amount per (tariff_code, package_code).
fc.package_bill_admissions — ACTUAL billed package cases: ip_no, p_tariff_cd (tariff), package_name, payer_type
  ('INSURANCE'|'PRIVATE'|'CORPORATE'|'INTERNATIONAL'), pkg_gross_amount, final_pkg_bill_excl_fnb (the real converted amount),
  date_of_admission, department_name, surgery_name.
fc.package_bill_lines — line items of those bills: ip_no, service_name, service_group, billed_amount, is_fnb.
fc.organization_tariff_mapping — organization_cd/name → tariff_cd/name (insurer → tariff).
fc.service_tariff_rate_matrix / fc.consultation_tariff_rate_matrix — per-tariff service/consultation rates.

Money is INR. Use percentile_cont for quartiles. Always LIMIT your queries.`;

const LOGIC_DOC = `Engine pricing logic (for "how/why" questions):
- Payor → tariff: Cash ⇒ TR1 (KIMS). Insurers resolve via fc.organization_tariff_mapping.
- Cohort: each procedure family maps to template names in mart.main_table (curated_template_names_jsonb). Estimates use the
  cohort's P25/P50/P75 per bucket (Room, OT, Pharmacy, Investigations, Professional Fees, …).
- Payer basis fallback: exact payor bucket ⇒ needs ≥15 cases; else Insurance-All (≥20); else All-Payers (≥25); else Cash.
- TR1 fallback: when an insurer tariff has no rate for an item, the cash (TR1) rate is used and the row is flagged tr1_rate.
- Packages: a package offer replaces covered items with the package price; ₹10/₹0 package_amount is a data placeholder —
  real prices then live per-room in tariff_information / room_rates_jsonb.
- Package gate route: package exists + usable details + billed history ⇒ exact_package; details or history weak ⇒
  package_with_review; no package ⇒ non-package cohort flow.`;

const SQL_TOOL = {
  functionDeclarations: [{
    name: 'run_sql',
    description: 'Run ONE read-only SQL SELECT (or WITH…SELECT) against the engine database. Single statement, no writes. Rows are capped at 50.',
    parameters: {
      type: 'OBJECT',
      properties: { sql: { type: 'STRING', description: 'The SELECT statement. Always include a LIMIT.' } },
      required: ['sql'],
    },
  }],
};

const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|vacuum|refresh|reindex|listen|notify|prepare|execute|deallocate|lock|comment|security|import)\b/i;

function assertReadOnly(sql) {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) throw new Error('empty sql');
  if (s.includes(';')) throw new Error('single statement only');
  if (!/^(select|with)\b/i.test(s)) throw new Error('SELECT/WITH only');
  if (WRITE_WORDS.test(s)) throw new Error('read-only: statement contains a write keyword');
  return s;
}

/** Execute inside a READ ONLY transaction with a hard statement timeout. */
async function runSql(sql) {
  const safe = assertReadOnly(sql);
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '12s'");
    const { rows, rowCount } = await client.query(safe);
    await client.query('COMMIT');
    const capped = rows.slice(0, MAX_ROWS);
    return { row_count: rowCount, truncated: rowCount > MAX_ROWS, rows: capped };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
    return { error: String(err.message).slice(0, 300) };
  } finally {
    client.release();
  }
}

/**
 * @param {object} p
 * @param {string} p.question       the user's question
 * @param {Array<{role:'user'|'model',text:string}>} [p.history]  prior turns
 * @param {object} [p.context]      page context bundle from the UI (estimate JSON etc.)
 * @param {{mimeType:string,data:string}} [p.screenshot]  optional page screenshot
 * @returns {{answer:string, queries:Array<{sql:string,row_count?:number,error?:string}>}}
 */
export async function askData({ question, history = [], context, screenshot }) {
  const system = `You are the AI assistant inside a hospital cost-estimate builder, answering the financial counselor's questions, at a hospital in Hyderabad, India.

You can query the engine's database with the run_sql tool (read-only). Use it whenever the answer needs data that is not
already in the provided context — counts, history, packages, tariffs, past bills. Prefer 1–3 focused queries over many.

${SCHEMA_DOC}

${LOGIC_DOC}

Answer rules:
- FIRST re-read the user's question and enumerate its parts. Your final answer MUST address each part in the order asked — a common failure is answering only the part your queries covered and silently dropping the how/why part. How/why parts are answered from the engine-logic notes above; data parts from queries.
- Names in the catalog are formal: expand abbreviations before searching (TKR → TOTAL KNEE REPLACEMENT, THR → TOTAL HIP REPLACEMENT, LSCS → CAESAREAN, URSL → URETEROSCOPIC LITHOTRIPSY, PCNL → PERCUTANEOUS NEPHROLITHOTOMY, CAG → coronary angiogram, D&C → dilatation curettage). If a search returns nothing, RETRY with broader single-word ILIKE patterns before concluding something does not exist — never conclude absence from one narrow query.
- Ground every figure in the context or your query results — never invent. Round amounts to whole rupees in Indian format (₹1,24,500).
- Keep answers short and concrete (2–6 sentences or a short list). If the data genuinely isn't there after broad retries, say so plainly.
- Never mention SQL or table names in the answer — speak in product terms (packages, past cases, tariffs).`;

  const contents = [];
  if (context) {
    contents.push({ role: 'user', parts: [{ text: `Current page context (JSON):\n${JSON.stringify(context)}` }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood — I will answer from this context and the database.' }] });
  }
  for (const m of history) {
    if (m?.text) contents.push({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 4000) }] });
  }
  contents.push({
    role: 'user',
    parts: [
      ...(screenshot?.data ? [{ inlineData: { mimeType: screenshot.mimeType || 'image/jpeg', data: screenshot.data } }] : []),
      { text: question },
    ],
  });

  const queries = [];
  for (let i = 0; i < MAX_TOOL_CALLS + 1; i++) {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 2048, tools: [SQL_TOOL] },
    });
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length || i === MAX_TOOL_CALLS) {
      const answer = parts.map((p) => p.text ?? '').join('').trim();
      return { answer: answer || 'I could not produce an answer from the data.', queries };
    }
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const c of calls) {
      const sql = c.functionCall.args?.sql;
      const result = await runSql(sql);
      queries.push({ sql: String(sql).slice(0, 500), row_count: result.row_count, ...(result.error ? { error: result.error } : {}) });
      responses.push({ functionResponse: { name: 'run_sql', response: result } });
    }
    // The tool results tend to eclipse the original question — restate it so
    // multi-part questions (data + how/why) get answered in full.
    responses.push({ text: `Query results above. When you have what you need, answer the user's FULL question — every part of: "${question}"` });
    contents.push({ role: 'user', parts: responses });
  }
  return { answer: 'I could not produce an answer from the data.', queries };
}
