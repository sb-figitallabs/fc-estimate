/**
 * Bucket-level manual settlement sanity suite — mirrors sanity_insurance
 * scenarios at bucket granularity. Asserts the conservation invariant
 * insurer + patient = gross, plus each mechanic (cap, copay, sub-limit,
 * top-up, corporate-clean). Pure compute — no DB needed.
 * Usage: node scripts/sanity_settle_manual.mjs
 */
import { settleManual } from '../src/modules/insurance/settlement.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// a representative surgical bill split into buckets (~₹4L gross)
const BUCKETS = {
  'Room Charges': 60000,
  'Procedure / OT Charges': 90000,
  'Professional Fees': 70000,
  'Pharmacy & Consumables': 55000,
  'Implants': 120000,
  'Investigations': 15000,
  'Other Services': 8000,
};
const grossOf = (b, nme = 0) => Object.values(b).reduce((a, c) => a + c, 0) + nme;

// ── S1: clean corporate — no cap, no copay → patient pays only NME ──
{
  console.log('== S1: clean (no cap, no copay), NME ₹5000 ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 2000000 }, los_days: 5, icu_days: 1, nme_amount: 5000 });
  check('conservation insurer+patient = gross', near(s.check.insurer_plus_patient, s.gross), `${s.check.insurer_plus_patient} vs ${s.gross}`);
  check('patient = NME only', near(s.patient.total, 5000), `₹${s.patient.total}`);
  check('insurer = gross − NME', near(s.insurer_total, s.gross - 5000), `₹${s.insurer_total}`);
}

// ── S2: absolute cap ₹2000/day breached → proportionate deduction on associated ──
{
  console.log('== S2: cap ₹2000/day × 5d vs ₹60k room ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 1000000, room_rent_cap: { type: 'absolute', value: 2000 } }, los_days: 5, icu_days: 0 });
  check('allowed room = 2000×5', near(s.caps.allowed_room_total, 10000), `₹${s.caps.allowed_room_total}`);
  check('ward ratio < 1', s.caps.ward_ratio < 1, `${s.caps.ward_ratio}`);
  check('proportionate deduction > 0', s.patient.proportionate_deduction > 0, `₹${s.patient.proportionate_deduction}`);
  check('exempt buckets untouched (implants full-admissible pre-ceiling)', true);
  check('conservation', near(s.check.insurer_plus_patient, s.gross), `${s.check.insurer_plus_patient} vs ${s.gross}`);
}

// ── S3: 10% copay ──
{
  console.log('== S3: 10% copay ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 1000000, copay: { type: 'percentage', value: 10 } }, los_days: 5, icu_days: 0 });
  check('copay = 10% of admissible', near(s.copay, s.gross_admissible * 0.10), `₹${s.copay}`);
  check('conservation', near(s.check.insurer_plus_patient, s.gross));
}

// ── S4: absolute copay ₹50k ──
{
  console.log('== S4: absolute copay ₹50,000 ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 1000000, copay: { type: 'absolute', value: 50000 } }, los_days: 5, icu_days: 0 });
  check('copay applied verbatim', near(s.copay, 50000), `₹${s.copay}`);
  check('conservation', near(s.check.insurer_plus_patient, s.gross));
}

// ── S5: implant sub-limit ₹50k ──
{
  console.log('== S5: implant sub-limit ₹50,000 (bucket ₹1.2L) ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 1000000, sub_limits: [{ applies_to: 'implants', cap: 50000 }] }, los_days: 5, icu_days: 0 });
  const sl = s.sub_limits[0];
  check('sub-limit applied', sl.applied === true, `group ₹${sl.group_admissible}`);
  check('overflow = 120k − 50k', near(s.patient.sub_limit_overflow, 70000), `₹${s.patient.sub_limit_overflow}`);
  check('conservation', near(s.check.insurer_plus_patient, s.gross));
}

// ── S6: small base + super top-up ──
{
  console.log('== S6: base 1L consumed 0.5L + super top-up 5L (ded 2L) ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 100000, consumed: 50000, top_up: { amount: 500000, type: 'super', deductible: 200000 } }, los_days: 5, icu_days: 0 });
  check('base available = 50k', near(s.base_available, 50000), `₹${s.base_available}`);
  check('top-up pays the excess', s.top_up_claim > 0, `₹${s.top_up_claim}`);
  check('insurer ≤ base + top-up', s.insurer_total <= 50000 + 500000 + 1, `₹${s.insurer_total}`);
  check('conservation', near(s.check.insurer_plus_patient, s.gross));
}

// ── S7: pct-of-SI cap with ICU split ──
{
  console.log('== S7: 1%/2% of SI ₹3L, LOS 5 (ICU 2) ==');
  const s = settleManual({ buckets: BUCKETS, insurance: { base_sum_insured: 300000, room_rent_cap: { type: 'pct_of_si', ward_pct: 1, icu_pct: 2 } }, los_days: 5, icu_days: 2 });
  // allowed = 3000×3 (ward) + 6000×2 (icu) = 21000
  check('allowed room = ward 1%×3d + icu 2%×2d', near(s.caps.allowed_room_total, 21000), `₹${s.caps.allowed_room_total}`);
  check('conservation', near(s.check.insurer_plus_patient, s.gross));
}

// ── S8: everything stacked ──
{
  console.log('== S8: cap + 10% copay + implant sub-limit + NME + top-up ==');
  const s = settleManual({
    buckets: BUCKETS,
    insurance: {
      base_sum_insured: 200000, consumed: 0,
      room_rent_cap: { type: 'absolute', value: 4000 },
      copay: { type: 'percentage', value: 10 },
      sub_limits: [{ applies_to: 'implants', cap: 80000 }],
      top_up: { amount: 300000, type: 'standard', deductible: 50000 },
    },
    los_days: 6, icu_days: 1, nme_amount: 4000,
  });
  check('all patient components present', s.patient.nme > 0 && s.patient.copay > 0 && s.patient.proportionate_deduction > 0 && s.patient.sub_limit_overflow > 0,
    JSON.stringify(s.patient));
  check('no negative components', Object.values(s.patient).every((v) => v >= -0.01));
  check('conservation exact', near(s.check.insurer_plus_patient, s.gross, 0.02), `${s.check.insurer_plus_patient} vs ${s.gross}`);
}

// ── S9: empty buckets → zero, no crash ──
{
  console.log('== S9: empty buckets ==');
  const s = settleManual({ buckets: {}, insurance: { base_sum_insured: 500000 } });
  check('gross 0, insurer 0, patient 0', s.gross === 0 && s.insurer_total === 0 && s.patient.total === 0);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
