/**
 * Insurance edge-case suite — exercises the /api/estimate/build surface with
 * every insurance-policy shape a user can enter (caps, copay, sub-limits,
 * top-ups, exhaustion, upgrades, daycare, no-package families) and asserts
 * settlement invariants. Emits:
 *   test_results/insurance_edge_results.json  (raw, feeds the PDF report)
 *   ~/Downloads/handoof/INSURANCE_EDGE_BUGS.md (auto-written failures)
 * Usage: API=http://localhost:3199 node scripts/edge_insurance_suite.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const API = process.env.API || 'http://localhost:3199';
const THR = { clinical: { procedure: 'total_hip_replacement_thr_hemiarthroplasty' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG55' }, controls: { room_type: 'Single' } };
const TKR = { clinical: { procedure: 'total_knee_replacement_unilateral' }, payment: { payor_bucket: 'Non-GIPSA Insurance', organization_cd: 'ORG59' }, controls: { room_type: 'Twin Sharing' } };

const CASES = [
  // ── policy archetypes ──
  { id: 'T01', name: 'Corporate-style: big SI, no cap, no copay', base: THR, ins: { base_sum_insured: 2000000 } },
  { id: 'T02', name: 'Retail plain: SI 5L only', base: THR, ins: { base_sum_insured: 500000 } },
  // ── room-rent caps ──
  { id: 'T03', name: 'Absolute cap ₹2,000/day (breached)', base: THR, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'absolute', value: 2000 } } },
  { id: 'T04', name: 'Absolute cap ₹20,000/day (not breached)', base: THR, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'absolute', value: 20000 } } },
  { id: 'T05', name: '1%/2% of SI cap, SI 3L (breached)', base: THR, ins: { base_sum_insured: 300000, room_rent_cap: { type: 'pct_of_si' } } },
  { id: 'T06', name: '1%/2% of SI cap, SI 10L (ward ok)', base: THR, ins: { base_sum_insured: 1000000, room_rent_cap: { type: 'pct_of_si' } } },
  { id: 'T07', name: 'Room-category tier cap, eligible General, in Single', base: THR, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'room_category' }, room_eligibility: 'General' } },
  { id: 'T08', name: 'Eligibility Twin, staying Single (upgrade, no cap)', base: THR, ins: { base_sum_insured: 500000, room_eligibility: 'Twin' } },
  // ── copay ──
  { id: 'T09', name: 'Copay 10%', base: THR, ins: { base_sum_insured: 500000, copay: { type: 'percentage', value: 10 } } },
  { id: 'T10', name: 'Copay 20% + cap ₹2,000/day (senior-citizen style)', base: THR, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'absolute', value: 2000 }, copay: { type: 'percentage', value: 20 } } },
  { id: 'T11', name: 'Absolute copay ₹50,000', base: THR, ins: { base_sum_insured: 500000, copay: { type: 'absolute', value: 50000 } } },
  { id: 'T12', name: 'Copay 100% (degenerate)', base: THR, ins: { base_sum_insured: 500000, copay: { type: 'percentage', value: 100 } } },
  // ── sub-limits ──
  { id: 'T13', name: 'Implant sub-limit ₹50k', base: THR, ins: { base_sum_insured: 1000000, sub_limits: [{ label: 'Implant cap', applies_to: 'implants', cap: 50000 }] } },
  { id: 'T14', name: 'Pharmacy ₹25k + investigations ₹500 sub-limits', base: THR, ins: { base_sum_insured: 1000000, sub_limits: [{ applies_to: 'pharmacy', cap: 25000 }, { applies_to: 'investigations', cap: 500 }] } },
  { id: 'T15', name: 'Procedure sub-limit ₹40k (surgery cap)', base: THR, ins: { base_sum_insured: 1000000, sub_limits: [{ applies_to: 'procedure', cap: 40000 }] } },
  { id: 'T16', name: 'Total claim sub-limit ₹2L', base: THR, ins: { base_sum_insured: 1000000, sub_limits: [{ applies_to: 'total', cap: 200000 }] } },
  { id: 'T17', name: 'All sub-limits + cap + 10% copay stacked', base: THR, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'absolute', value: 3000 }, copay: { type: 'percentage', value: 10 }, sub_limits: [{ applies_to: 'implants', cap: 100000 }, { applies_to: 'pharmacy', cap: 50000 }] } },
  // ── SI exhaustion & bonuses ──
  { id: 'T18', name: 'Tiny SI ₹1L (cover exhausted mid-claim)', base: THR, ins: { base_sum_insured: 100000 } },
  { id: 'T19', name: 'SI 5L, consumed 4.5L, NCB 50k (₹1L left)', base: THR, ins: { base_sum_insured: 500000, consumed: 450000, ncb: 50000 } },
  { id: 'T20', name: 'Fully consumed SI, no top-up (zero cover left)', base: THR, ins: { base_sum_insured: 500000, consumed: 500000 } },
  { id: 'T21', name: 'SI 0 (policy number without cover — degenerate)', base: THR, ins: { base_sum_insured: 0 } },
  // ── top-ups ──
  { id: 'T22', name: 'Standard top-up 5L, deductible 2L, base 2L consumed 1.5L', base: THR, ins: { base_sum_insured: 200000, consumed: 150000, top_up: { amount: 500000, type: 'standard', deductible: 200000 } } },
  { id: 'T23', name: 'Super top-up, same numbers (consumed counts toward deductible)', base: THR, ins: { base_sum_insured: 200000, consumed: 150000, top_up: { amount: 500000, type: 'super', deductible: 200000 } } },
  { id: 'T24', name: 'Top-up deductible ₹50L above claim (top-up never triggers)', base: THR, ins: { base_sum_insured: 100000, top_up: { amount: 1000000, type: 'standard', deductible: 5000000 } } },
  // ── other families / routes ──
  { id: 'T25', name: 'TKR + ICICI (Non-GIPSA package) + 10% copay + Twin room', base: TKR, ins: { base_sum_insured: 700000, copay: { type: 'percentage', value: 10 } } },
  { id: 'T26', name: 'Robotic TKR + New India (family with NO insurer package)', base: { clinical: { procedure: 'robotic_tkr_unilateral_right' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, controls: { room_type: 'Single' } }, ins: { base_sum_insured: 500000, room_rent_cap: { type: 'absolute', value: 5000 } } },
  { id: 'T27', name: 'Chemo daycare + Star (room N/A) + cap ₹4,000/day', base: { clinical: { procedure: 'chemotherapy_systemic_therapy_infusion_daycare' }, payment: { payor_bucket: 'Non-GIPSA Insurance', organization_cd: 'ORG61' }, controls: {} }, ins: { base_sum_insured: 300000, room_rent_cap: { type: 'absolute', value: 4000 }, copay: { type: 'percentage', value: 10 } } },
  { id: 'T28', name: 'LSCS + Star (insurer whose tariff has no LSCS package)', base: { clinical: { procedure: 'lscs_caesarean' }, payment: { payor_bucket: 'Non-GIPSA Insurance', organization_cd: 'ORG61' }, controls: { room_type: 'Single' } }, ins: { base_sum_insured: 400000 } },
  // ── input validation (should be rejected, not crash) ──
  { id: 'T29', name: 'Negative SI (must 400)', base: THR, ins: { base_sum_insured: -100 }, expectError: true },
  { id: 'T30', name: 'Sub-limit cap 0 (must 400 — zod positive())', base: THR, ins: { base_sum_insured: 500000, sub_limits: [{ applies_to: 'implants', cap: 0 }] }, expectError: true },
  // ── room-name spellings the schema itself documents ──
  { id: 'T31', name: 'room_type "TWIN SHARING" (documented full name)', base: { ...TKR, controls: { room_type: 'TWIN SHARING' } }, ins: { base_sum_insured: 700000 } },
  { id: 'T32', name: 'room_type "General Ward" (documented full name)', base: { ...TKR, controls: { room_type: 'General Ward' } }, ins: { base_sum_insured: 700000 } },
];

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const results = [];

for (const c of CASES) {
  const body = { ...c.base, insurance: c.ins };
  const t0 = Date.now();
  let est, status;
  try {
    const r = await fetch(`${API}/api/estimate/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    status = r.status;
    est = await r.json();
  } catch (e) { results.push({ ...c, status: 'FETCH_ERR', bugs: ['fetch failed: ' + e.message] }); continue; }

  const bugs = [];
  const warns = [];
  if (c.expectError) {
    if (status !== 400) bugs.push(`expected HTTP 400 validation error, got ${status} (${est?.error || ''})`);
    results.push({ id: c.id, name: c.name, input: c.ins, status, expectError: true, bugs, warns, ms: Date.now() - t0 });
    continue;
  }
  if (status !== 200) {
    results.push({ id: c.id, name: c.name, input: c.ins, status, bugs: [`HTTP ${status}: ${est?.error || ''}`], warns, ms: Date.now() - t0 });
    continue;
  }

  const s = est.insurance_settlement;
  const tot = est.package_offer?.coverage?.totals;
  const ps = est.package_offer?.insurance_settlement;
  const row = {
    id: c.id, name: c.name, input: c.ins, status,
    family: body.clinical.procedure, org: body.payment.organization_cd, bucket: body.payment.payor_bucket,
    room: body.controls.room_type || 'Daycare',
    without_package: est.final_estimate,
    with_package: tot?.with_package ?? null,
    package_amount: tot?.package_amount ?? null,
    settlement: s && !s.error ? {
      gross: s.gross, gross_admissible: s.gross_admissible,
      insurer_total: s.insurer_total, patient_total: s.patient?.total,
      tpa_approval: s.tpa_approval, top_up_claim: s.top_up_claim, base_available: s.base_available,
      ward_ratio: s.caps?.ward_ratio, copay: s.copay,
      patient: s.patient,
    } : { error: s?.error || 'missing' },
    pkg_settlement: ps && !ps.error ? { insurer_total: ps.insurer_total, patient_total: ps.patient_total, package_admissible: ps.package_admissible } : null,
    ms: Date.now() - t0, bugs, warns,
  };

  if (!s || s.error) bugs.push('settlement missing/error: ' + (s?.error || 'absent'));
  else {
    if (s.gross === 0 && est.final_estimate > 0)
      bugs.push(`settlement gross ₹0 while estimate is ₹${Math.round(est.final_estimate)} — room key '${body.controls.room_type}' not resolved, silent all-zero settlement`);
    // invariants
    if (!near(s.check.insurer_plus_patient, s.check.gross_plus_upgrade)) bugs.push(`conservation broken: insurer+patient ${s.check.insurer_plus_patient} ≠ gross+upgrade ${s.check.gross_plus_upgrade}`);
    const cover = s.base_available + (c.ins.top_up?.amount || 0);
    if (s.insurer_total > cover + 0.01) bugs.push(`insurer_total ₹${s.insurer_total} exceeds total cover ₹${cover}`);
    if (s.patient.total < s.patient.nme - 0.01) bugs.push(`patient total ₹${s.patient.total} below NME ₹${s.patient.nme}`);
    for (const [k, v] of Object.entries(s.patient)) if (typeof v === 'number' && v < -0.01) bugs.push(`negative patient.${k} = ${v}`);
    if (s.insurer_total < -0.01) bugs.push(`negative insurer_total ${s.insurer_total}`);
    if (s.caps?.ward_ratio > 1.0001) bugs.push(`ward_ratio ${s.caps.ward_ratio} > 1`);
    if (c.ins.top_up && s.top_up_claim > c.ins.top_up.amount + 0.01) bugs.push(`top_up_claim ₹${s.top_up_claim} exceeds top-up SI ₹${c.ins.top_up.amount}`);
    if (c.ins.copay?.type === 'percentage' && !c.ins.sub_limits && !near(s.copay, s.gross_admissible * c.ins.copay.value / 100, 2))
      bugs.push(`copay ₹${s.copay} ≠ ${c.ins.copay.value}% of admissible ₹${s.gross_admissible}`);
    if (!near(s.insurer_total + s.patient.total, s.gross + (s.patient.room_upgrade_excess || 0), 2))
      bugs.push(`totals don't reconcile to gross`);
  }
  if (ps && !ps.error && row.with_package != null) {
    if (!near(ps.insurer_total + ps.patient_total, row.with_package, 2))
      bugs.push(`package settlement insurer ${ps.insurer_total} + patient ${ps.patient_total} ≠ with_package ${row.with_package}`);
    if (ps.insurer_total < -0.01 || ps.patient_total < -0.01) bugs.push('negative package settlement side');
  }
  if (row.with_package != null && row.without_package != null && row.with_package > row.without_package * 1.001)
    warns.push(`with_package ₹${Math.round(row.with_package)} > without ₹${Math.round(row.without_package)} — package extras not reduced by inclusions (curated-text coverage gap?)`);

  results.push(row);
  console.log(`${bugs.length ? '✗' : '✓'} ${c.id} ${c.name}${bugs.length ? ' — ' + bugs.join('; ') : ''}${warns.length ? '  ⚠ ' + warns.join('; ') : ''}`);
}

mkdirSync('test_results', { recursive: true });
writeFileSync('test_results/insurance_edge_results.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.bugs?.length);
const warned = results.filter((r) => r.warns?.length);
console.log(`\n${results.length} cases | bugs: ${failed.length} | warnings: ${warned.length}`);
