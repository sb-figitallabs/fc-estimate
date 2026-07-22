/**
 * Equipment & manual add-ons — doc T18, manager 21-Jul.
 *
 * A GOVERNED manual add-on catalogue (OT/ward/ICU equipment, respiratory
 * support, bedside procedures, transport) — not a free tariff search. Each
 * add-on is STAFF-CONFIRMED (never a silent/auto charge), priced by its billing
 * BASIS, checked for VALID LOCATION and MUTUAL EXCLUSIONS, and separated into the
 * four financial columns (same model as the DNB tab, N1):
 *   expected_gross · included_in_package · separately_claimable · expected_patient_payable
 * so "excluded from package", "not covered", and "collect from patient" are never
 * conflated. Payer nuance: a consumable being "separately billed" ≠ "separately
 * payable by insurance".
 *
 * The governed catalogue MASTERS (billing basis, valid locations, admissibility,
 * rate source/effective date per code) are curated data — fetched from the tariff
 * dataset / past IPs (manager). This module provides the ENGINE MECHANICS and
 * prices FC-selected add-ons; unknown codes are priced from the tariff with a
 * flag. MRD/MRT is a NORMAL positive charge (manager), never a negative discount.
 *
 * Additive: attached as estimate.manual_addons; base estimate unchanged.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rate = (rateOf, code, room) => {
  const r = rateOf(code) || {};
  return Number(r[room]) || Number(r.general) || 0;
};

// A small governed seed of common add-ons (billing basis · valid locations ·
// mutual-exclusion group · insurer admissibility). Expand from the curated
// master as codes/rates are supplied.
const CATALOG = {
  HSP0042: { name: 'Ambulance / Transport', basis: 'per_km', locations: ['er', 'ward', 'icu'], mutex: null, admissible: 'often_non_payable' },
  EQP0018: { name: 'AngioJet Ultra Equipment', basis: 'per_event', locations: ['ot', 'cathlab'], mutex: 'equipment', admissible: 'rental_may_be_payable' },
  OTI0018: { name: 'Instrument Charges (Major)', basis: 'flat', locations: ['ot'], mutex: 'instrument', admissible: 'claimable' },
};
const BASIS_UNIT = { flat: 1, per_event: 1, per_hour: 1, per_day: 1, '12h': 1, '24h': 1, per_shock: 1, per_km: 1, editable: 1 };

/**
 * @param {object} p
 * @param {Array<{code:string, name?:string, basis?:string, qty?:number, location?:string, mutex?:string, admissible?:string}>} p.selections
 * @param {(code:string)=>object} p.rateOf
 * @param {string}  p.payorBucket
 * @param {boolean} [p.hasPackage]
 * @param {string}  [p.room]
 * @returns {null | object}
 */
export function buildManualAddons({ selections, rateOf, payorBucket, hasPackage, room = 'general' }) {
  if (!Array.isArray(selections) || !selections.length) return null;   // staff-selected only
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const insurance = /insurance|corporate/i.test(String(payorBucket || ''));
  const seenMutex = new Map();
  const conflicts = [];

  const add_ons = selections.map((sel) => {
    const code = String(sel.code || '').toUpperCase();
    const def = CATALOG[code] || {};
    const name = sel.name || def.name || code;
    const basis = sel.basis || def.basis || 'flat';
    const qty = Math.max(1, Number(sel.qty) || 1);
    const location = String(sel.location || '').toLowerCase();
    const mutex = sel.mutex || def.mutex || null;
    const admissible = sel.admissible || def.admissible || 'claimable';

    // mutual exclusion (e.g. generic vs specific instrument, half-day vs full-day)
    if (mutex) {
      if (seenMutex.has(mutex)) conflicts.push({ mutex, codes: [seenMutex.get(mutex), code], note: `Incompatible selections in the "${mutex}" group — pick one.` });
      else seenMutex.set(mutex, code);
    }
    // valid-location check
    const location_ok = !def.locations || !location || def.locations.includes(location);

    const unitRate = rate(rateOf, code, roomKey);
    const priced = unitRate > 0;
    const gross = priced ? round2(unitRate * qty * (BASIS_UNIT[basis] ?? 1)) : null;

    // four financial columns (N1 model)
    const included_in_package = hasPackage && sel.package_included ? gross : 0;
    const remainder = gross == null ? null : round2(gross - (included_in_package || 0));
    // insurer-admissible add-ons are separately claimable (patient 0); non-admissible
    // → patient-payable. "separately billed" consumable ≠ "separately payable".
    const admissibleToInsurer = insurance && admissible !== 'often_non_payable';
    const separately_claimable = admissibleToInsurer ? remainder : 0;
    const expected_patient_payable = admissibleToInsurer ? 0 : remainder;

    return {
      code, name, basis, qty, location: location || null, mutex,
      unit_rate: priced ? round2(unitRate) : null,
      status: priced ? 'priced' : 'CONTEXT_REQUIRED',
      staff_confirmation: 'mandatory',                 // never auto-charged
      location_ok,
      four_column: { expected_gross: gross, included_in_package, separately_claimable, expected_patient_payable },
      admissibility: admissible,
      note: !priced ? `${code} not on the payer tariff — supply the rate (master pending).`
        : (!location_ok ? `Not a valid location for ${code} (valid: ${(def.locations || []).join('/')}).` : undefined),
    };
  });

  const priced = add_ons.filter((a) => a.status === 'priced');
  const totals = {
    expected_gross: round2(priced.reduce((t, a) => t + (a.four_column.expected_gross || 0), 0)),
    included_in_package: round2(priced.reduce((t, a) => t + (a.four_column.included_in_package || 0), 0)),
    separately_claimable: round2(priced.reduce((t, a) => t + (a.four_column.separately_claimable || 0), 0)),
    expected_patient_payable: round2(priced.reduce((t, a) => t + (a.four_column.expected_patient_payable || 0), 0)),
  };

  return {
    active: true,
    model: 'governed_catalogue',
    suggestions: 'staff_confirmed_never_auto',
    add_ons,
    conflicts,                                         // incompatible combinations to block
    totals,                                            // four-column totals — additive, NOT folded into the base
    non_gipsa_resolution: 'organization/MOU → agreement → approved interpretation → historical fallback (labelled empirical)',
    notes: [
      'Manual add-ons are staff-confirmed suggestions — never silent/auto charges.',
      'Four columns keep "excluded from package" / "not covered" / "collect from patient" separate; "separately billed" ≠ "separately payable".',
      'MRD/MRT is a normal positive charge, never a negative discount.',
      'Governed catalogue masters (basis / locations / admissibility / rates) are curated from the tariff dataset + past IPs; unknown codes are flagged CONTEXT_REQUIRED.',
    ],
  };
}
