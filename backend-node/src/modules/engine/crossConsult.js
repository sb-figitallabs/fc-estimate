import { query } from '../../db/pool.js';

/**
 * Cross-consultation pricing — doc T9, manager 21-Jul.
 *
 * A cross-consult is a consult by a DIFFERENT department than the treating
 * team. The core (exclude cross-consults from the surgeon-PF base + group them
 * under "Cross Consultations") already ships in buildEstimate (D3, 17-Jul). This
 * module prices FC-SELECTED cross-consults — suggest-and-confirm, NEVER auto-
 * included (manager: auto only when a note explicitly names one; else confirm).
 *
 * Pricing (validated 2026-07-22): from fc.consultation_tariff_rate_matrix by
 * (payer tariff + department + ward) — a contracted flat fee per TR code (rates
 * are flat across doctors within a dept+tariff+ward, e.g. TR290/GENERAL Ortho
 * ₹2,500, Cardiology ₹3,000). For INSURANCE we price the PLACEHOLDER DEPARTMENT
 * (CROSS:<DEPT>), not a doctor's name — the contracted rate is by TR code, and
 * the real doctor code is substituted before billing (manager). A specific
 * doctor_cd, when supplied, is priced at that doctor's contracted rate.
 *
 * Rules honoured:
 *   - one visit / consultant / day (room or ICU), never one per LOS day — visits
 *     are capped at the length of stay.
 *   - charged separately at the visit tariff (NOT a PF %); grouped under
 *     Professional Charges → Cross Consultations.
 *   - excluded from packages for GIPSA (96.5%) and Non-GIPSA (91.7%); TR201/ICICI
 *     kept as EXCLUSION for Non-GIPSA until a TR201-specific include-guideline
 *     is added (manager).
 *   - additive: attached as estimate.cross_consultations; the base estimate is
 *     unchanged.
 */

const wardGroupOf = (room) => (room === 'single' ? 'DELUXE' : room === 'twin' ? 'SEMI PRIVATE' : 'GENERAL');
const isInsurance = (b) => /insurance/i.test(String(b || ''));

/** contracted consultation rate for a dept (placeholder) or a specific doctor. */
async function rateFor({ tariffCd, department, ward, doctorCd }) {
  // specific doctor → that doctor's contracted rate (any ward, prefer the room's)
  if (doctorCd) {
    const { rows } = await query(
      `SELECT charge::numeric AS charge, ward_group_name FROM fc.consultation_tariff_rate_matrix
        WHERE tariff_cd = $1 AND doctor_cd = $2 AND charge::numeric > 0
        ORDER BY (ward_group_name ILIKE $3) DESC LIMIT 1`, [tariffCd, doctorCd, ward]);
    if (rows.length) return { amount: Number(rows[0].charge), basis: `doctor ${doctorCd} · ${rows[0].ward_group_name}`, source: 'consultation_tariff' };
  }
  // placeholder department: median contracted rate across doctors for tariff+dept+ward,
  // then GENERAL, then TR1 (cash) fallback
  for (const [t, w] of [[tariffCd, ward], [tariffCd, 'GENERAL'], ['TR1', ward], ['TR1', 'GENERAL']]) {
    const { rows } = await query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY charge::numeric) AS med, count(*)::int n
         FROM fc.consultation_tariff_rate_matrix
        WHERE tariff_cd = $1 AND department_name ILIKE $2 AND ward_group_name ILIKE $3 AND charge::numeric > 0`,
      [t, department, w]);
    if (rows[0]?.med != null) return { amount: Number(rows[0].med), basis: `${department} · ${t} · ${w} (median of ${rows[0].n})`, source: 'consultation_tariff', ...(t === 'TR1' ? { tr1_fallback: true } : {}) };
  }
  return { amount: null, basis: `${department} — no contracted rate on ${tariffCd}/TR1`, source: null, context_required: true };
}

/**
 * @param {object} p
 * @param {Array<{department:string, visits?:number, doctor_cd?:string}>} p.selections  FC-selected cross-consults
 * @param {string} p.tariffCd     payer tariff code
 * @param {string} p.room         selected room key
 * @param {number} p.losDays      length of stay (visit cap = one per day)
 * @param {string} p.payorBucket
 * @returns {Promise<null | object>}
 */
export async function buildCrossConsults({ selections, tariffCd, room = 'general', losDays = 1, payorBucket }) {
  if (!Array.isArray(selections) || !selections.length) return null;   // suggest-and-confirm — explicit only
  const ward = wardGroupOf(room);
  const cap = Math.max(1, Math.round(Number(losDays) || 1));
  const insurance = isInsurance(payorBucket);
  const components = [];

  for (const sel of selections) {
    const department = String(sel.department || '').trim();
    if (!department) continue;
    const visits = Math.min(cap, Math.max(1, Math.round(Number(sel.visits) || 1)));   // one/consultant/day
    const doctorCd = insurance ? null : (sel.doctor_cd || null);   // insurance → placeholder department, not doctor name
    const r = await rateFor({ tariffCd, department, ward, doctorCd });
    components.push({
      department,
      code: doctorCd || `CROSS:${department.toUpperCase()}`,        // placeholder dept code for insurance
      visits, cap_note: 'One visit per consultant per day (room or ICU).',
      rate: r.amount, amount: r.amount != null ? Math.round(r.amount * visits * 100) / 100 : null,
      status: r.context_required ? 'CONTEXT_REQUIRED' : 'ACTIVE_POLICY',
      source: r.source, basis: r.basis, ...(r.tr1_fallback ? { tr1_fallback: true } : {}),
      pricing_mode: insurance ? 'placeholder_department' : (doctorCd ? 'specific_doctor' : 'placeholder_department'),
    });
  }

  const total = components.reduce((t, c) => t + (c.amount || 0), 0);
  return {
    active: true,
    group: 'Professional Charges → Cross Consultations',
    inference: 'none',                       // suggest-and-confirm; never auto-included
    excluded_from_surgeon_pf: true,          // already true in the base engine (D3)
    package_treatment: 'excluded_charge_separately',   // GIPSA 96.5% / Non-GIPSA 91.7% excluded; TR201 kept excluded
    components,
    total,                                   // additive — NOT folded into the base estimate total
    notes: [
      'Cross-consults are priced at the contracted visit tariff (by TR code), never as a PF %.',
      insurance ? 'Insurance: priced on the PLACEHOLDER DEPARTMENT (CROSS:<DEPT>) — substitute the real doctor code before billing.' : 'Cash/open: a specific doctor code prices at that doctor’s rate; else the department median.',
      'Never auto-included — the FC confirms each cross-consult.',
    ],
  };
}
