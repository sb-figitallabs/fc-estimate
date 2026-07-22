/**
 * Outside-package LOS — doc T10, manager 21-Jul.
 *
 * Beyond the package LOS the package stays as the BASE charge; only incremental
 * excess-day care is added at actuals — the package and its 20/25/35% PF are
 * NEVER recomputed because the stay grew (aligns with the T1 extended-LOS visit
 * design). Additive (packageOffer.outside_package_los); base package total is
 * unchanged.
 *
 * Per excess day, add: room (ward/ICU), primary-physician visits (1 ward / 2
 * ICU), DMO (ward only), intensivist (ICU only), net IP pharmacy (RANGE),
 * medically-necessary investigations (RANGE), continuing cross-consults. Extra
 * surgeon visit if applicable. (966 overstay admissions; 97% had post-package
 * consultant charging.)
 *
 * Rules honoured:
 *   - Entitlement is per SETTING: unused ward days can't offset excess ICU days.
 *     Use the ward/ICU breakdown when available; when it isn't, use TOTAL excess
 *     LOS regardless of setting (manager).
 *   - A new procedure during the excess stay is SEPARATE treatment logic, not an
 *     excess-day charge (not modelled here — flagged).
 *   - No double-charge: an item excluded from day 1 is PACKAGE_EXCLUSION, never
 *     also POST_PACKAGE_LOS. Every line here is labelled POST_PACKAGE_LOS.
 *   - Drug-administration on excess pharmacy: CASH only (manager); never on
 *     insurance (conflicts with the DNB guidance).
 *   - "Outside package ≠ collect from patient" — insurer eligibility / NME /
 *     do-not-collect is applied AFTERWARD (this is a gross post-package add-on).
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rate = (rateOf, code, key) => Number((rateOf(code) || {})[key]) || 0;

/**
 * @param {object} p
 * @param {number} p.packageDurationDays  governed package LOS
 * @param {number} p.estimatedLos         estimated total stay
 * @param {number} [p.wardDays]           estimated ward days (breakdown)
 * @param {number} [p.icuDays]            estimated ICU days (breakdown)
 * @param {number} [p.packageWardDays]    package-defined ward days (breakdown)
 * @param {number} [p.packageIcuDays]     package-defined ICU days (breakdown)
 * @param {(code:string)=>object} p.rateOf
 * @param {string} p.room                 selected room key
 * @param {number} [p.physicianVisitRate] contracted visit rate for the treating dept
 * @param {string} p.payorBucket
 * @returns {null | object}
 */
export function buildOutsidePackageLos({
  packageDurationDays, estimatedLos, wardDays, icuDays, packageWardDays, packageIcuDays,
  rateOf, room = 'general', physicianVisitRate = 0, payorBucket,
}) {
  const pkgLos = Math.max(0, Number(packageDurationDays) || 0);
  const los = Math.max(0, Number(estimatedLos) || 0);
  if (!pkgLos || los <= pkgLos) return null;                 // no overstay → no overlay

  const hasBreakdown = wardDays != null && icuDays != null && (packageWardDays != null || packageIcuDays != null);
  let excessWard, excessIcu, basis;
  if (hasBreakdown) {
    excessWard = Math.max(0, (Number(wardDays) || 0) - (Number(packageWardDays) || 0));
    excessIcu = Math.max(0, (Number(icuDays) || 0) - (Number(packageIcuDays) || 0));
    basis = 'per_setting_ledger';                            // unused ward can't offset excess ICU
  } else {
    // no ward/ICU breakdown → total excess LOS regardless of setting (manager)
    excessWard = los - pkgLos; excessIcu = 0;
    basis = 'total_los_no_breakdown';
  }
  const excessDays = excessWard + excessIcu;
  if (excessDays <= 0) return null;

  const roomBedCode = room === 'single' ? 'ROM0036' : room === 'twin' ? 'ROM0024' : 'ROM0001';
  const components = [];
  const add = (name, code, qty, unit, note) => {
    if (qty <= 0) return;
    components.push({ name, code, qty, unit_rate: round2(unit), amount: round2(unit * qty), label: 'POST_PACKAGE_LOS', note });
  };

  // Ward excess days: room bed + DMO + 1 physician visit/day
  add(`Ward room (${excessWard}d excess)`, roomBedCode, excessWard, rate(rateOf, roomBedCode, 'general'), 'Excess ward days at the room bed rate.');
  add(`DMO (${excessWard}d)`, 'ROM0093', excessWard, rate(rateOf, 'ROM0093', 'general'), 'Ward only, once/day.');
  add(`Primary physician visit (ward, 1/day)`, 'VISIT', excessWard, physicianVisitRate, 'One ward visit per excess day.');

  // ICU excess days: ICU bed + intensivist + 2 physician visits/day
  add(`ICU (${excessIcu}d excess)`, 'ROM5009', excessIcu, rate(rateOf, 'ROM5009', 'icu') || rate(rateOf, 'ROM5009', 'general'), 'Excess ICU days.');
  add(`Intensivist (${excessIcu}d)`, 'ICC0002', excessIcu, rate(rateOf, 'ICC0002', 'icu') || rate(rateOf, 'ICC0002', 'general'), 'ICU only, once/day.');
  add(`Primary physician visit (ICU, 2/day)`, 'VISIT', excessIcu * 2, physicianVisitRate, 'Two ICU visits per excess day.');

  const deterministicTotal = components.reduce((t, c) => t + c.amount, 0);
  const isCash = /cash/i.test(String(payorBucket || ''));

  return {
    active: true,
    excess_days: excessDays,
    excess_ward_days: excessWard,
    excess_icu_days: excessIcu,
    basis,                                       // per_setting_ledger | total_los_no_breakdown
    package_pf_recomputed: false,                // NEVER — package PF is untouched
    label: 'POST_PACKAGE_LOS',
    components,
    deterministic_total: round2(deterministicTotal),
    // pharmacy + investigations are ranges, not exact numbers (doc)
    ranges: [
      { key: 'net_ip_pharmacy', status: 'range', per_day: true, drug_admin: isCash ? 'applies_on_excess_pharmacy' : 'not_applicable_insurance',
        note: isCash ? 'Net IP pharmacy per excess day (range). Drug-administration charge applies on outside-package pharmacy (cash only).' : 'Net IP pharmacy per excess day (range). No drug-administration charge on insurance (DNB).' },
      { key: 'investigations', status: 'range', per_day: true, note: 'Medically-necessary investigations during excess days (range).' },
    ],
    total: round2(deterministicTotal),           // deterministic add-on (ranges shown separately) — NOT folded into the package base
    collectability: 'apply_insurer_eligibility_after',   // outside-package ≠ collect from patient
    flags: [
      'A new procedure during the excess stay is SEPARATE treatment logic — not an excess-day charge.',
      'Continuing cross-consults during the excess stay are added via the cross-consultation component.',
      'Outside-package charges are gross; insurer eligibility / NME / do-not-collect is applied afterward.',
    ],
    notes: [
      'Package stays the base charge; only incremental excess-day care is added. Package PF is never recomputed.',
      basis === 'total_los_no_breakdown' ? 'No ward/ICU breakdown → total excess LOS used regardless of setting.' : 'Per-setting ledger: unused ward days do not offset excess ICU days.',
    ],
  };
}
