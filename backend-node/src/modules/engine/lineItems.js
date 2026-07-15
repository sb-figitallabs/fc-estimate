/**
 * Line Item Detail engine — computes every row of the workbook's calculation
 * sheet as pure JS, mirroring the Excel formulas 1:1
 * (spec/BUILD_SPEC.md §4J, spec/WORKBOOK_PARITY_SPEC.md §10).
 *
 * Every row produces 12 amount cells (general/twin/single × low/typical/high),
 * selected-room totals (W/X/Y semantics), plus qty/rate context.
 */
import { MODE_TO_PERCENTILE } from './rules.js';

export const dayRound = (x) => Math.trunc(x) + ((x % 1) > 0.3 ? 1 : 0);

export function snapToLadder(hours, ladder) {
  if (hours == null || !ladder.length) return null;
  if (hours <= 0) return 0;
  const sorted = [...ladder].sort((a, b) => a - b);
  if (hours <= sorted[0]) return sorted[0];
  if (hours >= sorted[sorted.length - 1]) return sorted[sorted.length - 1];
  let best = sorted[0], bestD = Math.abs(hours - best);
  for (const s of sorted.slice(1)) {
    const d = Math.abs(hours - s);
    if (d < bestD || (d === bestD && s > best)) { best = s; bestD = d; }
  }
  return best;
}

const modePick = (mode, low, typ, high) => (mode === 'Low' ? low : mode === 'Typical' ? typ : high);
const roomPick = (room, g, t, s) => (room === 'General' ? g : room === 'Twin' ? t : s);

/**
 * Resolve Builder driver block from basis summary row + control selections.
 */
export function resolveDrivers(basisRow, controls, otLadder) {
  const sel = (basis, p25, p50, p75, manual) =>
    basis === 'P25' ? p25 : basis === 'P50' ? p50 : basis === 'P75' ? p75 : (manual ?? p50);
  const isPct = (b) => b === 'P25' || b === 'P50' || b === 'P75';

  const icu = {
    p25: dayRound(basisRow.icu_p25), p50: dayRound(basisRow.icu_p50), p75: dayRound(basisRow.icu_p75),
  };
  icu.selected = dayRound(sel(controls.icu_basis, icu.p25, icu.p50, icu.p75, controls.icu_manual));
  const ward = {
    p25: dayRound(basisRow.ward_p25), p50: dayRound(basisRow.ward_p50), p75: dayRound(basisRow.ward_p75),
  };
  ward.selected = dayRound(sel(controls.ward_basis, ward.p25, ward.p50, ward.p75, controls.ward_manual));
  // Manual total-LOS without a manual ward/icu split: keep the ICU basis days
  // (capped at the stated LOS) and give the remaining days to the ward, so a
  // partial payload {los_basis:'manual', los_manual:N} still drives the stay.
  // When ward/icu are themselves manual they define the split and LOS follows.
  if (!isPct(controls.los_basis) && controls.los_manual != null
      && isPct(controls.ward_basis) && isPct(controls.icu_basis)) {
    const t = Math.max(0, dayRound(controls.los_manual));
    icu.selected = Math.min(icu.selected, t);
    ward.selected = Math.max(0, t - icu.selected);
  }
  const los = {
    p25: icu.p25 + ward.p25, p50: icu.p50 + ward.p50, p75: icu.p75 + ward.p75,
    selected: icu.selected + ward.selected,
  };
  const snap = (h) => snapToLadder(h, otLadder);
  const ot = {
    p25: snap(basisRow.ot_p25), p50: snap(basisRow.ot_p50), p75: snap(basisRow.ot_p75),
  };
  ot.selected = snap(sel(controls.ot_hours_basis, ot.p25, ot.p50, ot.p75, controls.ot_hours_manual));
  // Cath-lab hours driver (mirrors ot_hours). No tariff ladder snap: cath lab
  // is priced from the billed historical slot-family amounts, not per-hour
  // tariff slots — hours stay as entered (decimals allowed).
  const cath = {
    p25: basisRow.cath_hours_p25 ?? 0, p50: basisRow.cath_hours_p50 ?? 0, p75: basisRow.cath_hours_p75 ?? 0,
  };
  cath.selected = sel(controls.cath_hours_basis, cath.p25, cath.p50, cath.p75, controls.cath_hours_manual);
  cath.basis = isPct(controls.cath_hours_basis) ? controls.cath_hours_basis : 'manual';
  cath.manual = !isPct(controls.cath_hours_basis) && controls.cath_hours_manual != null
    ? controls.cath_hours_manual : null;
  return { los, icu, ward, ot, cath };
}

/**
 * Compute the full line-item table.
 *
 * ctx = {
 *   mode, room, pricingMode ('Cash / TR1' | 'Insurance / Org Tariff'),
 *   emergencyOt: 'Yes'|'No', mlc: 'Yes'|'No', robotic: 'Yes'|'No'|'',
 *   drivers, basisRow (resolved pharmacy/service basis summary row),
 *   svc: Map(item_code -> service stats row for service basis),
 *   rates: Map(item_code -> {general,twin,single,icu}) for resolved tariff,
 *   otSlots: Map(`mode|hours` -> slot row for resolved tariff),
 *   insuranceExcluded: Set(item_code),
 *   addOns: [{code,name,grouping,bucket,selected:'Include'|'Exclude'}...],
 *   roboticRows: [...optional robotic rows], includeProcedure: bool,
 *   procedure: {code,label},
 *   advanced: { otConsumablesApplied }, implants: { resolvedTypical },
 *   grouped: [{grouping,bucket,presence,p25Exact,p50Exact,p75Exact,captured,selected,insuranceExcluded,why}...],
 *   cathLab: {p25,p50,p75},
 * }
 */
export function computeLineItems(ctx) {
  const {
    mode, room, pricingMode, drivers, basisRow, svc, rates, otSlots,
    insuranceExcluded, addOns, procedure, advanced, implants, grouped, cathLab,
  } = ctx;
  const insuranceMode = pricingMode === 'Insurance / Org Tariff';
  const guard = (code, v) => (insuranceMode && code && insuranceExcluded.has(code) ? 0 : v);

  const rows = [];
  const rateOf = (code) => rates.get(code) || {};
  const svcOf = (code) => svc.get(code) || {};
  // Rate entry was back-filled from the TR1 (cash) tariff because the insurer's
  // org tariff had no usable rate — surface it on the row so the UI can mark it.
  const tr1Flag = (r) => (r && r.tr1_fallback ? { tr1_rate: true } : {});

  /** template row: qty percentiles × per-room rate */
  const template = (name, bucket, sub, code, { roboticControlled = false, how = 'Auto-Included', source = 'Template' } = {}) => {
    const s = svcOf(code);
    const r = rateOf(code);
    const q = { low: s.quantity_p25 ?? 0, typ: s.quantity_p50 ?? 0, high: s.quantity_p75 ?? 0 };
    const mk = (qty, rate) => {
      let v = qty * (rate ?? 0);
      if (roboticControlled) v = ctx.robotic === 'Yes' ? v : 0;
      return guard(code, v);
    };
    return push({
      name, bucket, sub, source, how, code, ...tr1Flag(r),
      qty: { selected: modePick(mode, q.low, q.typ, q.high), ...q },
      rate: { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 },
      cells: {
        general: [mk(q.low, r.general), mk(q.typ, r.general), mk(q.high, r.general)],
        twin: [mk(q.low, r.twin), mk(q.typ, r.twin), mk(q.high, r.twin)],
        single: [mk(q.low, r.single), mk(q.typ, r.single), mk(q.high, r.single)],
      },
    });
  };

  /** driver row: days × rate; icuOnly rows use the ICU rate in every room column */
  const driver = (name, bucket, sub, code, d, { icuRate = false, how } = {}) => {
    const r = rateOf(code);
    const rr = icuRate
      ? { general: r.icu ?? 0, twin: r.icu ?? 0, single: r.icu ?? 0 }
      : { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 };
    const mk = (days, rate) => guard(code, days * (rate ?? 0));
    return push({
      name, bucket, sub, source: 'Logic', how, code, ...tr1Flag(r),
      qty: { selected: d.selected, low: d.p25, typ: d.p50, high: d.p75 },
      rate: rr,
      cells: {
        general: [mk(d.p25, rr.general), mk(d.p50, rr.general), mk(d.p75, rr.general)],
        twin: [mk(d.p25, rr.twin), mk(d.p50, rr.twin), mk(d.p75, rr.twin)],
        single: [mk(d.p25, rr.single), mk(d.p50, rr.single), mk(d.p75, rr.single)],
      },
      // selected amount must follow the SELECTED days (manual overrides
      // included), not the mode-picked percentile cell
      selectedCells: {
        general: mk(d.selected, rr.general),
        twin: mk(d.selected, rr.twin),
        single: mk(d.selected, rr.single),
      },
    });
  };

  const fixedOne = (name, bucket, sub, code) => {
    const r = rateOf(code);
    const mk = (rate) => guard(code, rate ?? 0);
    return push({
      name, bucket, sub, source: 'Logic', how: 'Fixed 1', code, ...tr1Flag(r),
      qty: { selected: 1, low: 1, typ: 1, high: 1 },
      rate: { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 },
      cells: {
        general: [mk(r.general), mk(r.general), mk(r.general)],
        twin: [mk(r.twin), mk(r.twin), mk(r.twin)],
        single: [mk(r.single), mk(r.single), mk(r.single)],
      },
    });
  };

  let idx = 0;
  function push(row) {
    row.index = idx++;
    // selected totals per room column — day-driven rows carry an explicit
    // selectedCells (selected days x rate, honouring manual LOS/ward/ICU
    // overrides); every other row mode-picks that room's low/typ/high
    row.selected = row.selectedCells ?? {
      general: modePick(mode, ...row.cells.general),
      twin: modePick(mode, ...row.cells.twin),
      single: modePick(mode, ...row.cells.single),
    };
    delete row.selectedCells;
    rows.push(row);
    return row;
  }

  // ---- core rows ----
  if (ctx.templateRows) {
    // AUTO layout (docs 10/12): template rows are the cohort's default-included
    // items; the canonical logic rows below are shared across surgical families.
    const famRows = ctx.familyRows ?? {}; // { ot, cathLab, surgical, medicalRecords }
    for (const t of ctx.templateRows) {
      template(t.name, t.bucket, t.sub, t.code);
    }
    // Session-based treatments (15-Jul Q4: dialysis, phototherapy, newborn
    // care) bill per visit — LOS × ward/ICU room rows would fabricate lakhs
    // of room charges actual bills never carry, so they are suppressed.
    if (!ctx.sessionBased) {
    driver('Nursing - Room', 'Room Charges', 'Ward Care', 'ROM5189', drivers.ward, { how: 'Ward days x rate' });
    driver('Nursing - ICU', 'Room Charges', 'Critical Care', 'ROM5189', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
    driver('DMO', 'Room Charges', 'Ward Care', 'ROM0093', drivers.ward, { how: 'Ward days x rate' });
    driver('ICU - Surgical', 'Room Charges', 'Critical Care', 'ROM5009', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
    {
      const bedRates = {
        general: rateOf('ROM0001').general ?? 0,
        twin: rateOf('ROM0024').general ?? 0,
        single: rateOf('ROM0036').general ?? 0,
      };
      const d = drivers.ward;
      const mk = (days, rate) => days * rate;
      push({
        name: 'Bed Charges - Ward', bucket: 'Room Charges', sub: 'Ward Care', source: 'Logic',
        how: 'Ward days x room rate', code: 'ROOM_BED',
        ...(rateOf('ROM0001').tr1_fallback || rateOf('ROM0024').tr1_fallback || rateOf('ROM0036').tr1_fallback ? { tr1_rate: true } : {}),
        qty: { selected: d.selected, low: d.p25, typ: d.p50, high: d.p75 }, rate: bedRates,
        cells: {
          general: [mk(d.p25, bedRates.general), mk(d.p50, bedRates.general), mk(d.p75, bedRates.general)],
          twin: [mk(d.p25, bedRates.twin), mk(d.p50, bedRates.twin), mk(d.p75, bedRates.twin)],
          single: [mk(d.p25, bedRates.single), mk(d.p50, bedRates.single), mk(d.p75, bedRates.single)],
        },
        selectedCells: {
          general: mk(d.selected, bedRates.general),
          twin: mk(d.selected, bedRates.twin),
          single: mk(d.selected, bedRates.single),
        },
      });
    }
    }
    template('CSSD Charges', 'Procedure / OT Charges', 'OT Charges', 'RNS5005');
    // Medical Records: daycare bills MSC10 ("-1 DAY"), non-daycare RNS0120 ("> 1 DAY").
    // Historical data confirms: RNS0120 never appears in daycare admissions.
    if (famRows.medicalRecords === 'MSC10') {
      fixedOne('Medical Records - 1 Day', 'Bedside Services', 'Administrative', 'MSC10');
    } else {
      fixedOne('Medical Records', 'Bedside Services', 'Administrative', 'RNS0120');
    }
    if (ctx.includeProcedure !== false && procedure) {
      template(procedure.label, 'Procedure / OT Charges', 'OT Charges', procedure.code, {
        roboticControlled: /ROBO/i.test(procedure.label),
      });
    }
    if (famRows.surgical !== false) {
      fixedOne('Instrument Charges (Major)', 'Procedure / OT Charges', 'OT Charges', 'OTI0018');
      fixedOne('OT Disinfection Charges', 'Procedure / OT Charges', 'OT Charges', 'OTI0015');
      fixedOne('Post Surgery Recovery Charges', 'Procedure / OT Charges', 'OT Charges', 'OTC5005');
    }
    if (famRows.ot !== false) {
      const otMode = ctx.emergencyOt === 'Yes' ? 'emergency' : 'normal';
      const slot = otSlots.get(`${otMode}|${drivers.ot.selected}`) || {};
      const mkCells = (roomKey) => [slot[roomKey] ?? 0, slot[roomKey] ?? 0, slot[roomKey] ?? 0];
      push({
        name: 'OT Charges', bucket: 'Procedure / OT Charges', sub: 'OT Charges', source: 'Logic',
        how: 'Selected OT duration snapped to the nearest supported tariff OT slot using the normal or emergency ladder',
        code: slot.item_code ?? null, ...(slot.tr1_fallback ? { tr1_rate: true } : {}),
        otSlot: { hours: drivers.ot.selected, code: slot.item_code, label: slot.item_name, type: otMode === 'emergency' ? 'Emergency' : 'Normal', ...(slot.tr1_fallback ? { tr1_fallback: true } : {}) },
        qty: { selected: drivers.ot.selected, low: drivers.ot.p25, typ: drivers.ot.p50, high: drivers.ot.p75 },
        rate: { general: slot.general ?? 0, twin: slot.twin ?? 0, single: slot.single ?? 0 },
        cells: { general: mkCells('general'), twin: mkCells('twin'), single: mkCells('single') },
      });
    }
    if (famRows.cathLab !== false) {
      const c = cathLab || { p25: 0, p50: 0, p75: 0 };
      const cells = [c.p25 ?? 0, c.p50 ?? 0, c.p75 ?? 0];
      // Cath-lab hours control (mirrors OT hours): manual hours price at the
      // cohort's historical ₹/hour (typical amount ÷ typical billed hours —
      // derived from the SAME slot-family rows the amounts come from); a P25/P75
      // basis picks that percentile's historical amount. Default (P50, no
      // manual) keeps the mode-picked cell — identical to the untouched row.
      const ch = drivers.cath ?? {};
      const cathHoursP50 = basisRow.cath_hours_p50 ?? 0;
      const hourly = cathHoursP50 > 0 ? (c.p50 ?? 0) / cathHoursP50 : 0;
      const manualAmt = ch.manual != null && hourly > 0 ? Math.max(0, ch.manual) * hourly : null;
      const selV = manualAmt != null ? manualAmt
        : ch.basis === 'P25' ? cells[0]
        : ch.basis === 'P75' ? cells[2]
        : null;
      push({
        name: 'Cath Lab Charges', bucket: 'Procedure / OT Charges', sub: 'Cath Lab Hours',
        source: 'Historical Cath Lab Family',
        how: manualAmt != null
          ? 'Manual cath-lab hours x historical cath-lab rate per hour (typical billed amount / typical billed hours on the selected payer basis).'
          : 'Actual billed cath-lab slot-family P25 / P50 / P75 from the selected historical payer basis.',
        code: null,
        ...(cathHoursP50 > 0 ? {
          cathHours: {
            hours: ch.selected ?? cathHoursP50, p25: ch.p25, p50: ch.p50, p75: ch.p75,
            manual: ch.manual ?? null, rate_per_hour: hourly,
          },
        } : {}),
        qty: { selected: 1, low: 1, typ: 1, high: 1 }, rate: {},
        cells: { general: cells, twin: [...cells], single: [...cells] },
        ...(selV != null ? { selectedCells: { general: selV, twin: selV, single: selV } } : {}),
      });
    }
    if (!ctx.sessionBased) {
    driver('Intensivist Per Day', 'Room Charges', 'Critical Care', 'ICC0002', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
    driver('Assistant Intensivist Per Day', 'Room Charges', 'Critical Care', 'ICC0001', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
    driver('Ward Consumables', 'Room Charges', 'Ward Care', 'HSP5013', drivers.los, { how: 'LOS days x rate' });
    driver('Monitor Per Day', 'Room Charges', 'Critical Care', 'EME0019', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
    }
    {
      const r = rateOf('HSP0047');
      const qty = ctx.mlc === 'Yes' ? 1 : 0;
      const mk = (rate) => guard('HSP0047', qty * (rate ?? 0));
      push({
        name: 'MLC Charges', bucket: 'Bedside Services', sub: 'Administrative', source: 'Logic',
        how: 'Applied only when MLC input is Yes', code: 'HSP0047', ...tr1Flag(r),
        qty: { selected: qty, low: qty, typ: qty, high: qty },
        rate: { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 },
        cells: {
          general: [mk(r.general), mk(r.general), mk(r.general)],
          twin: [mk(r.twin), mk(r.twin), mk(r.twin)],
          single: [mk(r.single), mk(r.single), mk(r.single)],
        },
      });
    }
  } else {
  // FIXED knee layout (order = finalized robotic-TKR workbook; do not touch — parity-validated)
  template('X-RAY KNEE JOINT AP & LATERAL VIEW (BEDSIDE)', 'Investigations', 'Investigations', 'XRY5090');
  driver('Nursing - Room', 'Room Charges', 'Ward Care', 'ROM5189', drivers.ward, { how: 'Ward days x rate' });
  driver('Nursing - ICU', 'Room Charges', 'Critical Care', 'ROM5189', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
  driver('DMO', 'Room Charges', 'Ward Care', 'ROM0093', drivers.ward, { how: 'Ward days x rate' });
  driver('ICU - Surgical', 'Room Charges', 'Critical Care', 'ROM5009', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
  // Bed Charges - Ward: general rates of the 3 room codes become general/twin/single
  {
    const bedRates = {
      general: rateOf('ROM0001').general ?? 0,
      twin: rateOf('ROM0024').general ?? 0,
      single: rateOf('ROM0036').general ?? 0,
    };
    const d = drivers.ward;
    const mk = (days, rate) => days * rate;
    push({
      name: 'Bed Charges - Ward', bucket: 'Room Charges', sub: 'Ward Care', source: 'Logic',
      how: 'Ward days x room rate', code: 'ROOM_BED',
      ...(rateOf('ROM0001').tr1_fallback || rateOf('ROM0024').tr1_fallback || rateOf('ROM0036').tr1_fallback ? { tr1_rate: true } : {}),
      qty: { selected: d.selected, low: d.p25, typ: d.p50, high: d.p75 }, rate: bedRates,
      cells: {
        general: [mk(d.p25, bedRates.general), mk(d.p50, bedRates.general), mk(d.p75, bedRates.general)],
        twin: [mk(d.p25, bedRates.twin), mk(d.p50, bedRates.twin), mk(d.p75, bedRates.twin)],
        single: [mk(d.p25, bedRates.single), mk(d.p50, bedRates.single), mk(d.p75, bedRates.single)],
      },
      selectedCells: {
        general: mk(d.selected, bedRates.general),
        twin: mk(d.selected, bedRates.twin),
        single: mk(d.selected, bedRates.single),
      },
    });
  }
  template('CSSD CHARGES FOR GA', 'Procedure / OT Charges', 'OT Charges', 'RNS5005');
  fixedOne('Medical Records', 'Bedside Services', 'Administrative', 'RNS0120');
  template('PHYSIOTHERAPY PACKAGE 5 VISITS', 'Procedure / OT Charges', 'Physiotherapy', 'PHY5082');
  template('HAEMOGLOBIN', 'Investigations', 'Investigations', 'PAT0045');
  template('CBP (COMPLETE BLOOD PICTURE)', 'Investigations', 'Investigations', 'PAT0042');
  if (ctx.includeProcedure !== false) {
    template(procedure.label, 'Procedure / OT Charges', 'OT Charges', procedure.code, {
      roboticControlled: /ROBO/i.test(procedure.label),
    });
  }
  fixedOne('Instrument Charges (Major)', 'Procedure / OT Charges', 'OT Charges', 'OTI0018');
  fixedOne('OT Disinfection Charges', 'Procedure / OT Charges', 'OT Charges', 'OTI0015');
  fixedOne('Post Surgery Recovery Charges', 'Procedure / OT Charges', 'OT Charges', 'OTC5005');
  // OT Charges: slot rate = total
  {
    const otMode = ctx.emergencyOt === 'Yes' ? 'emergency' : 'normal';
    const slot = otSlots.get(`${otMode}|${drivers.ot.selected}`) || {};
    // selected slot rate applies to every mode column (parity: N–V map to K/L/M)
    const mkCells = (roomKey) => [slot[roomKey] ?? 0, slot[roomKey] ?? 0, slot[roomKey] ?? 0];
    push({
      name: 'OT Charges', bucket: 'Procedure / OT Charges', sub: 'OT Charges', source: 'Logic',
      how: 'Selected OT duration snapped to the nearest supported tariff OT slot using the normal or emergency ladder',
      code: slot.item_code ?? null, ...(slot.tr1_fallback ? { tr1_rate: true } : {}),
      otSlot: { hours: drivers.ot.selected, code: slot.item_code, label: slot.item_name, type: otMode === 'emergency' ? 'Emergency' : 'Normal', ...(slot.tr1_fallback ? { tr1_fallback: true } : {}) },
      qty: { selected: drivers.ot.selected, low: drivers.ot.p25, typ: drivers.ot.p50, high: drivers.ot.p75 },
      rate: { general: slot.general ?? 0, twin: slot.twin ?? 0, single: slot.single ?? 0 },
      cells: { general: mkCells('general'), twin: mkCells('twin'), single: mkCells('single') },
    });
  }
  // Cath Lab (historical family amounts; 0 for this family)
  {
    const c = cathLab || { p25: 0, p50: 0, p75: 0 };
    const cells = [c.p25 ?? 0, c.p50 ?? 0, c.p75 ?? 0];
    push({
      name: 'Cath Lab Charges', bucket: 'Procedure / OT Charges', sub: 'Cath Lab Hours',
      source: 'Historical Cath Lab Family',
      how: 'Actual billed cath-lab slot-family P25 / P50 / P75 from the selected historical payer basis.',
      code: null,
      qty: { selected: 1, low: 1, typ: 1, high: 1 }, rate: {},
      cells: { general: cells, twin: cells, single: cells },
    });
  }
  driver('Intensivist Per Day', 'Room Charges', 'Critical Care', 'ICC0002', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
  driver('Assistant Intensivist Per Day', 'Room Charges', 'Critical Care', 'ICC0001', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
  driver('Ward Consumables', 'Room Charges', 'Ward Care', 'HSP5013', drivers.los, { how: 'LOS days x rate' });
  template('Warmer', 'Bedside Services', 'Bedside', 'EME0087');
  driver('Monitor Per Day', 'Room Charges', 'Critical Care', 'EME0019', drivers.icu, { icuRate: true, how: 'ICU days x rate' });
  template('Oxygen Per Hour', 'Bedside Services', 'Bedside', 'EME0017');
  template('Diet Consultation', 'Bedside Services', 'Consultation', 'DIE0001');
  template('Dressing - Minor', 'Bedside Services', 'Bedside', 'CAS0007');
  template('Bedside ECG', 'Bedside Services', 'Bedside', 'CAR5341');
  template('Albumin', 'Investigations', 'Investigations', 'BIO0162');
  template('Sodium', 'Investigations', 'Investigations', 'BIO0004');
  template('Electrolytes', 'Investigations', 'Investigations', 'BIO0003');
  template('Creatinine', 'Investigations', 'Investigations', 'BIO0002');
  template('Urea', 'Investigations', 'Investigations', 'BIO0001');
  // MLC
  {
    const r = rateOf('HSP0047');
    const qty = ctx.mlc === 'Yes' ? 1 : 0;
    const mk = (rate) => guard('HSP0047', qty * (rate ?? 0));
    push({
      name: 'MLC Charges', bucket: 'Bedside Services', sub: 'Administrative', source: 'Logic',
      how: 'Applied only when MLC input is Yes', code: 'HSP0047',
      qty: { selected: qty, low: qty, typ: qty, high: qty },
      rate: { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 },
      cells: {
        general: [mk(r.general), mk(r.general), mk(r.general)],
        twin: [mk(r.twin), mk(r.twin), mk(r.twin)],
        single: [mk(r.single), mk(r.single), mk(r.single)],
      },
    });
  }
  } // end fixed knee layout

  // Robotic add-on charge (15-Jul #27): when the family resolution said
  // "base family + robotic add-on" (or per-payor presence demands it), the
  // charge is a real row — priced from the payor tariff's contracted robotic
  // item (e.g. TR290 "ROBO (TKR) - UNILATERAL" ₹1,20,000) or, failing that,
  // the cohort's billed robotic history. Optional (not-included) state keeps
  // the row visible at ₹0 so the UI can offer the convert-to-robotic prompt.
  if (ctx.roboticAddon) {
    const ra = ctx.roboticAddon;
    const inc = ra.included === true;
    const tariffPriced = ra.pricing === 'tariff';
    const mkc = (v) => guard(ra.item_code, inc ? (v ?? 0) : 0);
    const cellsFor = (rk) => (tariffPriced
      ? [mkc(ra.rate?.[rk]), mkc(ra.rate?.[rk]), mkc(ra.rate?.[rk])]
      : [mkc(ra.amount), mkc(ra.amount), mkc(ra.amount)]);
    push({
      name: ra.item_name, bucket: inc ? 'Procedure / OT Charges' : 'Optional Add-Ons',
      sub: 'OT Charges',
      source: tariffPriced ? 'Tariff' : 'History',
      how: tariffPriced
        ? 'Robotic add-on at the payor tariff\'s contracted robotic charge'
        : 'Robotic add-on at the cohort\'s typical billed robotic amount',
      code: ra.item_code, robotic_addon: true, included: inc,
      ...(ra.tr1_rate ? { tr1_rate: true } : {}),
      qty: { selected: inc ? 1 : 0, low: inc ? 1 : 0, typ: inc ? 1 : 0, high: inc ? 1 : 0 },
      rate: tariffPriced
        ? { general: ra.rate?.general ?? 0, twin: ra.rate?.twin ?? 0, single: ra.rate?.single ?? 0 }
        : {},
      cells: { general: cellsFor('general'), twin: cellsFor('twin'), single: cellsFor('single') },
    });
  }

  // placeholders for drug admin + PF (filled after pharmacy rows)
  const drugAdminIdx = rows.length;
  push({ name: 'Drug Administration Charges', bucket: 'Drug Administration Charges', sub: 'Pharmacy Related', source: 'Logic', how: '12.5% of pharmacy total', code: null, qty: {}, rate: {}, cells: { general: [0, 0, 0], twin: [0, 0, 0], single: [0, 0, 0] } });
  const pfStart = rows.length;
  for (const [name, how] of [
    ['Surgeon', 'Cash PF % of pre-PF subtotal'],
    ['Assistant Surgeon', 'Cash PF % of surgeon fee'],
    ['Anesthetist', 'Cash PF % of surgeon fee'],
    ['Assistant Anesthetist', 'Cash PF % of anesthetist fee'],
  ]) {
    push({ name, bucket: 'Professional Fees', sub: 'Professional Fees', source: 'Logic', how, code: null, qty: {}, rate: {}, cells: { general: [0, 0, 0], twin: [0, 0, 0], single: [0, 0, 0] } });
  }

  // pharmacy rows
  const pharmStart = rows.length;
  const perDay = (kLow, kTyp, kHigh) => {
    const d = drivers.los.selected;
    const cells = [d * (basisRow[kLow] ?? 0), d * (basisRow[kTyp] ?? 0), d * (basisRow[kHigh] ?? 0)];
    return cells;
  };
  // Daycare-style families (stay ≈ 0) take IP pharmacy from bucket quartiles directly;
  // stay-based families scale the per-day baseline by selected LOS (docs 09/12).
  const ipBucketMode = ctx.ipPharmacyMode === 'bucket';
  {
    const cells = ipBucketMode
      ? [basisRow.ip_drugs_p25 ?? 0, basisRow.ip_drugs_p50 ?? 0, basisRow.ip_drugs_p75 ?? 0]
      : perDay('ip_drugs_day_p25', 'ip_drugs_day_p50', 'ip_drugs_day_p75');
    push({
      name: 'IP Drugs & Medications', bucket: 'Pharmacy', sub: 'IP Pharmacy', source: 'History',
      how: ipBucketMode ? 'Bucket quartiles' : 'Historic per-LOS-day percentile x selected LOS', code: null,
      qty: ipBucketMode ? {} : { selected: drivers.los.selected, low: drivers.los.p25, typ: drivers.los.p50, high: drivers.los.p75 },
      rate: ipBucketMode ? {} : { general: basisRow.ip_drugs_day_p50 ?? 0, twin: basisRow.ip_drugs_day_p50 ?? 0, single: basisRow.ip_drugs_day_p50 ?? 0 },
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }
  {
    const cells = ipBucketMode
      ? [basisRow.ip_consumables_p25 ?? 0, basisRow.ip_consumables_p50 ?? 0, basisRow.ip_consumables_p75 ?? 0]
      : perDay('ip_consumables_day_p25', 'ip_consumables_day_p50', 'ip_consumables_day_p75');
    push({
      name: 'IP Consumables', bucket: 'Pharmacy', sub: 'IP Pharmacy', source: 'History',
      how: ipBucketMode ? 'Bucket quartiles' : 'Historic per-LOS-day percentile x selected LOS', code: null,
      qty: ipBucketMode ? {} : { selected: drivers.los.selected, low: drivers.los.p25, typ: drivers.los.p50, high: drivers.los.p75 },
      rate: ipBucketMode ? {} : { general: basisRow.ip_consumables_day_p50 ?? 0, twin: basisRow.ip_consumables_day_p50 ?? 0, single: basisRow.ip_consumables_day_p50 ?? 0 },
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }
  {
    const cells = [basisRow.ot_drugs_p25 ?? 0, basisRow.ot_drugs_p50 ?? 0, basisRow.ot_drugs_p75 ?? 0];
    push({
      name: 'OT Drugs & Medications', bucket: 'Pharmacy', sub: 'OT Pharmacy', source: 'History',
      how: 'Bucket quartiles', code: null, qty: {}, rate: {},
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }
  {
    const cells = [basisRow.ot_consumables_p25 ?? 0, advanced.otConsumablesApplied, basisRow.ot_consumables_p75 ?? 0];
    push({
      name: 'OT Consumables', bucket: 'Pharmacy', sub: 'OT Pharmacy', source: 'Advanced',
      how: 'OT consumables variance controls', code: null, qty: {}, rate: {},
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }
  {
    const cells = [basisRow.implants_p25 ?? 0, implants.resolvedTypical, basisRow.implants_p75 ?? 0];
    push({
      name: 'Implants', bucket: 'Pharmacy', sub: 'Implants', source: 'Advanced',
      how: 'Implant variance controls', code: null, qty: {}, rate: {},
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }
  const pharmEnd = rows.length - 1;

  // optional add-on rows
  for (const a of addOns) {
    const s = svcOf(a.code);
    const r = rateOf(a.code);
    const inc = a.selected === 'Include';
    const q = { low: s.quantity_p25 ?? 0, typ: s.quantity_p50 ?? 0, high: s.quantity_p75 ?? 0 };
    const mk = (qty, rate) => guard(a.code, inc ? qty * (rate ?? 0) : 0);
    // Included add-ons surface in their service's real clinical bucket (e.g.
    // CRP → Investigations) so the FC sees them where they'd look for them;
    // 'Optional Add-Ons' stays only as the fallback for rows with no usable
    // bucket, and for excluded (₹0) rows so clinical buckets aren't padded
    // with dozens of zero-amount candidates.
    const hasRealBucket = a.bucket && !/remove|unmapped/i.test(a.bucket);
    const bucket = inc && hasRealBucket ? a.bucket : 'Optional Add-Ons';
    push({
      name: a.name, bucket, sub: a.grouping, source: 'Advanced',
      how: 'Include / Exclude selection', code: a.code, addOn: true, included: inc, ...tr1Flag(r),
      qty: { selected: modePick(mode, q.low, q.typ, q.high), ...q },
      rate: { general: r.general ?? 0, twin: r.twin ?? 0, single: r.single ?? 0 },
      cells: {
        general: [mk(q.low, r.general), mk(q.typ, r.general), mk(q.high, r.general)],
        twin: [mk(q.low, r.twin), mk(q.typ, r.twin), mk(q.high, r.twin)],
        single: [mk(q.low, r.single), mk(q.typ, r.single), mk(q.high, r.single)],
      },
    });
  }

  // grouped residual rows
  for (const gRow of grouped) {
    // selected add-on amounts from same grouping (per mode column)
    const addSum = (modeIdx) => addOns.reduce((t, a) => {
      if (a.grouping !== gRow.grouping || a.selected !== 'Include') return t;
      const s = svcOf(a.code), r = rateOf(a.code);
      const qty = [s.quantity_p25 ?? 0, s.quantity_p50 ?? 0, s.quantity_p75 ?? 0][modeIdx];
      const rate = roomPick(room, r.general ?? 0, r.twin ?? 0, r.single ?? 0);
      return t + guard(a.code, qty * rate);
    }, 0);
    const net = [
      Math.max(0, gRow.p25Exact - gRow.captured - addSum(0)),
      Math.max(0, gRow.p50Exact - gRow.captured - addSum(1)),
      Math.max(0, gRow.p75Exact - gRow.captured - addSum(2)),
    ];
    const inc = gRow.selected === 'Include';
    const excluded = insuranceMode && gRow.insuranceExcluded;
    const cells = net.map((v) => (excluded ? 0 : inc ? v : 0));
    push({
      name: `${gRow.grouping} Residual`, bucket: gRow.bucket, sub: gRow.grouping,
      source: 'Grouped Residual',
      how: 'Mode-aware grouped residual net of selected child add-ons from same grouping',
      code: null, groupedResidual: true, included: inc, netResidual: net,
      qty: {}, rate: {},
      cells: { general: cells, twin: [...cells], single: [...cells] },
    });
  }

  // ---- subtotal / drug admin / PF / grand total ----
  const cols = ['general', 'twin', 'single'];
  const sumCells = (pred) => {
    const acc = { general: [0, 0, 0], twin: [0, 0, 0], single: [0, 0, 0] };
    rows.forEach((row, i) => {
      if (!pred(row, i)) return;
      for (const c of cols) for (let m = 0; m < 3; m++) acc[c][m] += row.cells[c][m] ?? 0;
    });
    return acc;
  };

  // drug admin = 12.5% of pharmacy rows (cash only)
  {
    const pharm = sumCells((_, i) => i >= pharmStart && i <= pharmEnd);
    const da = rows[drugAdminIdx];
    for (const c of cols) da.cells[c] = pharm[c].map((v) => (insuranceMode ? 0 : 0.125 * v));
    da.selected = { general: modePick(mode, ...da.cells.general), twin: modePick(mode, ...da.cells.twin), single: modePick(mode, ...da.cells.single) };
  }
  // subtotal before PF = all rows except PF rows
  const subtotal = sumCells((_, i) => i < pfStart || i > pfStart + 3);
  // selected subtotal sums the rows' SELECTED amounts (day-driven rows carry
  // manual LOS/ward/ICU overrides there that the percentile cells don't have)
  const subtotalSelected = { general: 0, twin: 0, single: 0 };
  rows.forEach((row, i) => {
    if (i >= pfStart && i <= pfStart + 3) return;
    for (const c of cols) subtotalSelected[c] += row.selected[c] ?? 0;
  });
  // PF cascade
  const pf = { surgeon: {}, asstSurgeon: {}, anesthetist: {}, asstAnesthetist: {} };
  const pfSel = { surgeon: {}, asstSurgeon: {}, anesthetist: {}, asstAnesthetist: {} };
  for (const c of cols) {
    pf.surgeon[c] = subtotal[c].map((v) => (insuranceMode ? 0 : 0.25 * v));
    pf.asstSurgeon[c] = pf.surgeon[c].map((v) => (insuranceMode ? 0 : 0.15 * v));
    pf.anesthetist[c] = pf.surgeon[c].map((v) => (insuranceMode ? 0 : 0.25 * v));
    pf.asstAnesthetist[c] = pf.anesthetist[c].map((v) => (insuranceMode ? 0 : 0.25 * v));
    pfSel.surgeon[c] = insuranceMode ? 0 : 0.25 * subtotalSelected[c];
    pfSel.asstSurgeon[c] = insuranceMode ? 0 : 0.15 * pfSel.surgeon[c];
    pfSel.anesthetist[c] = insuranceMode ? 0 : 0.25 * pfSel.surgeon[c];
    pfSel.asstAnesthetist[c] = insuranceMode ? 0 : 0.25 * pfSel.anesthetist[c];
  }
  const pfRows = [pf.surgeon, pf.asstSurgeon, pf.anesthetist, pf.asstAnesthetist];
  const pfSelRows = [pfSel.surgeon, pfSel.asstSurgeon, pfSel.anesthetist, pfSel.asstAnesthetist];
  pfRows.forEach((p, k) => {
    const row = rows[pfStart + k];
    for (const c of cols) row.cells[c] = p[c];
    row.selected = { ...pfSelRows[k] };
  });
  // grand total
  const grand = { general: [0, 0, 0], twin: [0, 0, 0], single: [0, 0, 0] };
  for (const c of cols) for (let m = 0; m < 3; m++) {
    grand[c][m] = subtotal[c][m] + pfRows.reduce((t, p) => t + p[c][m], 0);
  }
  const grandSelected = { general: 0, twin: 0, single: 0 };
  for (const c of cols) {
    grandSelected[c] = subtotalSelected[c] + pfSelRows.reduce((t, p) => t + p[c], 0);
  }
  const finalEstimate = roomPick(room, grandSelected.general, grandSelected.twin, grandSelected.single);

  return {
    rows,
    subtotal: { ...subtotal, selected: subtotalSelected },
    grandTotal: { ...grand, selected: grandSelected },
    finalEstimate,
    indices: { drugAdmin: drugAdminIdx, pfStart, pharmStart, pharmEnd },
  };
}

export { modePick, roomPick };
