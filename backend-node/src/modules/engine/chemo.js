/**
 * Chemotherapy / systemic therapy — doc T13, manager 21-Jul.
 *
 * A dedicated systemic-therapy estimator: the drug/dose/brand/vial-count explains
 * almost all of the bill (pharmacy 0.97–0.99 correlated). Default routine chemo
 * to OPEN-BILL DAYCARE (none of 1,210 chemo admissions were packages).
 *
 * CONSERVATIVE build (manager-agreed, deep work held): add only what we are SURE
 * of — base daycare + PF — and leave the therapy drug cost to a STRUCTURED
 * user/doctor input (regimen / dose / vial / brand). The builder NEVER clinically
 * computes the dose (height/weight/BSA are context only — dose comes from the
 * treating team) and NEVER presents a generic "chemotherapy" total (the same
 * label ranges ₹22k Paclitaxel → ₹538k Atezolizumab+Bevacizumab). When the drug
 * is unknown, show "therapy drug cost pending" at low confidence.
 *
 * Validated 2026-07-22 (FC data): chemo FC estimates ARE created — 1,624
 * chemo/oncology admissions with an FC counselled amount (P50 ₹44.5k, range
 * ₹27k–₹627k). Procedure Name is mostly blank → today's estimate isn't driven by
 * a structured regimen field; that structured input is what this module adds.
 *
 * HELD per manager (not built here): the systemic-therapy drug/regimen master,
 * the pharmacy-price-coverage audit (6,132/11,254 items unpriced), and prior-
 * cycle auto-retrieval by UMR — pending the hospital's confirmation.
 *
 * Additive: attached as estimate.chemo; base estimate unchanged.
 */

const CHEMO_ROUTES = new Set(['routine_cytotoxic', 'immunotherapy_targeted', 'supportive_infusion_only', 'planned_inpatient', 'high_dose_bmt']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} p
 * @param {string} p.route            one of CHEMO_ROUTES
 * @param {Array<{drug:string, brand?:string, strength?:string, vials?:number, unit_price?:number}>} [p.regimenItems]
 *   structured, doctor/user-entered therapy drugs — NEVER clinically computed here
 * @param {Array<{name:string, amount?:number}>} [p.supportiveInfusions]  hydration/iron/bisphosphonate/GF/transfusion
 * @param {boolean} [p.chemoport]     chemoport insertion (a SEPARATE component)
 * @param {object}  [p.priorCycleRef] { bill?, note? } prior same-regimen cycle (rebuild, never copy)
 * @returns {null | object}
 */
export function buildChemo({ route, regimenItems = [], supportiveInfusions = [], chemoport, priorCycleRef }) {
  const r = String(route || '').toLowerCase();
  if (!r || !CHEMO_ROUTES.has(r)) {
    // still return a shell so the FC gets the structured form + guardrails
  }
  const isInpatient = r === 'planned_inpatient' || r === 'high_dose_bmt';

  // structured therapy drugs — priced ONLY when a unit price is supplied; else pending
  let anyPending = false;
  const therapy_drugs = regimenItems.map((it) => {
    const vials = Math.max(1, Number(it.vials) || 1);
    const priced = it.unit_price != null && Number(it.unit_price) > 0;
    if (!priced) anyPending = true;
    return {
      drug: it.drug, brand: it.brand || null, strength: it.strength || null, vials,
      unit_price: priced ? round2(it.unit_price) : null,
      amount: priced ? round2(Number(it.unit_price) * vials) : null,
      status: priced ? 'user_priced' : 'drug_cost_pending',   // no silent zero
      dose_source: 'treating_team',                            // never clinically computed here
    };
  });
  const therapyTotal = therapy_drugs.reduce((t, d) => t + (d.amount || 0), 0);
  const drugCostKnown = regimenItems.length > 0 && !anyPending;

  // supportive infusions kept SEPARATE from chemotherapy
  const supportive = supportiveInfusions.map((s) => ({ name: s.name, amount: s.amount != null ? round2(s.amount) : null, status: s.amount != null ? 'user_priced' : 'pending', separate_from_chemo: true }));

  return {
    active: true,
    route: CHEMO_ROUTES.has(r) ? r : 'unspecified',
    default_billing: isInpatient ? 'open_bill_inpatient' : 'open_bill_daycare',   // routine chemo → daycare
    routes_available: [...CHEMO_ROUTES],
    // what we are SURE of (auto): base daycare + PF are produced by the base
    // estimate; here we only mark them as the confident part.
    sure_components: ['base_daycare_or_ward', 'professional_fee'],
    // the therapy drug cost — structured, doctor/user input; never dose-computed
    therapy_drugs,
    therapy_total: round2(therapyTotal),
    drug_cost_status: drugCostKnown ? 'known_user_priced' : 'therapy_drug_cost_pending',
    confidence: drugCostKnown ? 'user_priced_regimen' : 'low_confidence_drug_pending',
    never_generic_total: true,                 // never a single "chemotherapy" figure
    // separate components (never hidden in the administration basket)
    chemoport: chemoport ? { component: 'separate', status: 'add_as_line', note: 'Chemoport insertion is a separate component, never inside the administration basket.' } : null,
    supportive_infusions: supportive,
    prior_cycle: priorCycleRef ? {
      anchor: 'best_but_rebuild_at_current_prices',
      reuse: 'rebuild_not_copy',
      note: 'Prior same-patient same-regimen cycle is the best anchor (median bill change 5.4%) — reprice drugs+services at current prices and apply the new dose/vial count; show what changed. Never copy the prior amount.',
      ...priorCycleRef,
    } : { available: false, note: 'Prior-cycle retrieval by UMR is not wired (held per manager); repeat patients may not need an FC estimate.' },
    held: [
      'systemic-therapy drug/regimen master (code/molecule/brand/strength/class) — not built (held).',
      'pharmacy-price-coverage audit (6,132/11,254 items unpriced) — held; unpriced items show last-observed provisional, require confirmation.',
      'prior-cycle auto-retrieval by UMR — held pending hospital confirmation.',
    ],
    notes: [
      'Only sure things are auto-added (base daycare + PF); the therapy drug cost is a structured doctor/user input.',
      'Dose is never clinically computed (height/weight/BSA are context only) — it comes from the treating team.',
      drugCostKnown ? 'Regimen priced from user-supplied unit prices.' : 'Therapy drug cost pending — low-confidence estimate; trigger the structured chemo form.',
    ],
  };
}
