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

  // copay on gross admissible
  let copay = 0;
  if (ins.copay?.value > 0) {
    copay = ins.copay.type === 'absolute'
      ? Number(ins.copay.value)
      : grossAdmissible * (Number(ins.copay.value) / 100);
  }

  const tpaBeforeCap = Math.max(0, grossAdmissible - copay);
  const tpaApproval = Math.min(tpaBeforeCap, baseAvailable);
  let overflow = Math.max(0, tpaBeforeCap - baseAvailable);

  // top-up (standard: per-claim deductible on this claim; super: consumed counts toward it)
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
