/**
 * Normal-cases suite — every onboarded family × payor × room through
 * POST /api/estimate/build, asserting structural correctness of the numbers:
 *   band ordering (low ≤ typical ≤ high), bucket totals reconcile to the
 *   final, driver percentiles ordered, room-price monotonicity, no null/NaN
 *   amounts, daycare room handling, workbook generation.
 * Data oddities (package rate above cohort estimate, warnings, unresolved
 * items) are collected as FLAGS, not failures — they feed DATA_CONCERNS.md.
 * Usage: API=http://localhost:3199 node scripts/normal_suite.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const API = process.env.API || 'http://localhost:3199';
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const families = await (await fetch(`${API}/api/lookup/families`)).json();
const PKG_ORGS = { // families with insurer packages → orgs worth testing
  total_knee_replacement_unilateral: ['ORG55', 'ORG59', 'ORG61'],
  total_knee_replacement_bilateral: ['ORG55', 'ORG61'],
  total_hip_replacement_thr_hemiarthroplasty: ['ORG55', 'ORG59', 'ORG61'],
  lap_cholecystectomy: ['ORG55', 'ORG61'],
  lscs_caesarean: ['ORG55', 'ORG59'],
  ptca_single_vessel: ['ORG55', 'ORG59', 'ORG1197'],
};
const GIPSA = new Set(['ORG53', 'ORG54', 'ORG55', 'ORG56']);

let pass = 0, fail = 0;
const failures = [];
const flags = [];
const results = [];

async function runCase(fam, payor, org, room) {
  const label = `${fam.family} · ${payor}${org ? '/' + org : ''} · ${room || 'daycare'}`;
  const body = {
    clinical: { procedure: fam.family },
    payment: { payor_bucket: payor, ...(org ? { organization_cd: org } : {}) },
    controls: { ...(room ? { room_type: room } : {}) },
    ...(payor !== 'Cash' ? { insurance: { base_sum_insured: 500000 } } : {}),
  };
  let e, status;
  try {
    const r = await fetch(`${API}/api/estimate/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    status = r.status; e = await r.json();
  } catch (err) { fail++; failures.push(`${label}: fetch ${err.message}`); return; }

  const errs = [];
  if (status !== 200) errs.push(`HTTP ${status}: ${e?.error}`);
  else {
    const rk = e.resolved_context.room_key;
    if (!(e.final_estimate > 0)) errs.push(`final_estimate ${e.final_estimate}`);
    // band ordering per room
    for (const [k, band] of Object.entries(e.grand_total)) {
      if (k === 'selected') continue;
      if (!(band[0] <= band[1] + 0.01 && band[1] <= band[2] + 0.01)) errs.push(`band disorder ${k}: ${band.map(Math.round)}`);
    }
    // final == selected grand total for the room
    if (!near(e.final_estimate, e.grand_total.selected[rk], 1)) errs.push(`final ${e.final_estimate} ≠ grand_total.selected.${rk} ${e.grand_total.selected[rk]}`);
    // bucket totals reconcile
    const bsum = Object.values(e.bucket_totals).reduce((a, b) => a + b, 0);
    if (!near(bsum, e.final_estimate, 1)) errs.push(`bucket sum ${Math.round(bsum)} ≠ final ${Math.round(e.final_estimate)}`);
    // drivers percentile ordering
    for (const [k, d] of Object.entries(e.drivers || {})) {
      if (d && d.p25 != null && !(d.p25 <= d.p50 && d.p50 <= d.p75)) errs.push(`driver ${k} percentiles disorder ${d.p25}/${d.p50}/${d.p75}`);
    }
    // line items sane
    if (!e.line_items?.length) errs.push('no line items');
    const badAmt = (e.line_items || []).filter((r) => r.selected && (r.selected[rk] == null || Number.isNaN(Number(r.selected[rk]))));
    if (badAmt.length) errs.push(`${badAmt.length} rows with null/NaN amount for ${rk}: ${badAmt.slice(0, 3).map((r) => r.name).join(', ')}`);
    // daycare semantics
    if (fam.daycare && !/daycare/i.test(e.resolved_context.room_type)) errs.push(`daycare family but room_type ${e.resolved_context.room_type}`);
    // room monotonicity (typical): general ≤ twin ≤ single — data flag, not failure
    const t = e.grand_total;
    if (t.general && t.twin && t.single && !(t.general[1] <= t.twin[1] + 0.01 && t.twin[1] <= t.single[1] + 0.01))
      flags.push(`${label}: room prices not monotonic (G ${Math.round(t.general[1])} / T ${Math.round(t.twin[1])} / S ${Math.round(t.single[1])})`);
    // insurance settlement present when policy given
    if (body.insurance) {
      const s = e.insurance_settlement;
      if (!s || s.error) errs.push(`settlement missing/error: ${s?.error}`);
      else if (!near(s.check.insurer_plus_patient, s.check.gross_plus_upgrade, 2)) errs.push('settlement conservation broken');
    }
    // package sanity + data flags
    const tot = e.package_offer?.coverage?.totals;
    if (tot?.with_package != null) {
      if (tot.with_package > tot.without_package * 1.001)
        flags.push(`${label}: with-package ₹${Math.round(tot.with_package)} > itemized ₹${Math.round(tot.without_package)} (pkg ₹${Math.round(tot.package_amount)} — negotiated rate above cohort estimate${tot.package_amount > tot.without_package ? '' : ' or extras heavy'})`);
      if (tot.package_amount <= 1000)
        flags.push(`${label}: PLACEHOLDER package amount ₹${tot.package_amount} surfaced in estimate (${e.package_offer?.package?.package_code})`);
    }
    if (e.warnings?.length) flags.push(`${label}: warnings — ${e.warnings.join(' | ').slice(0, 160)}`);
    if (e.unresolved_items?.length) flags.push(`${label}: ${e.unresolved_items.length} unresolved items`);
  }

  results.push({ label, status, final: e?.final_estimate, package: e?.package_offer?.coverage?.totals ?? null, errs });
  if (errs.length) { fail++; failures.push(`${label}: ${errs.join('; ')}`); console.log(`✗ ${label} — ${errs.join('; ')}`); }
  else { pass++; console.log(`✓ ${label} — ₹${Math.round(e.final_estimate).toLocaleString('en-IN')}`); }
}

for (const fam of families) {
  const rooms = fam.daycare ? [null] : ['General', 'Twin', 'Single'];
  for (const room of rooms) await runCase(fam, 'Cash', null, room);
  const orgs = PKG_ORGS[fam.family] ?? (fam.daycare ? ['ORG61'] : []);
  for (const org of orgs) await runCase(fam, GIPSA.has(org) ? 'GIPSA Insurance' : 'Non-GIPSA Insurance', org, fam.daycare ? null : 'Single');
}

// workbook smoke — one cash, one daycare, one insurance
for (const wb of [
  { clinical: { procedure: 'total_knee_replacement_unilateral' }, payment: { payor_bucket: 'Cash' }, controls: { room_type: 'Single' } },
  { clinical: { procedure: 'chemotherapy_systemic_therapy_infusion_daycare' }, payment: { payor_bucket: 'Cash' }, controls: {} },
  { clinical: { procedure: 'total_hip_replacement_thr_hemiarthroplasty' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG55' }, controls: { room_type: 'Single' }, insurance: { base_sum_insured: 500000 } },
]) {
  const label = `workbook · ${wb.clinical.procedure} · ${wb.payment.payor_bucket}`;
  const r = await fetch(`${API}/api/estimate/workbook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wb) });
  const buf = await r.arrayBuffer();
  if (r.status === 200 && buf.byteLength > 100_000) { pass++; console.log(`✓ ${label} — ${(buf.byteLength / 1024).toFixed(0)} KB`); }
  else { fail++; failures.push(`${label}: HTTP ${r.status}, ${buf.byteLength} bytes`); console.log(`✗ ${label}`); }
}

mkdirSync('test_results', { recursive: true });
writeFileSync('test_results/normal_suite_results.json', JSON.stringify({ results, failures, flags }, null, 2));
console.log(`\nPASS=${pass} FAIL=${fail} | data flags: ${flags.length}`);
flags.forEach((f) => console.log('  ⚑', f));
process.exit(fail ? 1 : 0);
