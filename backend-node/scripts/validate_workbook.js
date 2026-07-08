/**
 * Workbook parity validation: generate the robotic-TKR cash workbook and
 * compare every cell / formula / structure element against the reference
 * extraction (full_cell_data.json + parity_spec.json).
 *
 *   node scripts/validate_workbook.js
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { pool } from '../src/db/pool.js';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';
import { generateWorkbook } from '../src/modules/workbook/generateWorkbook.js';

const SCRATCH = '/private/tmp/claude-501/-Users-apple-workspace-code-Hospital_OS/7423305f-e4f7-4d04-b8a5-29b0983a823e/scratchpad';
const fullCells = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'full_cell_data.json'), 'utf8'));
const parity = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'parity_spec.json'), 'utf8'));

// ---------- 1. build + generate ----------
const input = {
  patient: {},
  clinical: { procedure: 'robotic_tkr_unilateral_right' },
  payment: { payor_bucket: 'Cash' },
  controls: { room_type: 'Single', estimate_mode: 'Typical' },
  // parity pin: reproduce the finalized workbook's (buggy) auto-inclusion of
  // these two <90% residuals via explicit selections (manager note i5.md)
  selections: { grouped: { 'Coagulation Tests': 'Include', 'Inflammatory Marker Tests': 'Include' } },
};
const estimate = await buildEstimate(input);
const { buffer } = await generateWorkbook(estimate, input);
fs.mkdirSync('output', { recursive: true });
const outPath = 'output/generated_robotic_tkr.xlsx';
fs.writeFileSync(outPath, buffer);
console.log(`generated ${outPath} (${buffer.length} bytes)`);

// ---------- 2. re-read + compare ----------
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(outPath);

const NUM_TOL = 0.51;
const WIDTH_TOL = 0.5;
const normF = (f) => String(f ?? '').replace(/^=/, '').replace(/\s+/g, '');
const isNum = (v) => typeof v === 'number';

const wantOrder = parity.workbook.sheet_names;
// extra sheets beyond the reference 16 (e.g. "Package Comparison") are allowed
const gotOrder = wb.worksheets.map((w) => w.name).slice(0, wantOrder.length);
console.log('\nsheet order (first 16):', JSON.stringify(gotOrder) === JSON.stringify(wantOrder) ? 'PASS' : `FAIL got=${gotOrder}`);

function cellParts(cell) {
  // -> {f?, v?} from an exceljs cell
  const v = cell.value;
  if (v === null || v === undefined) return {};
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return { f: v.formula ?? v.sharedFormula, v: v.result };
    if ('richText' in v) return { v: v.richText.map((t) => t.text).join('') };
    if ('error' in v) return { v: v.error };
    return { v };
  }
  return { v };
}

const totals = { formulas: [0, 0], statics: [0, 0], cached: [0, 0], structure: [0, 0] };
const summary = [];

for (const name of wantOrder) {
  const want = fullCells[name] || {};
  const spec = parity.sheets[name];
  const ws = wb.getWorksheet(name);
  const mism = [];
  let pass = 0, fail = 0;
  const bad = (kind, msg) => { fail++; totals[kind][1]++; if (mism.length < 10) mism.push(msg); };
  const ok = (kind) => { pass++; totals[kind][0]++; };

  if (!ws) { summary.push([name, 0, 1, ['SHEET MISSING']]); continue; }

  // --- cells ---
  const seen = new Set();
  for (const [addr, raw] of Object.entries(want)) {
    seen.add(addr);
    const got = cellParts(ws.getCell(addr));
    const wf = raw !== null && typeof raw === 'object' && 'f' in raw ? raw.f : undefined;
    const wv = wf !== undefined ? raw.v : raw;
    if (wf !== undefined) {
      if (normF(got.f) !== normF(wf)) bad('formulas', `${addr} formula got=${JSON.stringify(got.f)} want=${JSON.stringify(wf)}`);
      else ok('formulas');
      // cached value.  NOTE: the exceljs READER drops falsy cached results
      // (0 / "") even though the written XML carries <v>0</v> — verified at
      // the raw-XML level.  Treat got=undefined as matching want 0/"".
      if (wv !== undefined && wv !== null) {
        const gv = got.v;
        const zeroDropped = gv === undefined && (wv === 0 || wv === '');
        if (zeroDropped || (isNum(wv) && isNum(gv) ? Math.abs(gv - wv) <= NUM_TOL : String(gv ?? '') === String(wv ?? ''))) ok('cached');
        else bad('cached', `${addr} cached got=${JSON.stringify(gv)} want=${JSON.stringify(wv)}`);
      }
    } else {
      const gv = got.v;
      const match = isNum(wv) && isNum(gv) ? Math.abs(gv - wv) <= NUM_TOL : String(gv ?? '') === String(wv ?? '') && (gv === undefined) === (wv === undefined);
      if (match) ok('statics');
      else bad('statics', `${addr} static got=${JSON.stringify(gv)} want=${JSON.stringify(wv)}`);
    }
  }
  // extra non-empty cells not in the reference
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const addr = cell.address;
      if (seen.has(addr)) return;
      const got = cellParts(cell);
      if (got.f !== undefined || (got.v !== undefined && got.v !== '')) {
        bad('statics', `${addr} EXTRA cell got=${JSON.stringify(got.f ?? got.v)}`);
      }
    });
  });

  // --- structure: widths / hidden ---
  for (const [letter, w] of Object.entries(spec.col_widths || {})) {
    const wantW = typeof w === 'object' ? w.width : w;
    const wantHidden = typeof w === 'object' ? !!w.hidden : false;
    const col = ws.getColumn(letter);
    if (Math.abs((col.width ?? 8.43) - wantW) <= WIDTH_TOL) ok('structure');
    else bad('structure', `col ${letter} width got=${col.width} want=${wantW}`);
    if (!!col.hidden === wantHidden) ok('structure');
    else bad('structure', `col ${letter} hidden got=${!!col.hidden} want=${wantHidden}`);
  }
  // row heights
  for (const [rowNo, h] of Object.entries(spec.row_heights || {})) {
    const got = ws.getRow(Number(rowNo)).height;
    if (got !== undefined && Math.abs(got - h) <= 0.11) ok('structure');
    else bad('structure', `row ${rowNo} height got=${got} want=${h}`);
  }
  // gridlines
  const gl = ws.views?.[0]?.showGridLines !== false;
  if (gl === !!spec.show_gridlines) ok('structure');
  else bad('structure', `gridlines got=${gl} want=${!!spec.show_gridlines}`);
  // autofilter
  const AUTOFILTERS = {
    'Grouping Review': 'A12:G16', 'Estimate Breakdown': 'A3:J90', 'Pharmacy Template': 'A3:R520',
    'Service Template': 'A3:P30', 'Pharmacy Metrics': 'A3:R29', 'IP FC Actuals': 'A4:AF30',
  };
  const wantAf = AUTOFILTERS[name] ?? null;
  const gotAfRaw = ws.autoFilter ?? null;
  const gotAf = gotAfRaw && typeof gotAfRaw === 'object' ? `${gotAfRaw.from}:${gotAfRaw.to}` : gotAfRaw;
  if ((gotAf ?? null) === wantAf || (!wantAf && !gotAf)) ok('structure');
  else bad('structure', `autofilter got=${JSON.stringify(gotAf)} want=${wantAf}`);
  // validations — compare as expanded cell sets grouped by (type, formula1):
  // exceljs stores/merges per-cell entries, so "B6 E6" or "E11:E13" may come
  // back as separate single-cell validations that are semantically identical.
  const expand = (sqref) => sqref.split(/\s+/).flatMap((part) => {
    const [a, b] = part.split(':');
    if (!b) return [a];
    const p = (s) => [s.match(/[A-Z]+/)[0], Number(s.match(/\d+/)[0])];
    const col = (s) => [...s].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);
    const letter = (n) => { let out = ''; while (n > 0) { out = String.fromCharCode(((n - 1) % 26) + 65) + out; n = Math.floor((n - 1) / 26); } return out; };
    const [c1, r1] = p(a), [c2, r2] = p(b);
    const cells = [];
    for (let c = col(c1); c <= col(c2); c++) for (let r = r1; r <= r2; r++) cells.push(`${letter(c)}${r}`);
    return cells;
  });
  const wantDVs = spec.data_validations || [];
  const gotModel = ws.dataValidations?.model || {};
  const sig = (type, f1) => `${type}::${normF(f1)}`;
  const wantSets = new Map(), gotSets = new Map();
  for (const dv of wantDVs) {
    const k = sig(dv.type, dv.formula1);
    wantSets.set(k, new Set([...(wantSets.get(k) ?? []), ...expand(dv.sqref)]));
  }
  for (const [sqref, m] of Object.entries(gotModel)) {
    const k = sig(m.type, m.formulae?.[0]);
    gotSets.set(k, new Set([...(gotSets.get(k) ?? []), ...expand(sqref)]));
  }
  for (const [k, wantSet] of wantSets) {
    const gotSet = gotSets.get(k) ?? new Set();
    const same = wantSet.size === gotSet.size && [...wantSet].every((c) => gotSet.has(c));
    if (same) ok('structure');
    else bad('structure', `validation ${k} cells got=${[...gotSet].join(',')} want=${[...wantSet].join(',')}`);
  }
  for (const k of gotSets.keys()) {
    if (!wantSets.has(k)) bad('structure', `validation ${k} EXTRA`);
  }

  summary.push([name, pass, fail, mism]);
}

// ---------- 3. report ----------
console.log('\n================ per-sheet results ================');
let allPass = 0, allFail = 0;
for (const [name, pass, fail, mism] of summary) {
  allPass += pass; allFail += fail;
  const pct = pass + fail ? ((pass / (pass + fail)) * 100).toFixed(2) : '100.00';
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} pass=${pass} fail=${fail} (${pct}%)`);
  for (const m of mism) console.log(`        ${m}`);
}
console.log('\n---- by category (pass/fail) ----');
for (const [k, [p, f]] of Object.entries(totals)) console.log(`${k.padEnd(10)} ${p}/${f}`);
const pct = ((allPass / (allPass + allFail)) * 100).toFixed(3);
console.log(`\nTOTAL pass=${allPass} fail=${allFail} → ${pct}%  (target ≥ 99.5%)`);

await pool.end();
