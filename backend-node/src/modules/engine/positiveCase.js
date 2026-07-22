/**
 * Positive-case (infective / seropositive) billing layer — doc T4, manager 21-Jul.
 *
 * A separate billing-rule layer driven by VERIFIED infection status + clinical
 * context + payer + room/ICU days + LOS. NEVER inferred from a test order
 * (MIC0066 is in 2,840 admissions incl. 905 medical — just an investigation).
 * Trigger is an EXPLICIT FC toggle (`positive_status`) — or an explicit doctor's-
 * note selection; nothing else is inferred (manager: "There's no other input we
 * need to use to infer it").
 *
 * Policy-first (manager Q3): only ~124 historical positive-management admissions
 * (and our line data is package-bill-only → we see 67), so components are marked
 * ACTIVE_POLICY / PROVISIONAL — rules from the doc + payer tariff, history as
 * evidence, not "historically certified".
 *
 * Additive overlay: attached as `estimate.positive_case`; never mutates the
 * parity-pinned base line items or totals. Positive-management charges sit
 * OUTSIDE the package by default (95% historical support).
 *
 * Rate resolution is always service code + payer tariff (+ TR1 fallback already
 * merged) + room — never a hardcoded workbook rate. When the payer tariff has no
 * rate for a context code, the component is CONTEXT_REQUIRED (flagged, priceless)
 * rather than guessed.
 *
 * §5 validation (2026-07-22, package-bill lines only): RNS0123 51 · RNS0122 12 ·
 * RNS0121 1 · RNS0116 5 (doc full-cohort 83/13/1/31 — the delta is open-bill
 * positive cases we have no line data for). RNS0101 ₹62k(1) · MSC2816 ₹10 placeholder.
 */

const INFECTIVE = new Set(['HBSAG', 'HCV', 'H1N1', 'OTHER_INFECTIVE']);
const SEROPOSITIVE = new Set(['HIV_SEROPOSITIVE']);
const yes = (v) => String(v || '').toLowerCase() === 'yes' || v === true;
const isGipsaOrNonGipsa = (b) => /insurance/i.test(String(b || '')); // GIPSA + Non-GIPSA

// HBsAg/HCV management context code by surgery context. Medical → no charge
// (the 20 historical medical charges are billing exceptions, not precedent).
const CONTEXT_CODE = { non_heart: 'RNS0123', ct: 'RNS0121', cath_lab: 'RNS0122', medical: null };

// HIV/seropositive LOS band → HSP code (exactly one; daycare precedence).
function hivBandCode(losDays, daycare) {
  if (daycare || losDays <= 0) return 'HSP5020';
  if (losDays <= 2) return 'HSP5021';
  if (losDays <= 5) return 'HSP5022';
  if (losDays <= 10) return 'HSP5023';
  return 'HSP5024';
}

function priceCode(rateOf, code, room, units = 1) {
  const r = rateOf(code) || {};
  const per = Number(r[room]) || 0;
  if (per <= 0) return { code, amount: null, context_required: true }; // not in payer tariff → flag, never guess
  return { code, amount: Math.round(per * units * 100) / 100, source: 'tariff', ...(r.tr1_fallback ? { tr1_fallback: true } : {}), units };
}

/**
 * @param {object} p
 * @param {object} p.inputs { positiveStatus, confirmationSource, requiresIsolation,
 *   isolationRoomDays, isolationIcuDays, surgeryContext, losDays, daycare, payerAgreementId }
 * @param {(code:string)=>object} p.rateOf   payer-tariff rate lookup (TR1 fallback merged)
 * @param {string} p.payorBucket
 * @param {string} p.room   selected room key
 * @param {number} p.otChargesBase  OT-Charges amount for the selected room (surcharge base)
 * @param {boolean} p.hasPackage    whether a package offer is in play (affects OT-base note)
 * @returns {null | object}
 */
export function buildPositiveCaseOverlay({ inputs = {}, rateOf, payorBucket, room = 'general', otChargesBase = 0, hasPackage = false }) {
  const status = String(inputs.positiveStatus || 'NONE').toUpperCase();
  if (!status || status === 'NONE') return null;                 // explicit toggle only
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';
  const components = [];
  const flags = [];

  // 1) HBsAg / HCV management — verified status + qualifying procedure → context code.
  if (status === 'HBSAG' || status === 'HCV') {
    const ctx = String(inputs.surgeryContext || '').toLowerCase();
    const code = CONTEXT_CODE[ctx];
    if (ctx === 'medical') {
      flags.push('HBsAg/HCV medical management — no charge (medical management is not billed; the 20 historical charges are exceptions).');
    } else if (!code) {
      flags.push('HBsAg/HCV: surgery_context required (non_heart / ct / cath_lab / medical) to resolve the management code.');
    } else {
      const p = priceCode(rateOf, code, roomKey);
      components.push({
        key: 'hbsag_hcv_mgmt', name: `HBsAg/HCV Management (${ctx})`, code,
        gate: `positive_status=${status} · surgery_context=${ctx}`, default_on: true,
        amount: p.amount, status: p.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY',
        source: p.source ?? 'payer_tariff', ...(p.tr1_fallback ? { tr1_fallback: true } : {}),
        note: p.context_required ? `${code} not on the payer tariff — flagged, not priced (never a hardcoded rate).` : 'Qty 1. Never combined with RNS0116 for the same context.',
      });
    }
    // RNS0116 is only valid where the tariff explicitly carries it (Blocked #4).
    flags.push('RNS0116 used only when the payer tariff explicitly carries it — never together with RNS0123 for one context (Blocked #4, pending hospital).');
  }

  // 2) HIV / seropositive — LOS-banded HSP5020–5024 (exactly one; daycare precedence).
  if (status === 'HIV_SEROPOSITIVE') {
    const code = hivBandCode(Number(inputs.losDays) || 0, yes(inputs.daycare));
    const p = priceCode(rateOf, code, roomKey);
    components.push({
      key: 'hiv_seropositive_mgmt', name: `HIV/Seropositive Management (${code})`, code,
      gate: `positive_status=HIV_SEROPOSITIVE · LOS band`, default_on: true,
      amount: p.amount, status: p.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY',
      source: p.source ?? 'payer_tariff', ...(p.tr1_fallback ? { tr1_fallback: true } : {}),
      note: 'Exactly one LOS category; normalized billable LOS; daycare takes precedence.',
    });
    flags.push('MSC2816 (retropositive) conflict: ₹10 tariff placeholder vs workbook ₹10,000/₹5,000, and whether it replaces or coexists with HSP5020–5024 — Blocked #3, pending hospital.');
  }

  // 3) Isolation — daily, additive to room/ICU; never room+ICU isolation same day.
  if (yes(inputs.requiresIsolation)) {
    const roomDays = Math.max(0, Number(inputs.isolationRoomDays) || 0);
    const icuDays = Math.max(0, Number(inputs.isolationIcuDays) || 0);
    if (roomDays > 0) {
      const p = priceCode(rateOf, 'RNS0101', roomKey, roomDays);
      components.push({
        key: 'isolation_room', name: `Isolation Care — Room (${roomDays}d)`, code: 'RNS0101',
        gate: 'requires_isolation=Yes', default_on: true, amount: p.amount,
        status: p.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY', source: p.source ?? 'payer_tariff',
        ...(p.tr1_fallback ? { tr1_fallback: true } : {}), units: roomDays,
        note: 'Daily, additive to room charges. Never billed on the same day as ICU isolation.',
      });
    }
    if (icuDays > 0) {
      components.push({
        key: 'isolation_icu', name: `Isolation Care — ICU (${icuDays}d)`, code: null,
        gate: 'requires_isolation=Yes', default_on: false, amount: null, status: 'CONTEXT_REQUIRED',
        note: 'ICU isolation-care service code unidentified — CONTEXT_REQUIRED (Blocked #1, asked hospital). RNS0101 is room-isolation only.', units: icuDays,
      });
    }
  }

  // 4) Non-GIPSA / GIPSA OT surcharge — STANDARD (manager #5: no MOU validation).
  //    Infective +50%, seropositive +100%. On the OT-CHARGES base only, as a
  //    SEPARATE line, highest-single not cumulative. Final-insurance adjustment.
  //    Ties to T3 (Q2): same OT base as emergency-OT, separate line, NO compounding.
  let ot_surcharge = null;
  if (isGipsaOrNonGipsa(payorBucket)) {
    const pct = SEROPOSITIVE.has(status) ? 1.0 : (INFECTIVE.has(status) ? 0.5 : 0);
    if (pct > 0) {
      const base = Number(otChargesBase) || 0;
      ot_surcharge = {
        key: 'positive_ot_surcharge', name: `Positive-case OT surcharge (+${pct * 100}%)`,
        pct, base_type: hasPackage ? 'package_embedded_ot' : 'reconstructed_ot_tariff',
        base, amount: base > 0 ? Math.round(pct * base * 100) / 100 : null,
        status: 'ACTIVE_POLICY', applies_to: 'OT_CHARGES_only', combine: 'highest_single_not_cumulative',
        note: `Standard for GIPSA + Non-GIPSA (no per-org MOU needed). Separate line, no compounding with emergency-OT (T3 Q2).${hasPackage ? ' Package case: package-embedded OT base — REVIEW flag (Blocked #6).' : ''}`,
      };
      if (hasPackage) flags.push('Package-case OT-surcharge base = package-embedded OT (review flag, Blocked #6).');
    }
  }

  const priced = components.filter((c) => c.default_on && typeof c.amount === 'number');
  const total = priced.reduce((t, c) => t + c.amount, 0) + (ot_surcharge?.amount || 0);

  return {
    active: true,
    status,
    confirmation_source: inputs.confirmationSource || null,
    verified: !!inputs.confirmationSource,          // status must be verified, not inferred
    inference: 'none',
    presentation: 'policy_first',                    // Q3 — ACTIVE_POLICY/PROVISIONAL, not certified
    package_handling: 'outside_package_by_default',  // 95% historical support; consumables = separate actuals
    components,
    ot_surcharge,
    total,                                           // additive overlay — NOT folded into base total
    payer_agreement_id: inputs.payerAgreementId || null,
    flags,
    notes: [
      'Positive-case billing layer — verified status only, user-selected, never inferred from a test order.',
      'Policy-first: ~124 historical admissions (67 in our package-bill line data) — rules are ACTIVE_POLICY/PROVISIONAL, not historically certified.',
      'Overlay total is separate from the base estimate total.',
    ],
  };
}
