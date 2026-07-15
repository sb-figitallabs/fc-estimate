// #7 (15-Jul flow doc): auto-verification harness — "when we have achieved
// this without any human intervention, our logic is working perfectly."
// For every family × payor group: build the estimate with ZERO manual input
// and check that the gross and every bucket fall inside the historic P25–P75
// band (same 75%/125% tolerance the UI warns at), plus the package-level
// conversion check. Prints a report of everything out of range.
import 'dotenv/config';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';
import { EstimateInput } from '../src/routes/estimate.routes.js';
import { listFamilies, familyPayorCounts } from '../src/modules/engine/cohort.js';
import { pool } from '../src/db/pool.js';

const TOTAL_FIELD = 'total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin';
// historic-metric field → estimate bucket name (mirrors the UI's HistoricPanel)
const FIELD_TO_BUCKET = {
  professional_fees: 'Professional Fees',
  investigations: 'Investigations',
  procedure_ot_charges: 'Procedure / OT Charges',
  room_charges: 'Room Charges',
  bedside_services: 'Bedside Services',
  pharmacy_total: 'Pharmacy',
};
const out = (v, p25, p75) => v != null && p25 != null && p75 != null && (v < p25 * 0.75 || v > p75 * 1.25);
const inr = (v) => `₹${Math.round(v).toLocaleString('en-IN')}`;

// GIPSA runs use a representative GIPSA org (TR290)
const GIPSA_ORG = process.env.VERIFY_GIPSA_ORG || 'ORG55';
const LIMIT = Number(process.env.VERIFY_LIMIT || 0); // 0 = all families

const families = listFamilies();
const counts = await familyPayorCounts().catch(() => null);
const runs = [];
for (const f of families.slice(0, LIMIT || families.length)) {
  runs.push({ family: f.family, label: f.label, payor: 'Cash' });
  if ((counts?.[f.family]?.['GIPSA Insurance'] ?? 0) >= 15) {
    runs.push({ family: f.family, label: f.label, payor: 'GIPSA Insurance', org: GIPSA_ORG });
  }
}
console.log(`verifying ${runs.length} builds (${families.length} families; GIPSA where ≥15 cases)…`);

const failures = [];
let ok = 0, buildFail = 0, done = 0;
for (const r of runs) {
  done++;
  if (done % 25 === 0) console.log(`  …${done}/${runs.length}`);
  let est;
  try {
    const input = EstimateInput.parse({
      clinical: { procedure: r.family },
      payment: { payor_bucket: r.payor, ...(r.org ? { organization_cd: r.org } : {}) },
      controls: { room_type: 'Single' },
    });
    est = await buildEstimate(input);
  } catch (err) {
    buildFail++;
    failures.push({ ...r, kind: 'BUILD_FAIL', detail: String(err.message).slice(0, 120) });
    continue;
  }
  if (!est?.final_estimate || !est.historic_metrics?.buckets) {
    buildFail++;
    failures.push({ ...r, kind: 'NO_METRICS', detail: est?.unresolved_items?.join(',') ?? 'no historic metrics' });
    continue;
  }
  const hb = est.historic_metrics.buckets;
  const issues = [];
  // gross vs historic total band
  const tot = hb[TOTAL_FIELD];
  if (tot && out(est.final_estimate, tot.p25, tot.p75)) {
    issues.push(`gross ${inr(est.final_estimate)} vs ${inr(tot.p25)}–${inr(tot.p75)}`);
  }
  // per-bucket
  for (const [field, bucket] of Object.entries(FIELD_TO_BUCKET)) {
    const m = hb[field];
    const v = est.bucket_totals?.[bucket];
    if (m && v != null && out(v, m.p25, m.p75)) {
      issues.push(`${bucket} ${inr(v)} vs ${inr(m.p25)}–${inr(m.p75)}`);
    }
  }
  // package conversion check (#8) — already computed by the engine
  const cc = est.package_offer?.conversion_check;
  if (cc?.status === 'out_of_range') {
    issues.push(`package conversion ${inr(cc.converted_total)} vs actual ${inr(cc.actual_band.p25)}–${inr(cc.actual_band.p75)} (${cc.actual_band.cases} bills)`);
  }
  if (issues.length) failures.push({ ...r, kind: 'OUT_OF_RANGE', detail: issues.join(' · ') });
  else ok++;
}

console.log(`\n===== VERIFICATION REPORT =====`);
console.log(`OK: ${ok} · out-of-range: ${failures.filter((f) => f.kind === 'OUT_OF_RANGE').length} · build failures: ${buildFail} · total: ${runs.length}`);
console.log(`\n--- out of range ---`);
for (const f of failures.filter((x) => x.kind === 'OUT_OF_RANGE')) {
  console.log(`${f.payor === 'Cash' ? 'CASH ' : 'GIPSA'} | ${f.label.slice(0, 45)} | ${f.detail}`);
}
console.log(`\n--- build failures ---`);
for (const f of failures.filter((x) => x.kind !== 'OUT_OF_RANGE')) {
  console.log(`${f.payor === 'Cash' ? 'CASH ' : 'GIPSA'} | ${f.label.slice(0, 45)} | ${f.kind}: ${f.detail}`);
}
await pool.end();
