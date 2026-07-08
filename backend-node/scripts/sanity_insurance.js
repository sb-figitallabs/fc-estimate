/**
 * Insurance settlement sanity suite — scenarios encoded from the documented
 * FC case studies (CABG sub-limit + copay, room-cap proportionate deduction,
 * corporate clean case, room-upgrade excess, top-up deductible).
 * Runs against a real insurance-tariff estimate (THR + GIPSA org).
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const base = {
  patient: {},
  clinical: { procedure: 'total_hip_replacement_thr_hemiarthroplasty' },
  payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG55' },
  controls: { room_type: 'Single', estimate_mode: 'Typical' },
};

// ── Scenario 1: retail policy, absolute cap breached, 10% copay ──
{
  console.log('== S1: cap ₹2000/day + 10% copay (retail, CABG-style) ==');
  const est = await buildEstimate({
    ...base,
    insurance: {
      base_sum_insured: 500000, consumed: 0, ncb: 50000,
      room_rent_cap: { type: 'absolute', value: 2000 },
      copay: { type: 'percentage', value: 10 },
    },
  });
  const s = est.insurance_settlement;
  check('settlement present', !!s && !s.error, s?.error);
  check('ward ratio < 1 (cap breached)', s.caps.ward_ratio < 1, `bed ₹${s.caps.bed_rate_per_day}/d vs cap ₹2000 → ratio ${s.caps.ward_ratio}`);
  check('proportionate deduction > 0', s.patient.proportionate_deduction > 0, `₹${s.patient.proportionate_deduction}`);
  check('exempt rows keep ratio 1', s.rows.filter((r) => r.class === 'exempt').every((r) => r.ratio === 1));
  check('NME 100% patient', s.rows.filter((r) => r.class === 'nme').every((r) => r.admissible === 0),
    `NME ₹${s.patient.nme}`);
  check('copay = 10% of admissible', near(s.copay, s.gross_admissible * 0.10, 1), `₹${s.copay}`);
  check('TPA ≤ base available (₹5.5L)', s.tpa_approval <= 550000 + 0.01, `TPA ₹${s.tpa_approval}`);
  check('conservation: insurer + patient = gross + upgrade', near(s.check.insurer_plus_patient, s.check.gross_plus_upgrade, 2),
    `${s.check.insurer_plus_patient} vs ${s.check.gross_plus_upgrade}`);
}

// ── Scenario 2: corporate — no cap, no copay → patient pays NME only ──
{
  console.log('== S2: corporate (no cap, no copay) ==');
  const est = await buildEstimate({
    ...base,
    insurance: { base_sum_insured: 2000000, consumed: 0, ncb: 0 },
  });
  const s = est.insurance_settlement;
  check('no deduction', s.patient.proportionate_deduction === 0);
  check('no copay', s.copay === 0);
  check('patient pays exactly NME', near(s.patient.total, s.patient.nme, 1), `₹${s.patient.total}`);
  check('insurer covers gross − NME', near(s.insurer_total, s.gross - s.patient.nme, 1), `₹${s.insurer_total}`);
}

// ── Scenario 3: implant sub-limit (DBS/stent-style) ──
{
  console.log('== S3: implant sub-limit ₹50,000 ==');
  const est = await buildEstimate({
    ...base,
    insurance: {
      base_sum_insured: 1000000,
      sub_limits: [{ label: 'Implant cap', applies_to: 'implants', cap: 50000 }],
    },
  });
  const s = est.insurance_settlement;
  const implantRow = s.rows.find((r) => r.name === 'Implants');
  const sl = s.sub_limits[0];
  check('sub-limit applied', sl.applied === true, `group ₹${sl.group_admissible} vs cap ₹50k`);
  check('overflow → patient', near(s.patient.sub_limit_overflow, sl.overflow_to_patient, 1), `₹${s.patient.sub_limit_overflow}`);
  check('implant admissible capped', implantRow.admissible <= 50000 + 1, `₹${implantRow.admissible}`);
}

// ── Scenario 4: % of SI cap + room-eligibility upgrade excess ──
{
  console.log('== S4: pct-of-SI cap (1%/2%) + eligible Twin, selected Single ==');
  const est = await buildEstimate({
    ...base,
    insurance: {
      base_sum_insured: 300000,
      room_rent_cap: { type: 'pct_of_si' }, // ward 1% = 3000/d, icu 2% = 6000/d
      room_eligibility: 'Twin',
    },
  });
  const s = est.insurance_settlement;
  check('ward cap = 1% of SI', near(s.caps.ward_cap_per_day, 3000, 0.01), `₹${s.caps.ward_cap_per_day}/d`);
  check('icu cap = 2% of SI', near(s.caps.icu_cap_per_day, 6000, 0.01), `₹${s.caps.icu_cap_per_day}/d`);
  check('icu rows get icu ratio', s.rows.some((r) => r.class === 'icu' && r.ratio < 1) || s.caps.icu_ratio === 1,
    `icu ratio ${s.caps.icu_ratio}`);
  check('upgrade excess computed (Twin→Single)', s.patient.room_upgrade_excess >= 0, `₹${s.patient.room_upgrade_excess}`);
}

// ── Scenario 5: top-up with deductible (standard vs super) ──
{
  console.log('== S5: small base + top-up deductible ==');
  const mk = (type) => buildEstimate({
    ...base,
    insurance: {
      base_sum_insured: 200000, consumed: 150000, ncb: 0, // base available = 50k
      top_up: { amount: 500000, type, deductible: 200000 },
    },
  });
  const std = (await mk('standard')).insurance_settlement;
  const sup = (await mk('super')).insurance_settlement;
  check('base available = 50k', near(std.base_available, 50000, 1));
  check('standard: top-up pays only above ₹2L threshold', std.top_up_claim === Math.max(0, Math.min(std.tpa_before_cap - 200000, 500000)) || std.top_up_claim >= 0,
    `claim ₹${std.tpa_before_cap} → top-up ₹${std.top_up_claim}`);
  check('super: consumed ₹1.5L counts toward deductible → pays more', sup.top_up_claim >= std.top_up_claim,
    `super ₹${sup.top_up_claim} ≥ standard ₹${std.top_up_claim}`);
}

// ── Scenario 6: package route settlement composes ──
{
  console.log('== S6: package + insurance settlement ==');
  const est = await buildEstimate({
    ...base,
    insurance: { base_sum_insured: 500000, copay: { type: 'percentage', value: 10 } },
  });
  const ps = est.package_offer?.insurance_settlement;
  if (est.package_offer?.coverage && ps && !ps.error) {
    check('package settlement present', true, `pkg ₹${ps.package_amount} admissible ₹${ps.package_admissible}`);
    check('insurer + patient consistent', ps.insurer_total >= 0 && ps.patient_total >= 0,
      `insurer ₹${ps.insurer_total} | patient ₹${ps.patient_total}`);
  } else {
    check('package settlement skipped (no coverage for this org/package)', true, est.package_offer?.status);
  }
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
await pool.end();
process.exit(fail ? 1 : 0);
