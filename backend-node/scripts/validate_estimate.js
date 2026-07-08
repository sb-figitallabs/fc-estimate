/** End-to-end engine validation: compute the robotic TKR cash estimate and
 *  compare every Line Item Detail cell + summary values with the sample workbook. */
import 'dotenv/config';
import fs from 'node:fs';
import { pool } from '../src/db/pool.js';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';

const t = JSON.parse(fs.readFileSync(new URL('../spec/sheet_targets.json', import.meta.url)));

const est = await buildEstimate({
  patient: {},
  clinical: { procedure: 'robotic_tkr_unilateral_right' },
  payment: { payor_bucket: 'Cash' },
  controls: { room_type: 'Single', estimate_mode: 'Typical' },
  // parity pin: the finalized workbook auto-included these two <90%-presence
  // residuals (its promotion bug, manager note i5.md). Engine default is now
  // Exclude; the sample's state is reproduced via explicit user selections.
  selections: { grouped: { 'Coagulation Tests': 'Include', 'Inflammatory Marker Tests': 'Include' } },
});

let pass = 0, fail = 0;
const close = (a, b, tol) => Math.abs((a ?? 0) - (b ?? 0)) <= tol;
function check(label, got, want, tol = 0.51) {
  if (typeof want === 'number' ? close(got, want, tol) : String(got ?? '') === String(want ?? '')) { pass++; return true; }
  fail++;
  console.log(`  MISMATCH ${label}: got=${got} want=${want}`);
  return false;
}

// --- drivers (Builder G10..G13, B10..D13) ---
console.log('== drivers ==');
const b = t.builder;
check('los.p25', est.drivers.los.p25, b.B10); check('los.p50', est.drivers.los.p50, b.C10);
check('los.p75', est.drivers.los.p75, b.D10); check('los.sel', est.drivers.los.selected, b.G10);
check('icu.p25', est.drivers.icu.p25, b.B11); check('icu.p50', est.drivers.icu.p50, b.C11);
check('icu.p75', est.drivers.icu.p75, b.D11); check('icu.sel', est.drivers.icu.selected, b.G11);
check('ward.p25', est.drivers.ward.p25, b.B12); check('ward.p50', est.drivers.ward.p50, b.C12);
check('ward.p75', est.drivers.ward.p75, b.D12); check('ward.sel', est.drivers.ward.selected, b.G12);
check('ot.p25', est.drivers.ot.p25, b.B13); check('ot.p50', est.drivers.ot.p50, b.C13);
check('ot.p75', est.drivers.ot.p75, b.D13); check('ot.sel', est.drivers.ot.selected, b.G13);
check('robotic.selection', est.resolved_context.robotic.selection, b.B8);
check('otslot.code', est.resolved_context.ot_slot?.code, b.B15);
check('otslot.label', est.resolved_context.ot_slot?.label, b.B16);

// --- line items: row-by-row vs LID rows 2..73 ---
console.log('== line items ==');
const lidRows = t.lid_rows.filter((r) => r.row <= 73);
console.log(`  sample rows: ${lidRows.length}, computed rows: ${est.line_items.length}`);
for (let i = 0; i < Math.min(lidRows.length, est.line_items.length); i++) {
  const w = lidRows[i], g = est.line_items[i];
  if (!check(`row${w.row}.name`, g.name, w.name)) continue;
  const cellMap = { N: ['general', 0], O: ['general', 1], P: ['general', 2], Q: ['twin', 0], R: ['twin', 1], S: ['twin', 2], T: ['single', 0], U: ['single', 1], V: ['single', 2] };
  for (const [col, [rk, mi]] of Object.entries(cellMap)) {
    if (typeof w[col] === 'number') check(`row${w.row}(${w.name}).${col}`, g.cells[rk][mi], w[col]);
  }
  for (const [col, sk] of [['W', 'general'], ['X', 'twin'], ['Y', 'single']]) {
    if (typeof w[col] === 'number') check(`row${w.row}(${w.name}).${col}`, g.selected[sk], w[col]);
  }
}
if (lidRows.length !== est.line_items.length) {
  console.log('  sample names:', lidRows.map((r) => r.name).join(' | ').slice(0, 400));
  console.log('  computed names:', est.line_items.map((r) => r.name).join(' | ').slice(0, 400));
  fail++;
}

// --- totals ---
console.log('== totals ==');
const r74 = t.lid_rows.find((r) => r.row === 74), r75 = t.lid_rows.find((r) => r.row === 75);
check('subtotal.W', est.subtotal.selected.general, r74.W);
check('subtotal.X', est.subtotal.selected.twin, r74.X);
check('subtotal.Y', est.subtotal.selected.single, r74.Y);
check('grand.W', est.grand_total.selected.general, r75.W);
check('grand.X', est.grand_total.selected.twin, r75.X);
check('grand.Y', est.grand_total.selected.single, r75.Y);
check('FINAL ESTIMATE', est.final_estimate, t.estimate_summary.E2);

// bucket totals vs Estimate Summary B13..B20
const es = t.estimate_summary;
const bt = est.bucket_totals;
check('bucket.Room', bt['Room Charges'], es.B13);
check('bucket.Investigations (incl residuals)', (bt['Investigations'] ?? 0), es.B14);
check('bucket.ProcOT', bt['Procedure / OT Charges'], es.B15);
check('bucket.Bedside', bt['Bedside Services'], es.B16);
check('bucket.Pharmacy', bt['Pharmacy'], es.B17);
check('bucket.DrugAdmin', bt['Drug Administration Charges'], es.B18);
check('bucket.PF', bt['Professional Fees'], es.B19);
check('bucket.Optional', bt['Optional Add-Ons'] ?? 0, es.B20);

// --- add-ons order ---
console.log('== add-ons ==');
check('addons.count', est.add_ons.length, t.addons.length);
for (let i = 0; i < Math.min(est.add_ons.length, t.addons.length); i++) {
  check(`addon[${i}]`, est.add_ons[i].code, t.addons[i].code);
}

// --- grouped residuals ---
console.log('== grouped residuals ==');
check('grouped.count', est.grouped_adjustments.length, t.grouped.length);
for (const w of t.grouped) {
  const g = est.grouped_adjustments.find((x) => x.grouping === w.grouping);
  if (!g) { fail++; console.log(`  MISSING grouped ${w.grouping}`); continue; }
  check(`grp.${w.grouping}.presence`, g.presence / 100, w.presence, 0.001);
  check(`grp.${w.grouping}.p25`, g.p25Exact, w.p25);
  check(`grp.${w.grouping}.p50`, g.p50Exact, w.p50);
  check(`grp.${w.grouping}.p75`, g.p75Exact, w.p75);
  check(`grp.${w.grouping}.captured`, g.captured, w.captured);
  check(`grp.${w.grouping}.sel`, g.selected, w.sel);
}

// --- advanced OT shortlist ---
console.log('== advanced OT shortlist ==');
const sl = est.advanced_controls.ot_consumables.shortlist;
check('shortlist.count', sl.length, t.advanced.length);
for (let i = 0; i < Math.min(sl.length, t.advanced.length); i++) {
  check(`shortlist[${i}].name`, sl[i].item_name, t.advanced[i].name);
  check(`shortlist[${i}].F`, sl[i].expected_contribution, t.advanced[i].F, 0.51);
}
check('otApplied', est.advanced_controls.ot_consumables.applied, 72382.9);
check('implantResolved', est.advanced_controls.implants.resolved, 89130.16);

// --- service line count ---
console.log('== service line count ==');
check('slc.current', est.service_line_count.current, 37);
check('slc.status', est.service_line_count.status.toLowerCase().includes('within'), true);

console.log(`\nPASS=${pass} FAIL=${fail}`);
await pool.end();
