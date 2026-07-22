/**
 * Newborn pathways — doc T6, manager 21-Jul.
 *
 * Four DISTINCT newborn pathways, never one "newborn" estimate. The word
 * "newborn" NEVER auto-adds a bed or PF — the FC explicitly selects a pathway
 * (provisionally healthy/well-baby, then confirms healthy-with-mother /
 * phototherapy / NICU / twins / in-mother's-package). Additive scenario
 * (`estimate.newborn`); never mutates the parity-pinned base estimate.
 *
 *   1. healthy_with_mother — ₹0 separate bed + neonatologist/paediatrician PF
 *      (history modes ₹8,000 / ₹4,000) + newborn screening + neonatal bilirubin
 *      + blood group. (125/127 no-declared-room cases had ₹0 room; median ₹0.)
 *   2. well_baby_package   — the maternal/well-baby package (PAE5048 1-day /
 *      PAE5049 2-day). If the baby sits inside the mother's delivery package,
 *      attach to it and add only excluded items — NO second room, NO separate
 *      newborn base package; twins never multiply a "single/twins" package.
 *   3. phototherapy        — per-day package (PAE5055 / PAE5061 double surface)
 *      or itemised (bed×days + PAE0006 + PF + investigations).
 *   4. nicu                — NICU bed from NICU room-service codes (ROM5015 …),
 *      NOT the generic icu_days field, × nicu_days + PF + investigations + pharmacy.
 *
 * Blocked (N3, carried as flags): no governed standalone newborn/phototherapy/
 * NICU package master beyond the 4 cash packages; no cradle service code
 * (baby-warmer must not substitute); mother–baby linkage is asked of the FC
 * (from an FC perspective), not a governed billing link.
 *
 * §4 validation targets (doc, his 13,974 DB): 144 healthy-newborn cohort, median
 * PF ₹8,000, cash bill P25/P50/P75 ≈ ₹9.2k/₹15.1k/₹18.9k. Our line data is
 * package-bill-only, so healthy-newborn (open-bill) history isn't fully
 * reproducible here — pathways are tariff/package-priced, not history-certified.
 */

// history-mode PF (no clean neonatology consult tariff code — doc historical modes)
const PF = { neonatologist: 8000, paediatrician: 4000 };
const yes = (v) => String(v || '').toLowerCase() === 'yes' || v === true;

function priceCode(rateOf, code, room, units = 1) {
  const r = rateOf(code) || {};
  const per = Number(r[room]) || Number(r.general) || 0;
  if (per <= 0) return { code, amount: null, context_required: true };
  return { code, amount: Math.round(per * units * 100) / 100, source: 'tariff', ...(r.tr1_fallback ? { tr1_fallback: true } : {}), units };
}

/**
 * @param {object} p
 * @param {object} p.inputs { pathway, stayDays, nicuDays, twins, inMotherPackage, phototherapyDoubleSurface }
 * @param {(code:string)=>object} p.rateOf
 * @param {string} p.room
 * @param {Object<string,{name:string,amount:number}>} p.newbornPackages  PAE5048/5049/5055/5061 from package_master
 */
export function buildNewbornScenario({ inputs = {}, rateOf, room = 'general', newbornPackages = {} }) {
  const pathway = String(inputs.pathway || 'none').toLowerCase();
  if (!pathway || pathway === 'none') return null;            // explicit selection only — never auto
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const days = Math.max(1, Number(inputs.stayDays) || 1);
  const twins = yes(inputs.twins);
  const components = [];
  const flags = [];
  let packageRef = null;

  const addInvestigations = () => {
    for (const [code, label] of [['BIO5229', 'Extended Newborn Screening'], ['BIO0240', 'Neonatal Bilirubin']]) {
      const p = priceCode(rateOf, code, roomKey);
      components.push({ key: code.toLowerCase(), name: label, code, amount: p.amount,
        status: p.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY', source: p.source ?? 'tariff' });
    }
    flags.push('Blood group investigation to be added per hospital protocol (small).');
  };
  const addPf = () => {
    components.push({ key: 'neonatologist_pf', name: 'Neonatologist PF', code: null, amount: PF.neonatologist, source: 'history_mode', provenance: 'doc historical mode ₹8,000' });
    components.push({ key: 'paediatrician_pf', name: 'Paediatrician PF', code: null, amount: PF.paediatrician, source: 'history_mode', provenance: 'doc historical mode ₹4,000' });
  };

  if (pathway === 'healthy_with_mother') {
    components.push({ key: 'newborn_bed', name: 'Newborn Bed (with mother)', code: null, amount: 0, source: 'policy', note: '₹0 separate bed — baby stays with mother (125/127 cases had ₹0 room).' });
    addPf();
    addInvestigations();
  } else if (pathway === 'well_baby_package') {
    if (yes(inputs.inMotherPackage)) {
      packageRef = { status: 'attach_to_mother', note: 'Baby sits inside the mother’s delivery package — attach to it, add only excluded items; NO second room, NO separate newborn base package.' };
      flags.push('In mother’s package: do not add a separate newborn base package or a second room charge.');
    } else {
      const code = days >= 2 ? 'PAE5049' : 'PAE5048';
      const pk = newbornPackages[code];
      packageRef = { package_code: code, name: pk?.name ?? 'Postnatal Well Baby Package', amount: pk?.amount ?? null, days, status: pk ? 'ACTIVE_POLICY' : 'CONTEXT_REQUIRED' };
      if (twins) flags.push('Twins: do NOT multiply a package that already covers single/twins — confirm the package scope.');
    }
  } else if (pathway === 'phototherapy') {
    const code = yes(inputs.phototherapyDoubleSurface) ? 'PAE5061' : 'PAE5055';
    const pk = newbornPackages[code];
    packageRef = { package_code: code, name: pk?.name ?? 'Phototherapy Package', per_day_amount: pk?.amount ?? null, days,
      amount: pk?.amount != null ? Math.round(pk.amount * days * 100) / 100 : null, status: pk ? 'ACTIVE_POLICY' : 'CONTEXT_REQUIRED',
      note: 'Per-day phototherapy package × days. Alternatively itemise (bed×days + PAE0006 + PF).' };
    addPf();
  } else if (pathway === 'nicu') {
    const nicuDays = Math.max(1, Number(inputs.nicuDays) || 1);
    const bed = priceCode(rateOf, 'ROM5015', roomKey, nicuDays);   // NICU room-service code — NOT generic icu_days
    components.push({ key: 'nicu_bed', name: `NICU Bed (${nicuDays}d)`, code: 'ROM5015', amount: bed.amount,
      status: bed.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY', source: bed.source ?? 'tariff', units: nicuDays,
      note: 'NICU days from the NICU room-service code (ROM5015), never the generic icu_days field.' });
    addPf();
    addInvestigations();
    flags.push('NICU pharmacy is a per-day actual — shown as a range/estimate, itemise on actuals.');
  } else {
    return null;
  }

  const priced = components.filter((c) => typeof c.amount === 'number');
  const componentsTotal = priced.reduce((t, c) => t + c.amount, 0);
  const total = componentsTotal + (packageRef?.amount || 0);

  return {
    active: true,
    pathway,
    inference: 'none',                     // never auto-added; explicit pathway selection
    twins,
    mother_baby_linkage: 'ask_fc',         // FC-perspective input, not a governed billing link
    // Doc T7 (mother-linked "dollar bed") — a BILLING concern, NOT an FC-estimate
    // concern (manager: "linkage bed is not an FC-related thing… we can ignore
    // that", handle with the right question). Kept here only as an FC knowledge-
    // base reference for the three bed states; no segment automation is applied.
    mother_linked_kb: {
      scope: 'knowledge_base_only',
      note: 'Newborn is a separate IP linked to the mother via a "dollar bed" (e.g. 522§1) — a location, not a billable bed while rooming-in. FC handles it via the pathway question; no dollar-bed/segment automation.',
      bed_states: [
        { state: 'rooming_in_with_mother', bed_charge: 0, note: 'No room rent / no ward consumables — baby stays in the mother-linked bed (₹0). Twins = separate admissions (522§1 / 522§2), never combined.' },
        { state: 'moved_to_nicu_or_nursery', bed_charge: 'ICU/NICU billing', note: 'Chargeable from the transfer point — use the NICU pathway (ROM5015).' },
        { state: 'mother_discharged_baby_continues', bed_charge: 'ordinary bed from that point', note: 'Baby’s bed becomes chargeable once the mother is discharged; FC selects this via the right question.' },
      ],
    },
    components,
    package_ref: packageRef,
    total,                                 // additive scenario — NOT folded into the base (mother's) estimate
    flags: [
      ...flags,
      'No cradle service code — a baby-warmer code must not substitute (N3, asked hospital); flag if applicable.',
      'Standalone newborn/phototherapy/NICU package master limited to the 4 cash packages; any other "newborn package" remark is package_reference_unverified, not a financial fact (N3).',
    ],
    notes: [
      'Four distinct newborn pathways — "newborn" never auto-adds a bed or PF; the FC selects the pathway explicitly.',
      'This newborn scenario is separate from (and additive to) the mother’s estimate.',
    ],
  };
}
