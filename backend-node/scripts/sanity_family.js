/**
 * Sanity validation for families WITHOUT a reference workbook.
 * Checks the estimate is internally consistent and sits inside the cohort's
 * actual historical band. Usage: node scripts/sanity_family.js <family> [payor]
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';
import { generateWorkbook } from '../src/modules/workbook/generateWorkbook.js';
import { getCohort } from '../src/modules/engine/cohort.js';

const family = process.argv[2] || 'total_hip_replacement_thr_hemiarthroplasty';
const payor = process.argv[3] || 'Cash';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const input = {
  patient: { name: 'Sanity Test' },
  clinical: { procedure: family },
  payment: { payor_bucket: payor },
  controls: { room_type: 'Single', estimate_mode: 'Typical' },
};
const est = await buildEstimate(input);
const ctx = est.resolved_context;

console.log(`== ${family} (${payor}) ==`);
console.log(`cohort: ${ctx.cohort_case_count} cases | basis: ${ctx.payer_bases?.service_basis?.selected_basis} (${ctx.payer_bases?.service_basis?.status})`);
console.log(`final estimate: ${est.final_estimate}`);

// 1. structural sanity
check('final estimate is finite & positive', Number.isFinite(est.final_estimate) && est.final_estimate > 0, String(est.final_estimate));
check('no NaN cells in line items', est.line_items.every((r) =>
  ['general', 'twin', 'single'].every((c) => r.cells[c].every((v) => Number.isFinite(v)))));
check('no negative bucket totals', Object.values(est.bucket_totals).every((v) => v >= -0.01),
  JSON.stringify(Object.fromEntries(Object.entries(est.bucket_totals).map(([k, v]) => [k, Math.round(v)]))));
check('drivers resolved', ['los', 'icu', 'ward'].every((k) => est.drivers[k]?.selected != null),
  `los=${est.drivers.los?.selected} icu=${est.drivers.icu?.selected} ward=${est.drivers.ward?.selected} ot=${est.drivers.ot?.selected}`);
check('Low ≤ Typical ≤ High (selected room)', (() => {
  const g = est.grand_total.single; return g[0] <= g[1] + 0.01 && g[1] <= g[2] + 0.01;
})(), est.grand_total.single.map((v) => Math.round(v)).join(' ≤ '));

// 2. against the cohort's actual historical band
const am = est.artifacts.actualMetrics.find((a) => a.key === `${ctx.payer_bases.pharmacy_basis.selected_basis}|total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin`);
if (am) {
  const inBand = est.final_estimate >= am.p25 * 0.6 && est.final_estimate <= am.p75 * 1.6;
  check('final estimate within 0.6×P25 .. 1.6×P75 of cohort actuals', inBand,
    `estimate ${Math.round(est.final_estimate)} vs actuals P25 ${Math.round(am.p25)} / P50 ${Math.round(am.p50)} / P75 ${Math.round(am.p75)}`);
}

// 3. sections populated
check('has template rows', est.line_items.some((r) => r.source === 'Template'),
  `${est.line_items.filter((r) => r.source === 'Template').length} template rows`);
check('has pharmacy rows with amounts', est.line_items.filter((r) => r.bucket === 'Pharmacy').every((r) => r.cells.single[1] >= 0)
  && est.bucket_totals['Pharmacy'] > 0, `pharmacy ₹${Math.round(est.bucket_totals['Pharmacy'] || 0)}`);
check('add-ons present', est.add_ons.length > 0, `${est.add_ons.length} optional add-ons`);
const famDef = await getCohort(family);
if (famDef.rows?.ot !== false) {
  check('OT slot resolved', !!ctx.ot_slot?.code, `${ctx.ot_slot?.label ?? 'none'}`);
}
if (famDef.rows?.cathLab === true) {
  const cath = est.line_items.find((r) => r.name === 'Cath Lab Charges');
  check('cath-lab row has amounts', (cath?.cells.general[1] ?? 0) > 0,
    `cath typ ₹${Math.round(cath?.cells.general[1] ?? 0)}`);
}
const hier = est.advanced_controls.implants.hierarchy;
if (famDef.implantProfile) {
  check('implant hierarchy non-empty', hier.families.length > 0,
    hier.families.map((f) => `${f.key}(${f.presence_rate}%)`).join(', ').slice(0, 140));
}
if (famDef.daycare) {
  check('daycare: room normalized', ctx.daycare === true && /Daycare/.test(ctx.room_type), ctx.room_type);
}

// 4. workbook generates
const t0 = Date.now();
const { buffer } = await generateWorkbook(est, input);
check('workbook generates', buffer.byteLength > 100000, `${Math.round(buffer.byteLength / 1024)} KB in ${Date.now() - t0} ms`);

console.log(`\nPASS=${pass} FAIL=${fail}`);
await pool.end();
process.exit(fail ? 1 : 0);
