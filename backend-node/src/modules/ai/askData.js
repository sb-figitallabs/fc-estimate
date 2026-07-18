import { GoogleGenAI } from '@google/genai';
import { pool } from '../../db/pool.js';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/** "Ask the Project" corpus (18-Jul): the project chronicle (dated decision
 * history — what the logic is, what it was before, which manager input
 * changed it) + the recent git log. Loaded once at boot; the git log
 * re-generates on every deploy, so answers stay in sync with the code.
 * Fail-open: a missing chronicle or absent .git never breaks Ask-AI. */
const __dir = path.dirname(fileURLToPath(import.meta.url));
let CHRONICLE = '';
try {
  CHRONICLE = readFileSync(path.resolve(__dir, '../../../docs/chronicle.md'), 'utf8');
} catch { CHRONICLE = ''; }
let GIT_LOG = '';
try {
  GIT_LOG = execSync('git log --date=short --pretty=format:"%ad %h %s" -160', {
    cwd: path.resolve(__dir, '../../..'), timeout: 5000,
  }).toString();
} catch { GIT_LOG = ''; }

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
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

const MAX_TOOL_CALLS = 9; // discovery + retries need headroom (raised 18-Jul after a "could not answer")
const MAX_ROWS = 50;

const SCHEMA_DOC = `Database (PostgreSQL). You may read ONLY these:

mart.main_table — one row per past admission (the historical cohort base).
  Key columns: payor_bucket ('Cash'|'GIPSA Insurance'|'Non-GIPSA Insurance'|'Corporate'|'International'),
  curated_template_names_jsonb (jsonb array of procedure-template names — match with: curated_template_names_jsonb ? 'Template Name',
  or unnest via jsonb_array_elements_text), fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin (the bill total used everywhere),
  is_daycare_broad (boolean), los_days, icu_days, ot_hours numeric columns may vary — discover with information_schema when unsure.
  Template names are FORMAL (e.g. 'TOTAL KNEE REPLACEMENT (TKR) - BILATERAL', 'Robotic TKR Bilateral'). You NEVER know the
  exact spelling in advance — ALWAYS start with a discovery query, e.g.:
  SELECT DISTINCT t FROM mart.main_table, jsonb_array_elements_text(curated_template_names_jsonb) t WHERE t ILIKE '%KNEE%' LIMIT 30
  then use the exact names it returns.

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
fc.service_tariff_rate_matrix / fc.consultation_tariff_rate_matrix — per-tariff service/consultation rates
  (⚠ some packages carry duplicate TR1 rows at ₹10 — placeholders, not prices).

ROBOTIC classification tables (per-admission and per-family):
fc.robotic_admission_classification — one row per admission with any robotic signal: ip_no (join to
  mart.main_table.admission_no), robotic_billed (boolean — the flag flow-2 uses for its "Robotic" filter),
  payor_bucket, package_code/name, robotic_amount.
fc.robotic_family_classification — per (family, payor_group): robotic_presence_rate, robotic_admission_rate/cases,
  robotic_capable, robotic_default_included.
fc.robotic_package_classification — per (tariff_code, package_code): is_robotic_package, robotic_addon_* fields.

mart.main_table also carries per-admission stay fields the LOS logic uses: los_days (raw, fractional),
ward_days, icu_days, normalized_billable_stay_days (CEIL-style billable nights — what flow-2 case sets aggregate)
+ normalized_billable_stay_reason, is_daycare_broad, date_of_admission/discharge, department_name, doctor_name,
patient_name, umr_no, package_code/package_name.
To REPRODUCE a flow-2 case set (e.g. "the 7 robotic conventional-TKR cases"): match the family's template name in
curated_template_names_jsonb, filter payor_bucket, join fc.robotic_admission_classification r ON r.ip_no =
m.admission_no AND r.robotic_billed for the robotic subset, and read los_days vs normalized_billable_stay_days.

DISCOVERY: these notes are not exhaustive — for anything else, or when a column errors, discover live:
SELECT table_name FROM information_schema.tables WHERE table_schema IN ('fc','mart') and
SELECT column_name FROM information_schema.columns WHERE table_schema='…' AND table_name='…'.
NEVER answer "cannot produce from the data" until a discovery query has been tried.

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

const res2text = (res) => (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');

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
export async function askData({ question, history = [], context, screenshot, images }) {
  const system = `You are the AI assistant inside a hospital cost-estimate builder, answering the financial counselor's questions, at a hospital in Hyderabad, India.

You can query the engine's database with the run_sql tool (read-only). Use it whenever the answer needs data that is not
already in the provided context — counts, history, packages, tariffs, past bills. Prefer 1–3 focused queries over many.

${SCHEMA_DOC}

${LOGIC_DOC}

${CHRONICLE ? `PROJECT CHRONICLE — the dated decision history of this estimate builder. Use it for "why is the logic like this",
"what was it before", "when did it change", "what did the manager ask" questions. Cite the dates and manager inputs it
records (e.g. "since 18-Jul per the manager's 17-Jul directive; before that it was …"). For the current VALUE of something,
still prefer a live query; use the chronicle for the story behind it.

${CHRONICLE}` : ''}

${GIT_LOG ? `RECENT ENGINE COMMITS (newest first, auto-refreshed each deploy) — fine-grained change history; commit messages
name the manager input that drove them:

${GIT_LOG}` : ''}

Answer rules:
- FIRST re-read the user's question and enumerate its parts. Your final answer MUST address each part in the order asked — a common failure is answering only the part your queries covered and silently dropping the how/why part. How/why parts are answered from the engine-logic notes above; data parts from queries.
- Names in the catalog are formal: expand abbreviations before searching (TKR → TOTAL KNEE REPLACEMENT, THR → TOTAL HIP REPLACEMENT, LSCS → CAESAREAN, URSL → URETEROSCOPIC LITHOTRIPSY, PCNL → PERCUTANEOUS NEPHROLITHOTOMY, CAG → coronary angiogram, D&C → dilatation curettage). If a search returns nothing, RETRY with broader single-word ILIKE patterns before concluding something does not exist — never conclude absence from one narrow query.
- Ground every figure in the context or your query results — never invent. Round amounts to whole rupees in Indian format (₹1,24,500).
- Keep answers short and concrete (2–6 sentences or a short list). If the data genuinely isn't there after broad retries, say so plainly.
- Never mention SQL or table names in the answer — speak in product terms (packages, past cases, tariffs).
- SCREENSHOTS: when the question carries images, READ them carefully first — extract the exact figures, codes, names and
  labels shown. For "is this right / why is this number X / data looks inconsistent" questions: (1) state what the
  screenshot shows, (2) verify the shown figures against live queries where possible, (3) explain WHERE each number comes
  from (which source, which logic — use the engine-logic notes and the chronicle), and (4) if something IS inconsistent,
  say plainly which side is wrong and why (known data issues: ₹10 placeholder rows, GIPSA classification gaps). Never
  wave a discrepancy away — either reconcile it with evidence or flag it as a genuine issue worth reporting.`;

  const contents = [];
  if (context) {
    contents.push({ role: 'user', parts: [{ text: `Current page context (JSON):\n${JSON.stringify(context)}` }] });
    contents.push({ role: 'model', parts: [{ text: 'Understood — I will answer from this context and the database.' }] });
  }
  for (const m of history) {
    if (m?.text) contents.push({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 4000) }] });
  }
  // images: screenshots the user attached to THIS question (multi-image, 18-Jul);
  // `screenshot` stays as the single-image back-compat field from the docks.
  const imgs = [
    ...(Array.isArray(images) ? images : []),
    ...(screenshot?.data ? [screenshot] : []),
  ].filter((im) => im?.data).slice(0, 6);
  contents.push({
    role: 'user',
    parts: [
      ...imgs.map((im) => ({ inlineData: { mimeType: im.mimeType || 'image/jpeg', data: im.data } })),
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
      let answer = parts.map((p) => p.text ?? '').join('').trim();
      // Completeness pass: with tool results in play the model reliably drops
      // the how/why half of multi-part questions — have it audit its own
      // answer against the question once, without tools.
      if (answer && queries.length) {
        try {
          const check = await ai.models.generateContent({
            model: MODEL,
            contents: [
              ...contents,
              { role: 'model', parts: [{ text: answer }] },
              {
                role: 'user',
                parts: [{ text: `Audit your answer against the user's question: "${question}". If it already addresses EVERY part (including any how/why part — use the engine-logic notes for those) AND contains no meta commentary (nothing about queries, tools, or instructions), reply with exactly: SAME. Otherwise reply with the complete corrected answer — the polished final text for the user, no meta commentary — and nothing else.` }],
              },
            ],
            config: { systemInstruction: system, temperature: 0.2, maxOutputTokens: 2048 },
          });
          const audited = (res2text(check) || '').trim();
          if (audited && audited !== 'SAME') answer = audited;
        } catch { /* keep the unaudited answer */ }
      }
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
    contents.push({ role: 'user', parts: responses });
  }
  return { answer: 'I could not produce an answer from the data.', queries };
}
