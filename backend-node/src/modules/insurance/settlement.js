/**
 * Insurance settlement engine — how much the insurer covers vs the patient pays.
 *
 * IRDAI-aligned, computed PER ROW over the itemized estimate (finer than the
 * bucket-level reference implementation):
 *  1. Room-rent cap (absolute ₹/day, % of Base SI, or room-category tier) →
 *     ward ratio = cap ÷ bed rate/day; independent ICU ratio (2% of SI default).
 *  2. Row classes: NME (100% patient) · exempt (pharmacy/implants/investigations/
 *     ICU-day rows — no ratio) · associated (room, OT, PF, consults — ward ratio).
 *  3. Structured sub-limits cap matching row groups (implants / pharmacy /
 *     investigations / procedure / total); overflow → patient.
 *  4. Copay (% or ₹) on gross admissible.
 *  5. TPA approval = min(admissible − copay, Base SI − consumed + NCB).
 *  6. Top-up: standard (per-claim deductible) vs super (aggregate — consumed
 *     counts toward the deductible); pays above max(base cover, threshold).
 *  7. Patient = NME + copay + proportionate deduction + sub-limit overflow +
 *     room-upgrade excess + beyond-cover remainder.
 */

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** Row classification (KIMS NME list + IRDAI exempt/associated buckets). */
const NME_ROWS = /DRUG ADMINISTRATION|MEDICAL RECORDS|WARD CONSUMABLES|DRESSING|DIET CONSULTATION|MLC CHARGES|WARMER/i;
const ICU_DAY_ROWS = /NURSING - ICU|ICU - SURGICAL|INTENSIVIST|MONITOR PER DAY/i;

export function classifyRow(row) {
  if (NME_ROWS.test(row.name)) return 'nme';
  if (ICU_DAY_ROWS.test(row.name)) return 'icu';
  if (row.bucket === 'Pharmacy') return 'exempt';                 // drugs/consumables/implants
  if (row.bucket === 'Investigations') return 'exempt';           // diagnostics
  if (/Implants/i.test(row.name)) return 'exempt';
  return 'associated';                                            // room, OT, PF, consults, bedside
}

/** Which sub-limit group a row belongs to. */
function subLimitGroup(row) {
  if (/^Implants$/i.test(row.name) || row.sub === 'Implants') return 'implants';
  if (row.bucket === 'Pharmacy') return 'pharmacy';
  if (row.bucket === 'Investigations') return 'investigations';
  if (row.bucket === 'Procedure / OT Charges') return 'procedure';
  return null;
}

const ROOM_KEYS = ['general', 'twin', 'single'];

/**
 * Shared claim-ceiling core — copay, base-cover ceiling and top-up applied to a
 * gross-admissible amount. Single source of truth for the per-row `settle()`
 * and the bucket-level `settleManual()` so the two can never drift.
 * Returns { copay, tpaBeforeCap, tpaApproval, topUpPay, beyondCover, insurerTotal }.
 */
function applyClaimCeiling({ grossAdmissible, insurance, baseAvailable, notes = [] }) {
  const ins = insurance;
  const topUpAmount = Number(ins.top_up?.amount ?? 0);
  let copay = 0;
  if (ins.copay?.value > 0) {
    copay = ins.copay.type === 'absolute'
      ? Number(ins.copay.value)
      : grossAdmissible * (Number(ins.copay.value) / 100);
  }
  const tpaBeforeCap = Math.max(0, grossAdmissible - copay);
  const tpaApproval = Math.min(tpaBeforeCap, baseAvailable);
  const overflow = Math.max(0, tpaBeforeCap - baseAvailable);
  let topUpPay = 0;
  if (overflow > 0 && topUpAmount > 0) {
    const deductible = Number(ins.top_up?.deductible ?? 0);
    const met = ins.top_up?.type === 'super' ? Number(ins.consumed ?? 0) : 0;
    const threshold = Math.max(0, deductible - met);
    const eligibleAbove = Math.max(0, tpaBeforeCap - Math.max(baseAvailable, threshold));
    topUpPay = Math.min(eligibleAbove, topUpAmount);
    if (threshold > baseAvailable) notes.push(`top-up deductible ₹${deductible} above base cover — gap is patient-payable`);
  }
  const beyondCover = Math.max(0, overflow - topUpPay);
  const insurerTotal = tpaApproval + topUpPay;
  return { copay, tpaBeforeCap, tpaApproval, topUpPay, beyondCover, insurerTotal };
}

/**
 * @param {object} p
 * @param {Array} p.lineItems  estimate.line_items
 * @param {string} p.roomKey   'general'|'twin'|'single'
 * @param {object} p.drivers   estimate.drivers (ward/icu selected days)
 * @param {object} p.insurance the policy input (see zod schema)
 * @param {number} p.grossTotal estimate final for the room
 */
export function settle({ lineItems, roomKey, drivers, insurance, grossTotal }) {
  const ins = insurance;
  const notes = [];
  const sel = (r) => Number(r.selected?.[roomKey] ?? 0);

  // guard: an unknown room key would read ₹0 from every row and produce a
  // silent all-zero settlement — fail loudly instead
  if (grossTotal > 0 && !lineItems.some((r) => sel(r) > 0)) {
    return { error: `no per-room amounts resolved for room key "${roomKey}" — expected one of ${ROOM_KEYS.join('/')}` };
  }

  // ---- coverage balances ----
  const baseSI = Number(ins.base_sum_insured ?? 0);
  const baseAvailable = Math.max(0, baseSI - Number(ins.consumed ?? 0) + Number(ins.ncb ?? 0));
  const topUpAmount = Number(ins.top_up?.amount ?? 0);

  // ---- per-day room rates from the estimate itself ----
  const bedRow = lineItems.find((r) => r.name === 'Bed Charges - Ward');
  const icuRow = lineItems.find((r) => /ICU - Surgical/i.test(r.name));
  const bedRate = Number(bedRow?.rate?.[roomKey] ?? 0);
  const icuRate = Number(icuRow?.rate?.[roomKey] ?? icuRow?.rate?.general ?? 0);

  // ---- caps ----
  const cap = ins.room_rent_cap ?? {};
  let wardCap = null, icuCap = null, eligibleRate = null, upgradeExcess = 0;
  if (cap.type === 'absolute' && cap.value > 0) {
    wardCap = Number(cap.value);
    icuCap = cap.icu_value != null ? Number(cap.icu_value) : null; // ICU usually uncapped for absolute
  } else if (cap.type === 'pct_of_si' && baseSI > 0) {
    wardCap = baseSI * (Number(cap.ward_pct ?? 1) / 100);
    icuCap = baseSI * (Number(cap.icu_pct ?? 2) / 100);
  } else if (cap.type === 'room_category' && ins.room_eligibility) {
    const elig = String(ins.room_eligibility).toLowerCase();
    if (ROOM_KEYS.includes(elig) && bedRow) {
      eligibleRate = Number(bedRow.rate?.[elig] ?? 0);
      wardCap = eligibleRate;
    } else notes.push(`room_eligibility "${ins.room_eligibility}" not resolvable to a tier rate`);
  }
  // eligibility upgrade excess is computed even when the cap is monetary
  if (ins.room_eligibility && bedRow) {
    const elig = String(ins.room_eligibility).toLowerCase();
    if (ROOM_KEYS.includes(elig)) {
      const eligRate = Number(bedRow.rate?.[elig] ?? 0);
      if (eligRate > 0 && bedRate > eligRate) {
        upgradeExcess = (bedRate - eligRate) * (drivers?.ward?.selected ?? 0);
        notes.push(`room upgrade: eligible ${ins.room_eligibility} @₹${eligRate}/d, selected @₹${bedRate}/d`);
      }
    }
  }

  const wardRatio = wardCap != null && bedRate > wardCap && bedRate > 0 ? wardCap / bedRate : 1;
  const icuRatio = icuCap != null && icuRate > icuCap && icuRate > 0 ? icuCap / icuRate : 1;
  const wardShortfall = wardRatio < 1 ? (bedRate - wardCap) * (drivers?.ward?.selected ?? 0) : 0;
  const icuShortfall = icuRatio < 1 ? (icuRate - icuCap) * (drivers?.icu?.selected ?? 0) : 0;

  // ---- pass 1: classify + ratio ----
  const rows = lineItems.map((r, i) => {
    const amount = sel(r);
    const cls = classifyRow(r);
    let admissible = amount;
    let ratio = 1;
    if (cls === 'nme') admissible = 0;
    else if (cls === 'icu') { ratio = icuRatio; admissible = amount * icuRatio; }
    else if (cls === 'associated') { ratio = wardRatio; admissible = amount * wardRatio; }
    // exempt: full
    return {
      index: i, name: r.name, bucket: r.bucket, amount: round2(amount),
      class: cls, ratio: round2(ratio), admissible, group: subLimitGroup(r),
      _rawAmount: amount, _preSubLimit: admissible, // exact values for the math
    };
  });

  // ---- pass 2: structured sub-limits (cap matching groups) ----
  const subLimitDetail = [];
  for (const sl of (ins.sub_limits ?? [])) {
    const capAmt = Number(sl.cap ?? 0);
    if (!(capAmt > 0)) continue;
    const applies = String(sl.applies_to ?? 'total').toLowerCase();
    const members = applies === 'total' ? rows.filter((r) => r.class !== 'nme')
      : rows.filter((r) => r.group === applies && r.class !== 'nme');
    const groupAdm = members.reduce((t, r) => t + r.admissible, 0);
    if (groupAdm <= capAmt || !members.length) {
      subLimitDetail.push({ ...sl, applied: false, group_admissible: round2(groupAdm) });
      continue;
    }
    const scale = capAmt / groupAdm;
    for (const r of members) r.admissible *= scale;
    subLimitDetail.push({
      ...sl, applied: true, group_admissible: round2(groupAdm),
      overflow_to_patient: round2(groupAdm - capAmt),
    });
    notes.push(`sub-limit "${sl.label ?? applies}" ₹${capAmt} applied (was ₹${round2(groupAdm)})`);
  }

  // ---- totals ----
  const gross = rows.reduce((t, r) => t + r._rawAmount, 0);
  const nme = rows.filter((r) => r.class === 'nme').reduce((t, r) => t + r._rawAmount, 0);
  const grossAdmissible = rows.reduce((t, r) => t + r.admissible, 0);
  const proportionateDeduction = rows
    .filter((r) => r.class === 'associated' || r.class === 'icu')
    .reduce((t, r) => t + (r._rawAmount - r._preSubLimit), 0); // exact, not display-rounded
  const subLimitOverflow = subLimitDetail.reduce((t, s) => t + (s.overflow_to_patient ?? 0), 0);

  // copay + base-cover ceiling + top-up (shared core)
  const { copay, tpaBeforeCap, tpaApproval, topUpPay, beyondCover, insurerTotal } =
    applyClaimCeiling({ grossAdmissible, insurance: ins, baseAvailable, notes });

  const patient = {
    nme: round2(nme),
    copay: round2(copay),
    proportionate_deduction: round2(proportionateDeduction),
    sub_limit_overflow: round2(subLimitOverflow),
    room_upgrade_excess: round2(upgradeExcess),
    beyond_cover: round2(beyondCover),
  };
  patient.total = round2(Object.values(patient).reduce((a, b) => a + b, 0));

  return {
    room: roomKey,
    gross: round2(gross),
    caps: {
      ward_cap_per_day: wardCap != null ? round2(wardCap) : null,
      icu_cap_per_day: icuCap != null ? round2(icuCap) : null,
      bed_rate_per_day: round2(bedRate), icu_rate_per_day: round2(icuRate),
      ward_ratio: round2(wardRatio), icu_ratio: round2(icuRatio),
      ward_shortfall: round2(wardShortfall), icu_shortfall: round2(icuShortfall),
      eligible_tier_rate: eligibleRate != null ? round2(eligibleRate) : null,
    },
    gross_admissible: round2(grossAdmissible),
    sub_limits: subLimitDetail,
    copay: round2(copay),
    tpa_before_cap: round2(tpaBeforeCap),
    base_available: round2(baseAvailable),
    tpa_approval: round2(tpaApproval),
    top_up_claim: round2(topUpPay),
    insurer_total: round2(insurerTotal),
    patient,
    check: { insurer_plus_patient: round2(insurerTotal + patient.total), gross_plus_upgrade: round2(gross + upgradeExcess) },
    rows: rows.map(({ _rawAmount, _preSubLimit, ...r }) => ({ ...r, admissible: round2(r.admissible) })),
    notes,
  };
}

/**
 * Settlement when the insurer PACKAGE route is taken: the negotiated package
 * amount is fully admissible (no ratio on the flat rate); coverage-engine
 * payable extras are settled per-row like an itemized claim; procedure
 * sub-limits cap the package amount itself.
 */
export function settleWithPackage({ packageAmount, coverageRows, lineItems, roomKey, drivers, insurance }) {
  const ins = insurance;
  const baseSI = Number(ins.base_sum_insured ?? 0);
  const baseAvailable = Math.max(0, baseSI - Number(ins.consumed ?? 0) + Number(ins.ncb ?? 0));

  // extras (final_amount > 0) settled as a mini itemized claim
  const extraItems = coverageRows
    .map((c, i) => ({ c, li: lineItems[c.index] }))
    .filter(({ c }) => (c.final_amount ?? 0) > 0)
    .map(({ c, li }) => ({
      ...li,
      selected: { ...li.selected, [roomKey]: c.final_amount }, // settle the payable extra portion
    }));
  const extras = settle({ lineItems: extraItems, roomKey, drivers, insurance, grossTotal: 0 });

  // package amount: procedure/total sub-limits cap it
  let pkgAdmissible = Number(packageAmount) || 0;
  let pkgOverflow = 0;
  for (const sl of (ins.sub_limits ?? [])) {
    const applies = String(sl.applies_to ?? '').toLowerCase();
    if ((applies === 'procedure' || applies === 'total') && Number(sl.cap) > 0 && pkgAdmissible > Number(sl.cap)) {
      pkgOverflow += pkgAdmissible - Number(sl.cap);
      pkgAdmissible = Number(sl.cap);
    }
  }

  const grossAdmissible = pkgAdmissible + extras.gross_admissible;
  let copay = 0;
  if (ins.copay?.value > 0) {
    copay = ins.copay.type === 'absolute' ? Number(ins.copay.value) : grossAdmissible * (Number(ins.copay.value) / 100);
  }
  const tpaBeforeCap = Math.max(0, grossAdmissible - copay);
  const tpaApproval = Math.min(tpaBeforeCap, baseAvailable);
  const beyond = Math.max(0, tpaBeforeCap - baseAvailable);
  const insurerTotal = tpaApproval; // top-up layering reuses the itemized path if needed

  const patientTotal = round2(extras.patient.nme + extras.patient.proportionate_deduction +
    extras.patient.sub_limit_overflow + pkgOverflow + copay + beyond);

  return {
    mode: 'with_package',
    package_amount: round2(Number(packageAmount) || 0),
    package_admissible: round2(pkgAdmissible),
    package_sub_limit_overflow: round2(pkgOverflow),
    extras_settlement: extras,
    gross_admissible: round2(grossAdmissible),
    copay: round2(copay),
    base_available: round2(baseAvailable),
    tpa_approval: round2(tpaApproval),
    insurer_total: round2(insurerTotal),
    patient_total: patientTotal,
  };
}

/**
 * Bucket-level settlement for the manual / open-billing fallback (no cohort
 * line items). Applies the SAME IRDAI logic as `settle()` at bucket
 * granularity: room-rent proportionate deduction on associated buckets,
 * per-bucket sub-limits, then the shared copay/ceiling/top-up core.
 *
 * Room-rent capping needs a per-day basis the buckets don't carry, so it uses
 * the entered stay: allowed room total for the stay ÷ the Room Charges bucket
 * → ward ratio. Conservation invariant insurer + patient = gross holds exactly.
 *
 * @param {object}  p.buckets    { 'Room Charges': n, 'Implants': n, ... }
 * @param {object}  p.insurance  the policy input (same shape as settle())
 * @param {number}  p.los_days   total length of stay (days)
 * @param {number}  p.icu_days   ICU days within the stay
 * @param {number}  p.nme_amount non-medical amount (100% patient)
 */
const MANUAL_BUCKETS = {
  'Room Charges': { class: 'associated', group: null, roomLinked: true },
  'Procedure / OT Charges': { class: 'associated', group: 'procedure' },
  'Professional Fees': { class: 'associated', group: null },
  'Pharmacy & Consumables': { class: 'exempt', group: 'pharmacy' },
  'Implants': { class: 'exempt', group: 'implants' },
  'Investigations': { class: 'exempt', group: 'investigations' },
  'Other Services': { class: 'associated', group: null },
};

export function settleManual({ buckets = {}, insurance = {}, los_days = 0, icu_days = 0, nme_amount = 0 }) {
  const ins = insurance;
  const notes = [];
  const baseSI = Number(ins.base_sum_insured ?? 0);
  const baseAvailable = Math.max(0, baseSI - Number(ins.consumed ?? 0) + Number(ins.ncb ?? 0));
  const losDays = Math.max(0, Number(los_days) || 0);
  const icuDays = Math.min(Math.max(0, Number(icu_days) || 0), losDays);
  const wardDays = Math.max(0, losDays - icuDays);

  // rows from buckets (+ an NME row that is 100% patient)
  const rows = [];
  for (const [name, meta] of Object.entries(MANUAL_BUCKETS)) {
    const amount = Number(buckets[name]) || 0;
    if (amount <= 0) continue;
    rows.push({ name, bucket: name, amount, class: meta.class, group: meta.group, roomLinked: !!meta.roomLinked, admissible: amount, _raw: amount, _preSubLimit: amount });
  }
  const nme = Math.max(0, Number(nme_amount) || 0);
  if (nme > 0) rows.push({ name: 'Non-medical (NME)', bucket: 'Other Services', amount: nme, class: 'nme', group: null, roomLinked: false, admissible: 0, _raw: nme, _preSubLimit: 0 });

  // ---- room-rent cap → allowed room total for the stay → ward ratio ----
  const cap = ins.room_rent_cap ?? {};
  const roomCharges = rows.filter((r) => r.roomLinked).reduce((t, r) => t + r.amount, 0);
  let allowedRoom = null, wardRatio = 1;
  if (cap.type === 'absolute' && Number(cap.value) > 0) {
    allowedRoom = Number(cap.value) * losDays;
  } else if (cap.type === 'pct_of_si' && baseSI > 0) {
    allowedRoom = baseSI * (Number(cap.ward_pct ?? 1) / 100) * wardDays + baseSI * (Number(cap.icu_pct ?? 2) / 100) * icuDays;
  } else if (cap.type === 'room_category') {
    notes.push('Room-category cap needs the hospital tariff — not applied in manual mode. Use an absolute or %-of-SI cap to apply room-rent capping.');
  }
  if (cap.type && cap.type !== 'none' && cap.type !== 'room_category' && losDays === 0) {
    notes.push('Enter length of stay for the room-rent cap to apply.');
  }
  if (allowedRoom != null && roomCharges > allowedRoom && roomCharges > 0) {
    wardRatio = allowedRoom / roomCharges;
    for (const r of rows) {
      if (r.class === 'associated') { r._preSubLimit = r.amount * wardRatio; r.admissible = r.amount * wardRatio; }
    }
  }

  // ---- per-bucket sub-limits (same rule as settle()) ----
  const subLimitDetail = [];
  for (const sl of (ins.sub_limits ?? [])) {
    const capAmt = Number(sl.cap ?? 0);
    if (!(capAmt > 0)) continue;
    const applies = String(sl.applies_to ?? 'total').toLowerCase();
    const members = applies === 'total' ? rows.filter((r) => r.class !== 'nme')
      : rows.filter((r) => r.group === applies && r.class !== 'nme');
    const groupAdm = members.reduce((t, r) => t + r.admissible, 0);
    if (groupAdm <= capAmt || !members.length) {
      subLimitDetail.push({ ...sl, applied: false, group_admissible: round2(groupAdm) });
      continue;
    }
    const scale = capAmt / groupAdm;
    for (const r of members) r.admissible *= scale;
    subLimitDetail.push({ ...sl, applied: true, group_admissible: round2(groupAdm), overflow_to_patient: round2(groupAdm - capAmt) });
  }

  // ---- totals ----
  const gross = rows.reduce((t, r) => t + r._raw, 0);
  const grossAdmissible = rows.reduce((t, r) => t + r.admissible, 0);
  const proportionateDeduction = rows.filter((r) => r.class === 'associated').reduce((t, r) => t + (r._raw - r._preSubLimit), 0);
  const subLimitOverflow = subLimitDetail.reduce((t, s) => t + (s.overflow_to_patient ?? 0), 0);

  const { copay, tpaBeforeCap, tpaApproval, topUpPay, beyondCover, insurerTotal } =
    applyClaimCeiling({ grossAdmissible, insurance: ins, baseAvailable, notes });

  const patient = {
    nme: round2(nme),
    copay: round2(copay),
    proportionate_deduction: round2(proportionateDeduction),
    sub_limit_overflow: round2(subLimitOverflow),
    room_upgrade_excess: 0, // eligibility upgrade not modelled at bucket level
    beyond_cover: round2(beyondCover),
  };
  patient.total = round2(Object.values(patient).reduce((a, b) => a + b, 0));

  return {
    mode: 'manual',
    gross: round2(gross),
    caps: {
      allowed_room_total: allowedRoom != null ? round2(allowedRoom) : null,
      room_charges: round2(roomCharges),
      ward_ratio: round2(wardRatio),
      los_days: losDays, icu_days: icuDays,
    },
    gross_admissible: round2(grossAdmissible),
    sub_limits: subLimitDetail,
    copay: round2(copay),
    tpa_before_cap: round2(tpaBeforeCap),
    base_available: round2(baseAvailable),
    tpa_approval: round2(tpaApproval),
    top_up_claim: round2(topUpPay),
    insurer_total: round2(insurerTotal),
    patient,
    check: { insurer_plus_patient: round2(insurerTotal + patient.total), gross_plus_upgrade: round2(gross) },
    rows: rows.map(({ _raw, _preSubLimit, roomLinked, ...r }) => ({ ...r, admissible: round2(r.admissible) })),
    notes,
  };
}
