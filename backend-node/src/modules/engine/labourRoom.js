/**
 * Labour room — doc T15, manager 21-Jul.
 *
 * A maternal LOCATION add-on billed by occupancy duration, IN ADDITION TO (never
 * replacing) the ward/room charge — and never modelled as the room category for
 * the stay. Additive (estimate.labour_room); base unchanged.
 *
 * Hospital rule: < 4h → occupied-bed (ward) charge only, NO separate labour-room
 * line; ≥ 4h → labour-room charge + the occupied ward charge. At ESTIMATE time
 * there is no live bed transfer, so we take PROJECTED labour-room hours as an FC
 * input, defaulting to the 0–4h slot (manager: "less than four hours as a default
 * at FC time"). Optional — off unless a delivery pathway is selected.
 *
 * Tariff codes (validated 2026-07-22, flat across ward groups):
 *   ROM0121  "LABOUR ROOM CHARGES UP TO 4 HRS"  ₹9,900
 *   ROM5166  "LABOUR ROOM CHARGES"              ₹15,000 (extended)
 * The tariff has no explicit 4–8h / 8–12h codes — the ≥4h charge uses ROM0121,
 * with ROM5166 for extended stays; the exact slot→code mapping is flagged for
 * billing-head confirmation.
 */

const SLOT = (h) => (h < 4 ? '0-4h' : h < 8 ? '4-8h' : '8-12h');
const rate = (rateOf, code, room) => {
  const r = rateOf(code) || {};
  return Number(r[room]) || Number(r.general) || 0;
};

/**
 * @param {object} p
 * @param {number}  [p.hours]           projected labour-room hours (default 0–4h slot)
 * @param {boolean} [p.deliveryPathway] labour/delivery pathway selected (enables the add-on)
 * @param {(code:string)=>object} p.rateOf
 * @param {string}  p.room              selected room key
 * @returns {null | object}
 */
export function buildLabourRoom({ hours, deliveryPathway, rateOf, room = 'general' }) {
  // off unless a delivery pathway is selected or an explicit projection is given
  if (!deliveryPathway && hours == null) return null;
  const h = hours == null ? 2 : Math.max(0, Number(hours) || 0);   // default 0–4h slot
  const slot = SLOT(h);
  const roomKey = ['general', 'twin', 'single'].includes(room) ? room : 'general';

  if (h < 4) {
    return {
      active: true,
      slot, projected_hours: h,
      billed: false,                                   // < 4h → occupied-bed only
      charge: 0,
      additive_to_ward: true,                          // NEVER the room category
      note: 'Under 4h — occupied-bed (ward) charge only; no separate labour-room line (hospital rule). Default at FC estimate time.',
      flags: ['Default 0–4h slot — labour-room charge applies only if projected occupancy ≥ 4h.'],
    };
  }

  // ≥ 4h → labour-room charge + the ward charge (which stays in the base estimate)
  const extended = h >= 8;
  const code = extended ? 'ROM5166' : 'ROM0121';
  const charge = Math.round(rate(rateOf, code, roomKey) * 100) / 100
    || (extended ? 15000 : 9900);                      // validated flat fallbacks
  return {
    active: true,
    slot, projected_hours: h,
    billed: true,
    code, charge,
    additive_to_ward: true,                            // added ON TOP of the ward/room charge
    package_open_handling: 'apply_after',              // package vs open handled afterward
    note: `≥4h — labour-room charge (${code} ₹${charge}) added ON TOP of the occupied ward charge; not the room category.`,
    flags: [
      'Tariff has no explicit 4–8h / 8–12h codes — ROM0121 (≤4h ₹9,900) / ROM5166 (extended ₹15,000); confirm the exact slot→code mapping with the billing head.',
    ],
  };
}
