// Usage: node /private/tmp/fc-eval/extract.mjs fc|fb
// cwd must be anywhere; paths are absolute. Uses backend-node's node_modules + .env.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const BN = '/Users/apple/Downloads/handoof/backend-node';
const require = createRequire(BN + '/');
require('dotenv').config({ path: BN + '/.env' });
const { GoogleGenAI } = require('@google/genai');

const ai = process.env.VERTEX_AI_PROJECT
  ? new GoogleGenAI({ vertexai: true, project: process.env.VERTEX_AI_PROJECT, location: process.env.VERTEX_AI_LOCATION || 'global' })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.5-flash';

const MODE = process.argv[2]; // 'fc' | 'fb'
const ONLY = process.argv[3]; // optional single-file filter substring
const DIR = MODE === 'fc'
  ? '/Users/apple/Downloads/inputs/Old Financial Councellings'
  : '/Users/apple/Downloads/inputs/Old Final Bills';
const OUT = `/private/tmp/fc-eval/${MODE}_cases.jsonl`;
// For FB mode: only extract bills whose filename matches an FC (same 35 names)
const FC_DIR = '/Users/apple/Downloads/inputs/Old Financial Councellings';

const FC_PROMPT = `You are extracting structured data from a hospital FINANCIAL COUNSELLING (FC) estimate PDF from KIMS Hospitals.
Return ONLY a JSON object with exactly these keys (use null when absent, numbers as plain numbers without commas):
{
 "patient": string, "umr": string|null, "ip_no": string|null, "date": "DD-MM-YYYY"|null,
 "counselling_type": string|null,           // e.g. "Initial", "Recounselling"
 "care_management": "Surgical"|"Medical"|null,
 "estimate_type": "Package"|"Non Package"|null,
 "payment_mode": "Cash"|"Insurance"|string|null,
 "tpa": string|null,                        // TPA / insurance company name if stated
 "sum_insured": number|null,
 "surgery_name": string|null,               // the Surgery/Procedure field in the header
 "remarks_procedure_detail": string|null,   // the fuller surgery wording from Counsellor Remarks (e.g. "SURGERY:- ..."), just the procedure phrase, not the boilerplate terms
 "robotic_or_special_equipment": string|null, // any robotic / coblation / navigation / special equipment mention anywhere (quote the phrase), else null
 "los": number|null,                        // Length of Stay (days)
 "room": string|null,                       // the Room field value (may be a number of days or a room name)
 "icu": number|null,                        // ICU days if numeric, else null
 "eligible_room": string|null,              // Eligible Room / Room Tariff field
 "opted_room": string|null,                 // Room Opted field, or the room the remarks say the patient OPTED for
 "buckets": { "room": number|null, "investigation": number|null, "service": number|null, "pharmacy": number|null, "procedure": number|null, "misc": number|null, "consultation": number|null, "professional_fees": number|null },
   // from the 8-row estimate table: Room Charges / Investigation Charges / Service Charges / Pharmacy Charges / OT-Cath Lab Charges (=procedure) / Other Miscellaneous (=misc) / Consultation Fees / Professional Fees
 "sub_total": number|null,                  // Sub Total row if present, else sum of the 8 buckets
 "copay": number|null, "nme": number|null, "room_upgrade": number|null,  // Payable by Patient block if present
 "total_range": { "low": number|null, "high": number|null },  // "Total Estimated Amount: Rs. X - Y" (convert lakh shorthand if needed)
 "remarks_other_notes": string|null         // any OTHER case-specific info in remarks worth knowing: bed capping, package amount quotes, room upgrade notes, second procedure, insurance approval notes. NOT the standard boilerplate T&C.
}`;

const FB_PROMPT = `You are extracting structured data from a hospital IN-PATIENT FINAL BILL PDF from KIMS Hospitals.
The bill is either a package bill ("IP Package Detailed Bill", with a package block + excluded items) or an open itemized bill ("In Patient Final Bill Detailed").
Return ONLY a JSON object with exactly these keys (numbers plain, no commas; null when absent):
{
 "ip_no": string|null,          // Admission No
 "umr": string|null,
 "patient": string,
 "organization": string|null,   // the paying Organization / insurer name if printed (package bills usually show it), null for pure cash bills
 "admit_date": "DD-MMM-YYYY"|null, "discharge_date": "DD-MMM-YYYY"|null,
 "actual_los_days": number|null,  // discharge date minus admit date in days (calendar-day difference, minimum 1 if same day)
 "admitted_ward": string|null,    // e.g. "TWIN SHARING / 403A"
 "bill_type": "package"|"open",
 "package": { "code": string|null, "name": string|null, "amount": number|null, "concession": number|null } | null,
 "extra_procedure_lines": [string], // any surgery/procedure line items OUTSIDE the package (or notable procedure lines in an open bill) that indicate additional procedures, e.g. "ADENOIDECTOMY (RS.40100-50%)"; [] if none
 "category_totals": {             // the bold category header totals as printed on the bill; null if that category absent
   "ward_room": number|null,      // Ward Charges / Room Charges
   "professional": number|null,   // Professional Charges
   "consultation": number|null,   // Consultation Charges
   "service": number|null,        // Service Charges
   "investigation": number|null,  // Laboratory / Investigation Charges
   "pharmacy": number|null,       // Pharmacy Charges (all pharmacy incl OT pharmacy, net of returns)
   "ot": number|null,             // OT Charges (incl OT INSTRUMENTS if grouped there)
   "other": number|null           // anything else excluding food & beverages
 },
 "fnb_amount": number|null,       // FOOD AND BEVERAGES total
 "gross_amount": number|null,     // Gross / Total Bill Amount
 "concession_amount": number|null,
 "net_amount": number|null,       // Net Amount / Total Bill after concession
 "patient_payable": number|null,  // Patient Payable if split is printed (insurance bills), else null
 "org_payable": number|null,      // Organization/Org Payable if printed, else null
 "notes": string|null             // anything unusual: multiple packages, discounted second procedure lines, refunds
}`;

async function extractOne(file) {
  const data = fs.readFileSync(path.join(DIR, file)).toString('base64');
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'application/pdf', data } },
      { text: (MODE === 'fc' ? FC_PROMPT : FB_PROMPT) },
    ] }],
    config: { responseMimeType: 'application/json', temperature: 0 },
  });
  const text = res.text;
  let obj;
  try { obj = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); obj = JSON.parse(m[0]); }
  obj.file = file;
  return obj;
}

const norm = (s) => s.replace(/\.pdf$/i, '').replace(/\b(FC|FB)\b/gi, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

async function main() {
  let files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (MODE === 'fb') {
    const fcNames = new Set(fs.readdirSync(FC_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).map(norm));
    files = files.filter((f) => fcNames.has(norm(f)));
  }
  if (ONLY) files = files.filter((f) => f.toLowerCase().includes(ONLY.toLowerCase()));
  const done = new Set();
  if (fs.existsSync(OUT)) for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (line.trim()) done.add(JSON.parse(line).file);
  }
  const todo = files.filter((f) => !done.has(f));
  console.log(`${MODE}: ${files.length} files, ${done.size} done, ${todo.length} to extract`);
  const CONC = 3;
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const f = todo[idx++];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const obj = await extractOne(f);
          fs.appendFileSync(OUT, JSON.stringify(obj) + '\n');
          console.log('ok', f);
          break;
        } catch (e) {
          console.error(`FAIL(${attempt})`, f, e.message?.slice(0, 200));
          if (attempt === 3) fs.appendFileSync('/private/tmp/fc-eval/extract_errors.log', `${MODE} ${f} ${e.message}\n`);
          else await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
