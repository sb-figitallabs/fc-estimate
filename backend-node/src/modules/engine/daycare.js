/**
 * Daycare handling — doc T12, manager 21-Jul.
 *
 * Daycare is a STAY/BILLING MODIFIER, not a generic estimate — the treatment /
 * drug drives the cost (chemo P50 ₹25.4k vs immunotherapy ₹150.7k vs cystoscopy
 * ₹39.5k), so we route to the exact treatment/regimen cohort at current tariff,
 * never a single daycare median. Additive (estimate.daycare); base unchanged.
 *
 * Classifier fix (doc bug, reproduced 2026-07-22): calendar-date-only "same day"
 * over-counts strict daycare by including >12h cases (buggy 2,937 vs real
 * ≤12h 2,720 — 268 extended same-day cases wrongly counted as strict). We use a
 * real 12-hour threshold and split four statuses:
 *   strict_daycare              stay ≤ 12h
 *   extended_same_day_daycare   > 12h, same calendar date
 *   daycare_cross_midnight      different date, ≤ ~24h
 *   converted_to_inpatient      > ~24h (handled by the inpatient-conversion path)
 *
 * Rules:
 *   - Auto-daycare is a RECOMMENDATION TO CONFIRM, never inferred from
 *     "infusion / endoscopy / chemoport / Cat 1".
 *   - Positive daycare charge ROM0010 (rare RNS0075) — NEVER both.
 *   - DMO excluded (3/1,954 cases); nursing conditional (33.9%); never mix
 *     package + open-bill daycare histories; admin MSC10 is not a procedure.
 *   - Inpatient-conversion contingency: on conversion, RETAIN consumed daycare
 *     services + add ward/ICU from the conversion point + apply excess-LOS logic
 *     if packaged — not a continuation of daycare logic.
 *   - Oncology previous-cycle history only when regimen equivalence is confirmed
 *     (median cycle change 10.3%, P75 44.5%) — never copy the prior amount.
 */

/** classify a daycare stay by real hours + same-calendar-date (the 12h-threshold fix). */
export function classifyDaycareStatus(hours, sameDay) {
  if (hours == null) return 'strict_daycare';               // expected default
  if (hours <= 12) return 'strict_daycare';
  if (sameDay) return 'extended_same_day_daycare';
  if (hours <= 24) return 'daycare_cross_midnight';
  return 'converted_to_inpatient';
}

/**
 * @param {object} p
 * @param {boolean} p.isDaycare        setting resolved to daycare
 * @param {number}  [p.expectedHours]  expected stay hours (drives the status)
 * @param {boolean} [p.autoSuggested]  true if daycare was suggested (not FC-picked) → needs confirm
 * @param {boolean} [p.inpatientConversion]  model the conversion contingency
 * @param {boolean} [p.hasPackage]
 * @param {string}  [p.treatmentText]  drives the exact-cohort routing
 * @returns {null | object}
 */
export function buildDaycareModifier({ isDaycare, expectedHours, autoSuggested, inpatientConversion, hasPackage, treatmentText }) {
  if (!isDaycare) return null;
  const sameDay = expectedHours == null || expectedHours <= 24;
  const status = classifyDaycareStatus(expectedHours, sameDay);
  const strict = status === 'strict_daycare';

  return {
    active: true,
    model: 'stay_billing_modifier',        // NOT a generic estimate — treatment/drug drives the cost
    inference: 'none',                     // auto-daycare = recommendation to confirm
    confirmed: !autoSuggested,             // suggested → FC must confirm before it applies
    status,                                // strict / extended_same_day / cross_midnight / converted
    strict_daycare_upto_12h: strict,
    routing: 'exact_treatment_regimen_cohort_at_current_tariff',   // never a daycare median
    components: {
      daycare_charge: { code: 'ROM0010', alt_code: 'RNS0075', rule: 'exactly one — never both' },
      dmo: { included: false, reason: 'excluded — only 3/1,954 daycare cases' },
      nursing: { mode: 'conditional', historical_presence: 0.339 },
      admin_msc10: { is_procedure: false, note: 'MSC10 is administrative, not a procedure.' },
    },
    inpatient_conversion: (inpatientConversion || status === 'converted_to_inpatient') ? {
      active: true,
      note: 'On conversion: RETAIN the consumed daycare services, ADD ward/ICU room + care from the conversion point, and apply the excess-LOS logic if packaged — not a continuation of daycare logic.',
      excess_los_if_packaged: !!hasPackage,
    } : { active: false },
    oncology_cycle: /chemo|immunotherap|infusion|regimen/i.test(String(treatmentText || '')) ? {
      previous_cycle_reuse: 'only_if_regimen_equivalence_confirmed',
      note: 'Never copy the previous cycle amount just because the patient had prior chemo (median cycle change 10.3%, P75 44.5%). Confirm regimen equivalence.',
    } : null,
    flags: [
      'Daycare never uses a single generic average — price the exact treatment/regimen cohort at current tariff.',
      'Never mix package and open-bill daycare histories.',
      status === 'extended_same_day_daycare' ? 'Extended same-day (>12h) — NOT strict daycare (classifier fix).' : null,
    ].filter(Boolean),
    notes: [
      'Daycare is a stay/billing modifier — the treatment/drug drives the cost.',
      autoSuggested ? 'Daycare was auto-suggested — confirm before applying.' : 'Daycare confirmed by the FC.',
    ],
  };
}
