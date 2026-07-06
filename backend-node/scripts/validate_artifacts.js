/** Validate computed artifacts against the sample workbook's cached Reference values. */
import 'dotenv/config';
import fs from 'node:fs';
import { pool } from '../src/db/pool.js';
import {
  fetchCohortRows, basisCohorts, buildBasisSummary, buildServiceStats,
  buildPharmacyStats, buildActualBasisMetrics, buildPfPayorSummary, buildOtSlotMatrix,
} from '../src/modules/engine/artifacts.js';

const targets = JSON.parse(fs.readFileSync(new URL('../spec/reference_targets.json', import.meta.url)));

const WHERE = `package_name = 'ROBOTIC TKR - UNILATERAL - RIGHT' AND payor_bucket = 'Cash'`;

const close = (a, b, tol = 0.01) => Math.abs((a ?? 0) - (b ?? 0)) <= tol;

let pass = 0, fail = 0;
function check(label, got, want, tol = 0.01) {
  if (typeof want === 'number' ? close(got, want, tol) : got === want) { pass++; return true; }
  fail++;
  console.log(`  MISMATCH ${label}: got=${got} want=${want}`);
  return false;
}

const rows = await fetchCohortRows(WHERE, []);
console.log(`cohort rows: ${rows.length} (want 26)`);
const cohorts = basisCohorts(rows);

// --- 1. basis summary ---
console.log('\n== basis summary (Cash row) ==');
const summary = buildBasisSummary(cohorts);
const hdr = Object.values(targets.basis_summary_header);
const wantCash = Object.fromEntries(hdr.map((h, i) => [h, targets.basis_summary[0][i]]));
const gotCash = summary[0];
for (const k of ['cohort_size','cash_count','los_p25','los_p50','los_p75','icu_p25','icu_p50','icu_p75',
                 'ward_p25','ward_p50','ward_p75','ot_p25','ot_p50','ot_p75',
                 'service_line_p25','service_line_p50','service_line_p75',
                 'ip_drugs_p25','ip_drugs_p50','ip_drugs_p75',
                 'ip_consumables_p25','ip_consumables_p50','ip_consumables_p75',
                 'ot_drugs_p25','ot_drugs_p50','ot_drugs_p75',
                 'ot_consumables_p25','ot_consumables_p50','ot_consumables_p75',
                 'implants_p25','implants_p50','implants_p75',
                 'ip_drugs_day_p25','ip_drugs_day_p50','ip_drugs_day_p75',
                 'ip_consumables_day_p25','ip_consumables_day_p50','ip_consumables_day_p75']) {
  check(`summary.${k}`, gotCash[k], wantCash[k]);
}

// --- 2. service stats (Cash) ---
console.log('\n== service stats (Cash) ==');
const svc = await buildServiceStats(cohorts);
const svcHdr = Object.values(targets.service_stats_header);
const wantSvc = targets.service_stats
  .filter((r) => r[1] === 'Cash')
  .map((r) => Object.fromEntries(svcHdr.map((h, i) => [h, r[i]])));
const gotSvcMap = new Map(svc.filter((s) => s.basis_label === 'Cash').map((s) => [s.item_code, s]));
console.log(`  sample has ${wantSvc.length} Cash service rows; computed ${gotSvcMap.size} raw items`);
let svcHit = 0;
for (const w of wantSvc) {
  const g = gotSvcMap.get(w.item_code);
  if (!g) { console.log(`  MISSING item ${w.item_code} ${w.item_name}`); fail++; continue; }
  const ok =
    check(`svc.${w.item_code}.presence`, g.case_presence_rate, w.case_presence_rate, 0.01) &
    check(`svc.${w.item_code}.q50`, g.quantity_p50, w.quantity_p50, 0.01) &
    check(`svc.${w.item_code}.amt`, g.amount_cash_typical, w.amount_cash_typical, 0.01) &
    check(`svc.${w.item_code}.rate_single`, g.tariff_single, w.tariff_single ?? null, 0.01);
  if (ok) svcHit++;
}
console.log(`  service rows fully matching: ${svcHit}/${wantSvc.length}`);

// --- 3. actual basis metrics — ALL rows, all stats ---
console.log('\n== actual basis metrics (all bases × all fields) ==');
const act = buildActualBasisMetrics(cohorts);
const actHdr = Object.values(targets.actual_metrics_header); // key, basis_label, field_key, ?, min, max, average, p25, p50, p75
const gotAct = new Map(act.map((a) => [a.key, a]));
let actMiss = 0;
for (const r of targets.actual_metrics) {
  const w = Object.fromEntries(actHdr.map((h, i) => [h, r[i]]));
  const g = gotAct.get(r[0]);
  if (!g) { actMiss++; if (actMiss < 8) console.log(`  MISSING metric ${r[0]}`); fail++; continue; }
  for (const stat of ['min', 'max', 'average', 'p25', 'p50', 'p75']) {
    if (w[stat] !== undefined && w[stat] !== null) check(`act.${r[0]}.${stat}`, g[stat], w[stat], 0.02);
  }
}

// --- 4. PF summary — all bases, all columns ---
console.log('\n== PF payor summary ==');
const pf = buildPfPayorSummary(cohorts);
const pfHdr = Object.values(targets.pf_summary_header);
for (let i = 0; i < targets.pf_summary.length; i++) {
  const w = Object.fromEntries(pfHdr.map((h, j) => [h, targets.pf_summary[i][j]]));
  const g = pf.find((p) => p.payor_bucket === w.payor_bucket);
  if (!g) { fail++; console.log(`  MISSING pf ${w.payor_bucket}`); continue; }
  check(`pf.${w.payor_bucket}.count`, g.case_count, w.admission_count);
  const map = {
    pf_collectible_historical_total_p25: g.collectible_p25,
    pf_collectible_historical_total_p50: g.collectible_p50,
    pf_collectible_historical_total_p75: g.collectible_p75,
    pf_named_total_p25: g.named_p25, pf_named_total_p50: g.named_p50, pf_named_total_p75: g.named_p75,
    pf_general_needed_total_p25: g.general_needed_p25, pf_general_needed_total_p50: g.general_needed_p50,
    pf_general_needed_total_p75: g.general_needed_p75,
    surgeon_named_total_p25: g.roles.surgeon.p25, surgeon_named_total_p50: g.roles.surgeon.p50, surgeon_named_total_p75: g.roles.surgeon.p75,
    assistant_surgeon_named_total_p25: g.roles.assistant_surgeon.p25, assistant_surgeon_named_total_p50: g.roles.assistant_surgeon.p50, assistant_surgeon_named_total_p75: g.roles.assistant_surgeon.p75,
    anesthetist_named_total_p25: g.roles.anesthetist.p25, anesthetist_named_total_p50: g.roles.anesthetist.p50, anesthetist_named_total_p75: g.roles.anesthetist.p75,
    assistant_anesthetist_named_total_p25: g.roles.assistant_anesthetist.p25, assistant_anesthetist_named_total_p50: g.roles.assistant_anesthetist.p50, assistant_anesthetist_named_total_p75: g.roles.assistant_anesthetist.p75,
    consultant_or_physician_named_total_p25: g.roles.consultant_or_physician.p25, consultant_or_physician_named_total_p50: g.roles.consultant_or_physician.p50, consultant_or_physician_named_total_p75: g.roles.consultant_or_physician.p75,
  };
  for (const [col, got] of Object.entries(map)) {
    if (w[col] !== undefined && w[col] !== null) check(`pf.${w.payor_bucket}.${col}`, got, w[col], 1.0);
  }
}

// --- 5. OT slots — full ladder ---
console.log('\n== OT slot ladder (TR1) ==');
const slots = await buildOtSlotMatrix(['TR1']);
const slotMap = new Map(slots.map((s) => [s.matrix_key, s]));
const ladder = targets.ot_slots.filter((r) => typeof r[1] === 'number');
for (const r of ladder) {
  const [tariff, hours, mode, code, name, general, twin, single, icu] = r;
  const g = slotMap.get(`${tariff}|${mode}|${hours}`);
  if (!g) { fail++; console.log(`  MISSING slot ${tariff}|${mode}|${hours}`); continue; }
  check(`slot.${mode}.${hours}.code`, g.item_code, code);
  check(`slot.${mode}.${hours}.general`, g.general, general, 0.01);
  check(`slot.${mode}.${hours}.single`, g.single, single, 0.01);
  check(`slot.${mode}.${hours}.icu`, g.icu, icu, 0.01);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
await pool.end();
