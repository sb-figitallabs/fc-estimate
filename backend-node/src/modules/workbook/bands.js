/**
 * DATA BANDS — every workbook cell that carries cohort/engine data is
 * overridden here from the live `estimate` payload, so the generated file is
 * data-driven while layout/formulas replay the reference template.
 *
 * Returns { [sheetName]: { [addr]: {v: staticValue} | {r: cachedFormulaResult} } }.
 *
 * Cells NOT overridden keep the template value (layout constants, note texts,
 * and a few blocks the engine payload does not carry — see KNOWN_TEMPLATE_BLOCKS
 * at the bottom). fullCalcOnLoad refreshes every cached formula on open.
 */

import { quartilesInclusive } from '../engine/stats.js';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const round4 = (x) => Math.round((x + Number.EPSILON) * 10000) / 10000;
/** CSV-style string rendering used by the Reference left mini-tables. */
const pyStr = (x) => {
  if (x === null || x === undefined) return '';
  const r = round2(Number(x));
  return String(r);
};

// Fixed estimate-template service codes (BUILD_SPEC §5) — used for the
// Grouping Review "Made It To FC Default" flag.
const FIXED_TEMPLATE_CODES = new Set([
  'XRY5090', 'PHY5082', 'PAT0045', 'PAT0042', 'OTI0098', 'EME0087', 'EME0017',
  'DIE0001', 'CAS0007', 'CAR5341', 'BIO0162', 'BIO0004', 'BIO0003', 'BIO0002', 'BIO0001',
]);

const BASIS_LABELS = ['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance', 'Corporate', 'Insurance All', 'All Payers'];
const basisFilter = {
  'Cash': (r) => r.payor_bucket === 'Cash',
  'GIPSA Insurance': (r) => r.payor_bucket === 'GIPSA Insurance',
  'Non-GIPSA Insurance': (r) => r.payor_bucket === 'Non-GIPSA Insurance',
  'Corporate': (r) => r.payor_bucket === 'Corporate',
  'Insurance All': (r) => r.payor_bucket === 'GIPSA Insurance' || r.payor_bucket === 'Non-GIPSA Insurance',
  'All Payers': () => true,
};

/**
 * Per-admission pharmacy usage per (item_code, item_name), NET of cleaned
 * returns (returns are subtracted from the IP section first, remainder from
 * OT) — this matches the finalized builder's "*_typical_cleaned" columns.
 */
function nettedAdmissionPharmacy(row) {
  const per = new Map();
  for (const it of (row.cleaned_pharmacy?.items || [])) {
    const key = `${it.item_code ?? ''}|${it.item_name ?? ''}`;
    const cur = per.get(key) || {
      code: it.item_code ?? '', name: it.item_name ?? '', classification: it.classification ?? '',
      ot_q: 0, ot_a: 0, ip_q: 0, ip_a: 0, rates: [],
    };
    const qty = Number(it.raw_quantity ?? 0);
    const amt = Number(it.reconstructed_gross_amount ?? (qty * Number(it.sale_rate ?? 0)));
    if ((it.pharmacy_section || '').toUpperCase() === 'OT') { cur.ot_q += qty; cur.ot_a += amt; }
    else { cur.ip_q += qty; cur.ip_a += amt; }
    if (it.sale_rate != null) cur.rates.push(Number(it.sale_rate));
    per.set(key, cur);
  }
  for (const rt of (row.cleaned_returns?.items || [])) {
    const key = `${rt.item_code ?? ''}|${rt.item_name ?? ''}`;
    const cur = per.get(key);
    if (!cur) continue;
    let rq = Number(rt.raw_return_quantity ?? 0);
    let ra = Number(rt.reconstructed_return_amount ?? (rq * Number(rt.sale_rate ?? 0)));
    const ipTakeQ = Math.min(cur.ip_q, rq);
    const ipTakeA = Math.min(cur.ip_a, ra);
    cur.ip_q -= ipTakeQ; rq -= ipTakeQ;
    cur.ip_a -= ipTakeA; ra -= ipTakeA;
    cur.ot_q -= rq; cur.ot_a -= ra;
    if (cur.ot_q < 0) cur.ot_q = 0;
    if (cur.ot_a < 0) cur.ot_a = 0;
  }
  return per;
}

/** Cohort pharmacy item stats (netted medians) per basis — key `basis|code|name`. */
function buildNettedPharmacyStats(cohortRows) {
  const out = new Map();
  for (const basis of BASIS_LABELS) {
    const rows = cohortRows.filter(basisFilter[basis]);
    const n = rows.length;
    if (!n) continue;
    const perItem = new Map();
    for (const r of rows) {
      for (const [key, agg] of nettedAdmissionPharmacy(r)) {
        if (!perItem.has(key)) perItem.set(key, []);
        perItem.get(key).push(agg);
      }
    }
    for (const [key, list] of perItem) {
      const med = (f) => quartilesInclusive(list.map(f)).p50;
      const money = (x) => Number(x.toFixed(2));
      out.set(`${basis}|${key}`, {
        basis_label: basis,
        item_code: list[0].code,
        item_name: list[0].name,
        name_key: `${basis}|${list[0].name}`,
        case_count: list.length,
        case_presence_rate: (list.length / n) * 100,
        ot_quantity_typical: med((x) => x.ot_q),
        ot_amount_typical: money(med((x) => x.ot_a)),
        ip_quantity_typical: med((x) => x.ip_q),
        ip_amount_typical: money(med((x) => x.ip_a)),
        overall_quantity_typical: med((x) => x.ot_q + x.ip_q),
        overall_amount_typical: money(med((x) => x.ot_a + x.ip_a)),
      });
    }
  }
  return out;
}

export function buildBands(estimate, input, template) {
  const bands = {};
  const put = (sheet, addr, entry) => {
    (bands[sheet] ||= {})[addr] = entry;
  };
  const T = (sheet) => template.sheets[sheet]?.cells || {};
  const tVal = (sheet, addr) => {
    const c = T(sheet)[addr];
    return c ? c.v : undefined;
  };

  const ctx = estimate.resolved_context;
  const controls = input.controls ?? {};
  const room = ctx.room_type;                 // 'General' | 'Twin' | 'Single'
  const roomKey = room.toLowerCase();
  const mode = ctx.estimate_mode;             // 'Low' | 'Typical' | 'High'
  const modeIdx = { Low: 0, Typical: 1, High: 2 }[mode];
  const bases = ctx.payer_bases;
  const svcBasis = bases.service_basis.selected_basis;
  const pharmBasis = bases.pharmacy_basis.selected_basis;
  const pfBasis = bases.pf_basis.selected_basis;
  const art = estimate.artifacts;
  const cohortN = ctx.cohort_case_count;
  const items = estimate.line_items;
  const drivers = estimate.drivers;
  const adv = estimate.advanced_controls;
  const slc = estimate.service_line_count;
  const insuranceMode = ctx.pricing_mode === 'Insurance / Org Tariff';

  const basisRow = (label) => art.basisSummary.find((b) => b.basis_label === label);
  const svcStatByKey = new Map(art.svcStats.map((s) => [s.key, s]));
  const pharmStatByKey = buildNettedPharmacyStats(art.cohortRows);
  const actualByKey = new Map(art.actualMetrics.map((a) => [a.key, a]));
  const pfByBucket = new Map(art.pfSummary.map((p) => [p.payor_bucket, p]));

  // =========================================================== Builder
  {
    const B = 'Builder';
    put(B, 'E2', { v: ctx.pricing_mode });
    put(B, 'E3', { v: controls.payer_basis ?? 'Auto (Recommended)' });
    put(B, 'B4', { v: room });
    put(B, 'B5', { v: mode });
    put(B, 'B6', { v: controls.emergency_ot ?? 'No' });
    put(B, 'E6', { v: controls.mlc ?? 'No' });
    put(B, 'B8', { v: ctx.robotic.selection });
    put(B, 'E8', { v: ctx.robotic.presence_rate / 100 });
    put(B, 'B3', { r: ctx.pricing_mode });
    put(B, 'E4', { r: ctx.payor_bucket });
    put(B, 'E5', { r: ctx.tariff.tariff_cd });
    put(B, 'G4', { r: ctx.tariff.tariff_name });
    put(B, 'G5', { r: pharmBasis });
    put(B, 'G6', { r: svcBasis });
    put(B, 'G7', { r: pfBasis });
    // driver grid
    const dmap = { 10: 'los', 11: 'icu', 12: 'ward', 13: 'ot' };
    for (const [row, key] of Object.entries(dmap)) {
      put(B, `B${row}`, { r: drivers[key].p25 });
      put(B, `C${row}`, { r: drivers[key].p50 });
      put(B, `D${row}`, { r: drivers[key].p75 });
      put(B, `G${row}`, { r: drivers[key].selected });
    }
    if (ctx.ot_slot) {
      put(B, 'B14', { r: ctx.ot_slot.hours });
      put(B, 'B15', { r: ctx.ot_slot.code });
      put(B, 'B16', { r: ctx.ot_slot.label });
      put(B, 'B17', { r: ctx.ot_slot.type });
    }
  }

  // =========================================================== Line Item Detail
  {
    const L = 'Line Item Detail';
    const tpl = T(L);
    // Template formula addresses assume the reference row count; warn when a
    // future family produces a different row set (acceptable degradation —
    // extra rows would need formula cloning by archetype).
    const tplItemRows = Object.keys(tpl).filter((a) => /^A\d+$/.test(a)).length - 3; // header + 2 total rows
    if (items.length !== tplItemRows) {
      // generateWorkbook switches these sheets to the dynamic builders
      // (dynamicSheets.js) in this case — bands for them go unused.
      console.info(`[workbook] row counts differ from template (${items.length} vs ${tplItemRows}) — dynamic sheet builders take over`);
    }
    items.forEach((it, i) => {
      const row = 2 + i;
      put(L, `A${row}`, { v: it.name });
      put(L, `B${row}`, { v: it.bucket });
      put(L, `C${row}`, { v: it.sub });
      put(L, `D${row}`, { v: it.source });
      put(L, `E${row}`, { v: it.how });
      const fCell = tpl[`F${row}`];
      if (it.code !== undefined && fCell) {
        if (fCell.f !== undefined) put(L, `F${row}`, { r: it.code });
        else put(L, `F${row}`, { v: it.code });
      }
      const setNum = (addr, val) => {
        if (val === undefined || val === null) return;
        const cell = tpl[addr];
        if (!cell) return;
        if (cell.f !== undefined) put(L, addr, { r: val });
        else put(L, addr, { v: val });
      };
      setNum(`G${row}`, it.qty?.selected);
      setNum(`H${row}`, it.qty?.low);
      setNum(`I${row}`, it.qty?.typ);
      setNum(`J${row}`, it.qty?.high);
      setNum(`K${row}`, it.rate?.general);
      setNum(`L${row}`, it.rate?.twin);
      setNum(`M${row}`, it.rate?.single);
      const cols = { N: ['general', 0], O: ['general', 1], P: ['general', 2],
                     Q: ['twin', 0], R: ['twin', 1], S: ['twin', 2],
                     T: ['single', 0], U: ['single', 1], V: ['single', 2] };
      for (const [col, [rk, mi]] of Object.entries(cols)) setNum(`${col}${row}`, it.cells?.[rk]?.[mi]);
      setNum(`W${row}`, it.selected?.general);
      setNum(`X${row}`, it.selected?.twin);
      setNum(`Y${row}`, it.selected?.single);
    });
    const totalsRow = (row, tot) => {
      const cols = { N: ['general', 0], O: ['general', 1], P: ['general', 2],
                     Q: ['twin', 0], R: ['twin', 1], S: ['twin', 2],
                     T: ['single', 0], U: ['single', 1], V: ['single', 2] };
      for (const [col, [rk, mi]] of Object.entries(cols)) put(L, `${col}${row}`, { r: tot[rk][mi] });
      put(L, `W${row}`, { r: tot.selected.general });
      put(L, `X${row}`, { r: tot.selected.twin });
      put(L, `Y${row}`, { r: tot.selected.single });
    };
    const subtotalRow = 2 + items.length;
    totalsRow(subtotalRow, estimate.subtotal);
    totalsRow(subtotalRow + 1, estimate.grand_total);
  }

  // =========================================================== Estimate Summary
  {
    const S = 'Estimate Summary';
    put(S, 'E2', { r: estimate.final_estimate });
    // room × mode matrix rows 7..9 = General/Twin/Single, cols E/F/G = Low/Typ/High
    const gt = estimate.grand_total;
    [['7', 'general'], ['8', 'twin'], ['9', 'single']].forEach(([row, rk]) => {
      put(S, `E${row}`, { r: gt[rk][0] });
      put(S, `F${row}`, { r: gt[rk][1] });
      put(S, `G${row}`, { r: gt[rk][2] });
    });
    // bucket table B13..B20 (selected room, rows 2..73 of LID)
    const bucketLabels = ['Room Charges', 'Investigations', 'Procedure / OT Charges',
      'Bedside Services', 'Pharmacy', 'Drug Administration Charges', 'Professional Fees', 'Optional Add-Ons'];
    const bucketSum = new Map(bucketLabels.map((b) => [b, 0]));
    for (const it of items) {
      if (bucketSum.has(it.bucket)) bucketSum.set(it.bucket, bucketSum.get(it.bucket) + (it.selected?.[roomKey] ?? 0));
    }
    bucketLabels.forEach((b, i) => put(S, `B${13 + i}`, { r: bucketSum.get(b) }));
    put(S, 'B21', { r: estimate.final_estimate });
    const pfHist = pfByBucket.get(pfBasis);
    if (pfHist) {
      put(S, 'B22', { r: pfHist.collectible_p50 });
      put(S, 'B23', { r: estimate.final_estimate - bucketSum.get('Professional Fees') + pfHist.collectible_p50 });
    }
    // Historical case count behind this estimate (matches the UI's
    // "N Historical Cases"). L12/M12 are empty in the template, directly
    // below the "Cohort Basis Counts" block (L6:M11) — generateWorkbook
    // writes non-template band cells as static values.
    put(S, 'L12', { v: 'Historical Cases (All Payers)' });
    put(S, 'M12', { v: cohortN });
  }

  // =========================================================== Advanced Controls
  {
    const A = 'Advanced Controls';
    const oc = adv.ot_consumables;
    put(A, 'B5', { r: oc.p25 });
    put(A, 'C5', { r: oc.p50 });
    put(A, 'D5', { r: oc.p75 });
    put(A, 'C6', { r: oc.applied });
    oc.shortlist.forEach((s, i) => {
      const row = 8 + i;
      put(A, `A${row}`, { v: s.item_name });
      put(A, `B${row}`, { r: s.ot_quantity_typical });
      put(A, `C${row}`, { r: s.ot_quantity_typical > 0 ? s.ot_amount_typical / s.ot_quantity_typical : 0 });
      put(A, `D${row}`, { r: s.ot_amount_typical });
      put(A, `E${row}`, { r: s.case_presence_rate });
      put(A, `F${row}`, { r: s.expected_contribution });
      put(A, `G${row}`, { r: s.cumulative_share });
      put(A, `H${row}`, { v: s.selected });
    });
  }

  // =========================================================== Service Add-Ons
  {
    const S = 'Service Add-Ons';
    const addOnItems = items.filter((it) => it.addOn); // included add-ons carry their real clinical bucket
    estimate.add_ons.forEach((a, i) => {
      const row = 7 + i;
      const li = addOnItems[i];
      put(S, `A${row}`, { v: a.name });
      put(S, `B${row}`, { v: a.grouping });
      put(S, `C${row}`, { r: a.presence });
      put(S, `D${row}`, { r: a.q25 });
      put(S, `E${row}`, { r: a.q50 });
      put(S, `F${row}`, { r: a.q75 });
      const rate = li?.rate?.[roomKey];
      if (rate !== undefined) {
        put(S, `G${row}`, { r: rate });
        put(S, `H${row}`, { r: insuranceMode ? 0 : a.q50 * rate });
        put(S, `J${row}`, { r: insuranceMode ? 0 : a.q25 * rate });
        put(S, `K${row}`, { r: insuranceMode ? 0 : a.q50 * rate });
        put(S, `L${row}`, { r: insuranceMode ? 0 : a.q75 * rate });
      }
      put(S, `I${row}`, { v: a.selected });
      put(S, `M${row}`, { v: a.code });
    });
    // totals over included add-ons
    let tLow = 0, tTyp = 0, tHigh = 0;
    estimate.add_ons.forEach((a, i) => {
      if (a.selected !== 'Include') return;
      const rate = addOnItems[i]?.rate?.[roomKey] ?? 0;
      tLow += a.q25 * rate; tTyp += a.q50 * rate; tHigh += a.q75 * rate;
    });
    put(S, 'B5', { r: tLow });
    put(S, 'C5', { r: tTyp });
    put(S, 'D5', { r: tHigh });
    // service-line-count alert panel
    put(S, 'P5', { r: slc.p25 });
    put(S, 'P6', { r: slc.p50 });
    put(S, 'P7', { r: slc.p75 });
    put(S, 'P8', { r: slc.base });
    put(S, 'P9', { r: slc.selectedAddOns });
    put(S, 'P10', { r: slc.current });
    put(S, 'P11', {
      r: slc.current < slc.p25 ? 'Below historical P25'
        : slc.current > slc.p75 ? 'Above historical P75' : 'Within historical range',
    });
  }

  // =========================================================== Grouped Adjustments
  {
    const G = 'Grouped Adjustments';
    const addOnItems = items.filter((it) => it.addOn); // included add-ons carry their real clinical bucket
    const addonSums = (grouping) => {
      let low = 0, typ = 0, high = 0;
      estimate.add_ons.forEach((a, i) => {
        if (a.grouping !== grouping || a.selected !== 'Include') return;
        const rate = addOnItems[i]?.rate?.[roomKey] ?? 0;
        low += a.q25 * rate; typ += a.q50 * rate; high += a.q75 * rate;
      });
      return [low, typ, high];
    };
    let sLow = 0, sTyp = 0, sHigh = 0, count = 0;
    estimate.grouped_adjustments.forEach((g, i) => {
      const row = 7 + i;
      const [oLow, oTyp, oHigh] = addonSums(g.grouping);
      const netLow = Math.max(0, g.p25Exact - g.captured - oLow);
      const netTyp = Math.max(0, g.p50Exact - g.captured - oTyp);
      const netHigh = Math.max(0, g.p75Exact - g.captured - oHigh);
      put(G, `A${row}`, { v: g.grouping });
      put(G, `B${row}`, { v: g.bucket });
      put(G, `C${row}`, { v: round4(g.presence / 100) });
      put(G, `D${row}`, { v: g.p25Exact });
      put(G, `E${row}`, { v: g.p50Exact });
      put(G, `F${row}`, { v: g.p75Exact });
      put(G, `G${row}`, { v: g.captured });
      put(G, `H${row}`, { r: [oLow, oTyp, oHigh][modeIdx] });
      put(G, `I${row}`, { r: netLow });
      put(G, `J${row}`, { r: netTyp });
      put(G, `K${row}`, { r: netHigh });
      put(G, `L${row}`, { v: g.selected });
      put(G, `M${row}`, { r: g.selected === 'Include' ? [netLow, netTyp, netHigh][modeIdx] : 0 });
      put(G, `N${row}`, { v: g.why });
      put(G, `O${row}`, { r: oLow });
      put(G, `P${row}`, { r: oTyp });
      put(G, `Q${row}`, { r: oHigh });
      if (g.selected === 'Include') { sLow += netLow; sTyp += netTyp; sHigh += netHigh; count++; }
    });
    put(G, 'B5', { r: sLow });
    put(G, 'C5', { r: sTyp });
    put(G, 'D5', { r: sHigh });
    put(G, 'E5', { r: count });
  }

  // =========================================================== Grouping Review
  {
    const G = 'Grouping Review';
    const flagged = art.gaps
      .filter((g) => g.status === 'material_gap')
      .sort((a, b) => (b.leftOut - a.leftOut) || (b.presence - a.presence) || a.grouping.localeCompare(b.grouping));
    flagged.forEach((g, i) => {
      const row = 5 + i;
      put(G, `A${row}`, { v: g.grouping });
      put(G, `B${row}`, { v: g.bucket });
      put(G, `C${row}`, { v: round4(g.presence / 100) });
      put(G, `D${row}`, { v: g.p50Exact });
      put(G, `E${row}`, { v: g.captured });
      put(G, `F${row}`, { v: g.leftOut });
      put(G, `G${row}`, { v: g.status });
    });
    // child detail rows (flagged groupings only), presence desc
    const autoCodes = new Set(art.autoIncluded.map((r) => r.item_code));
    const children = [];
    for (const g of flagged) {
      const rows = art.svcStats
        .filter((s) => s.basis_label === svcBasis && s.grouping === g.grouping && s.fc_estimate_bucket === g.bucket)
        .sort((a, b) => b.case_presence_rate - a.case_presence_rate);
      for (const s of rows) {
        const isDefault = FIXED_TEMPLATE_CODES.has(s.item_code) || autoCodes.has(s.item_code);
        children.push({
          grouping: g.grouping, code: s.item_code, name: s.item_name,
          presence: round4(s.case_presence_rate / 100), amount: s.amount_cash_typical,
          made: isDefault ? 'Yes' : 'No',
          why: isDefault ? 'default_included' : 'below_presence_threshold',
        });
      }
    }
    children.forEach((c, i) => {
      const row = 13 + i;
      put(G, `A${row}`, { v: c.grouping });
      put(G, `B${row}`, { v: c.code });
      put(G, `C${row}`, { v: c.name });
      put(G, `D${row}`, { v: c.presence });
      put(G, `E${row}`, { v: c.amount });
      put(G, `F${row}`, { v: c.made });
      put(G, `G${row}`, { v: c.why });
    });
  }

  // =========================================================== Implant Selection
  {
    const I = 'Implant Selection';
    const impl = adv.implants;
    const ic = impl.controls ?? {};
    put(I, 'B4', { v: ic.mode ?? 'Default P50' });
    put(I, 'B5', { v: ic.family ?? 'All' });
    put(I, 'B6', { v: ic.brand ?? 'All' });
    put(I, 'B7', { v: ic.item_code ?? 'None' });
    put(I, 'F5', { r: impl.p25 });
    put(I, 'G5', { r: impl.p50 });
    put(I, 'H5', { r: impl.p75 });
    put(I, 'F6', { r: impl.resolved });
    // NOTE: the family/brand/item statistic tables (visible + hidden helper
    // columns R..AR) keep template values — the engine hierarchy carries
    // slightly different aggregation levels; see KNOWN_TEMPLATE_BLOCKS.
  }

  // =========================================================== Estimate Breakdown
  {
    const B = 'Estimate Breakdown';
    const tpl = T(B);
    // map each formula row to its LID source row via the formula text
    for (const [addr, cell] of Object.entries(tpl)) {
      if (cell.f === undefined) continue;
      const m = addr.match(/^([GIJ])(\d+)$/);
      if (!m) continue;
      const src = cell.f.match(/'Line Item Detail'!\$?[A-Z]{1,2}\$?(\d+)/);
      if (!src) continue;
      const it = items[Number(src[1]) - 2];
      if (!it) continue;
      if (m[1] === 'J' && it.selected?.[roomKey] !== undefined) put(B, addr, { r: it.selected[roomKey] });
      if (m[1] === 'G' && it.qty?.selected !== undefined) put(B, addr, { r: it.qty.selected });
      if (m[1] === 'I' && it.rate?.[roomKey] !== undefined) put(B, addr, { r: it.rate[roomKey] });
    }
  }

  // =========================================================== Service Template
  {
    const S = 'Service Template';
    const tpl = T(S);
    for (let row = 4; ; row++) {
      const code = tVal(S, `A${row}`);
      if (code === undefined) break;
      const s = svcStatByKey.get(`${svcBasis}|${code}`);
      if (!s) continue;
      put(S, `B${row}`, { v: s.item_name });
      put(S, `C${row}`, { v: s.fc_estimate_bucket });
      put(S, `D${row}`, { v: s.grouping });
      put(S, `E${row}`, { v: Math.round((s.case_presence_rate * cohortN) / 100) });
      put(S, `F${row}`, { v: round2(s.case_presence_rate) });
      put(S, `G${row}`, { v: s.quantity_p25 });
      put(S, `H${row}`, { v: s.quantity_p50 });
      put(S, `I${row}`, { v: s.quantity_p75 });
      put(S, `J${row}`, { v: ctx.tariff.tariff_cd });
      if (s.tariff_general != null) put(S, `K${row}`, { v: s.tariff_general });
      if (s.tariff_twin != null) put(S, `L${row}`, { v: s.tariff_twin });
      if (s.tariff_single != null) put(S, `M${row}`, { v: s.tariff_single });
      if (s.tariff_icu != null) put(S, `N${row}`, { v: s.tariff_icu });
      put(S, `O${row}`, { v: s.amount_cash_typical });
      if (tpl[`P${row}`]) put(S, `P${row}`, { v: tVal(S, `P${row}`) });
    }
  }

  // =========================================================== Pharmacy Template
  {
    const P = 'Pharmacy Template';
    for (let row = 4; ; row++) {
      const code = tVal(P, `A${row}`);
      const name = tVal(P, `B${row}`);
      if (code === undefined && name === undefined) break;
      const s = pharmStatByKey.get(`${pharmBasis}|${code ?? ''}|${name ?? ''}`);
      if (!s) continue; // items the engine stats do not carry keep template values
      put(P, `G${row}`, { v: s.case_count });
      put(P, `H${row}`, { v: round2(s.case_presence_rate) });
      put(P, `I${row}`, { v: s.ot_quantity_typical });
      put(P, `J${row}`, { v: s.ip_quantity_typical });
      put(P, `K${row}`, { v: s.overall_quantity_typical });
      put(P, `L${row}`, { v: s.ot_amount_typical });
      put(P, `M${row}`, { v: s.ip_amount_typical });
      put(P, `N${row}`, { v: s.overall_amount_typical });
    }
  }

  // =========================================================== Pharmacy Metrics
  {
    const P = 'Pharmacy Metrics';
    const stayOf = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);
    art.cohortRows.forEach((r, i) => {
      const row = 4 + i;
      put(P, `A${row}`, { v: r.admission_no });
      put(P, `B${row}`, { v: r.patient_name });
      put(P, `C${row}`, { v: stayOf(r) });
      put(P, `D${row}`, { v: r.ot_hours });
      // line counts per FC pharmacy bucket, net of cleaned returns
      const counts = { implants: 0, ip_drugs: 0, ip_supplies: 0, ot_drugs: 0, ot_supplies: 0 };
      let unclassified = 0;
      for (const agg of nettedAdmissionPharmacy(r).values()) {
        const cls = (agg.classification || '').toUpperCase();
        if (!cls) { unclassified++; continue; }
        if (agg.ot_q + agg.ip_q <= 0 && agg.ot_a + agg.ip_a <= 0) continue;
        if (cls.includes('IMPLANT')) counts.implants++;
        else if (cls.includes('DRUG')) { if (agg.ip_q > 0 || agg.ip_a > 0) counts.ip_drugs++; if (agg.ot_q > 0 || agg.ot_a > 0) counts.ot_drugs++; }
        else if (cls.includes('SUPPLIES')) { if (agg.ip_q > 0 || agg.ip_a > 0) counts.ip_supplies++; if (agg.ot_q > 0 || agg.ot_a > 0) counts.ot_supplies++; }
      }
      const bucketOf = (k) => Number(r.buckets?.[k] ?? 0);
      put(P, `G${row}`, { v: round2(bucketOf('implants')) });
      put(P, `H${row}`, { v: counts.implants });
      put(P, `I${row}`, { v: round2(bucketOf('ip_drugs')) });
      put(P, `J${row}`, { v: counts.ip_drugs });
      put(P, `K${row}`, { v: round2(bucketOf('ip_consumables')) });
      put(P, `L${row}`, { v: counts.ip_supplies });
      put(P, `M${row}`, { v: round2(bucketOf('ot_drugs')) });
      put(P, `N${row}`, { v: counts.ot_drugs });
      put(P, `O${row}`, { v: round2(bucketOf('ot_consumables')) });
      put(P, `P${row}`, { v: counts.ot_supplies });
      put(P, `Q${row}`, { v: Number(r.cleaned_returns?.summary?.return_quantity_total ?? 0) });
      put(P, `R${row}`, { v: unclassified });
    });
  }

  // =========================================================== IP FC Actuals
  {
    const A = 'IP FC Actuals';
    const stayOf = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);
    const bucketOf = (r, k) => Number(r.buckets?.[k] ?? 0);
    art.cohortRows.forEach((r, i) => {
      const row = 5 + i;
      const stay = stayOf(r);
      const vals = {
        A: r.admission_no, B: r.patient_name, C: r.payor_bucket, D: r.patient_type,
        E: r.organization_name, F: r.surgical_medical, G: r.room_category,
        I: stay, J: r.icu_days, K: r.ward_days, L: r.ot_hours, M: r.service_line_count,
        N: bucketOf(r, 'room_charges'),
        O: stay > 0 ? round2(bucketOf(r, 'room_charges') / stay) : 0,
        P: bucketOf(r, 'investigations'),
        Q: bucketOf(r, 'procedure_ot_charges'),
        R: bucketOf(r, 'bedside_services'),
        S: bucketOf(r, 'professional_fees'),
        T: bucketOf(r, 'ip_drugs'),
        U: stay > 0 ? round2(bucketOf(r, 'ip_drugs') / stay) : 0,
        V: bucketOf(r, 'ip_consumables'),
        W: stay > 0 ? round2(bucketOf(r, 'ip_consumables') / stay) : 0,
        X: bucketOf(r, 'ot_drugs'),
        Y: bucketOf(r, 'ot_consumables'),
        Z: bucketOf(r, 'implants'),
        AA: bucketOf(r, 'pharmacy_total'),
        AB: round2(Number(r.drug_admin_charge ?? 0)),
        AC: round2(Number(r.services_total_ex_fnb ?? 0) - bucketOf(r, 'pharmacy_total')),
        AD: bucketOf(r, 'food_and_beverage'),
        AE: round2(Number(r.cleaned_returns_total ?? 0)),
        AF: round2(Number(r.total_plus_drug_admin ?? 0)),
      };
      for (const [col, v] of Object.entries(vals)) {
        if (v !== undefined && v !== null) put(A, `${col}${row}`, { v });
      }
    });
  }

  // =========================================================== Professional Fees Review
  {
    const P = 'Professional Fees Review';
    // payer-wise historical PF summary rows 15..20 (order = BASIS_LABELS)
    const order = ['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance', 'Corporate', 'Insurance All', 'All Payers'];
    order.forEach((bucket, i) => {
      const row = 15 + i;
      const p = pfByBucket.get(bucket);
      if (!p) return;
      put(P, `B${row}`, { v: p.case_count });
      put(P, `C${row}`, { v: p.collectible_p25 });
      put(P, `D${row}`, { v: p.collectible_p50 });
      put(P, `E${row}`, { v: p.collectible_p75 });
      put(P, `F${row}`, { v: p.named_p50 });
      put(P, `G${row}`, { v: p.general_needed_p50 });
      // H..L (role prevalence %) + M (dominant shape) keep template values
    });
    const cash = pfByBucket.get(pfBasis);
    if (cash) {
      put(P, 'B23', { v: cash.case_count });
      put(P, 'B24', { v: cash.collectible_p25 });
      put(P, 'B25', { v: cash.collectible_p50 });
      put(P, 'B26', { v: cash.collectible_p75 });
    }
  }

  // =========================================================== Reference
  {
    const R = 'Reference';
    const tpl = T(R);

    // -- left mini-tables (quartiles etc., values as CSV-strings/numbers per template) --
    const cashRow = basisRow(svcBasis) ?? art.basisSummary[0];
    const qrows = [
      [5, 'los'], [6, 'icu'], [7, 'ward'], [8, 'ot'],
    ];
    for (const [row, k] of qrows) {
      put(R, `B${row}`, { v: cashRow[`${k}_p25`] });
      put(R, `C${row}`, { v: cashRow[`${k}_p50`] });
      put(R, `D${row}`, { v: cashRow[`${k}_p75`] });
    }
    const pharmRowRef = basisRow(pharmBasis) ?? art.basisSummary[0];
    [['12', 'ip_drugs'], ['13', 'ip_consumables'], ['14', 'ot_drugs'], ['15', 'ot_consumables'], ['16', 'implants']]
      .forEach(([row, k]) => {
        put(R, `B${row}`, { v: pharmRowRef[`${k}_p25`] });
        put(R, `C${row}`, { v: pharmRowRef[`${k}_p50`] });
        put(R, `D${row}`, { v: pharmRowRef[`${k}_p75`] });
      });
    [['20', 'ip_drugs_day'], ['21', 'ip_consumables_day']].forEach(([row, k]) => {
      put(R, `B${row}`, { v: pharmRowRef[`${k}_p25`] });
      put(R, `C${row}`, { v: pharmRowRef[`${k}_p50`] });
      put(R, `D${row}`, { v: pharmRowRef[`${k}_p75`] });
    });
    put(R, 'B25', { v: cashRow.service_line_p25 });
    put(R, 'C25', { v: cashRow.service_line_p50 });
    put(R, 'D25', { v: cashRow.service_line_p75 });

    // -- left block: locate the stacked mini-tables by their section titles --
    const sectionStart = (title) => {
      for (let row = 1; row <= 400; row++) if (tVal(R, `A${row}`) === title) return row;
      return -1;
    };
    const eachSectionRow = (title, fn) => {
      const start = sectionStart(title);
      if (start < 0) return;
      for (let row = start + 2; tVal(R, `A${row}`) !== undefined; row++) fn(row);
    };
    // cleaned services template + optional service rows (CSV-string cells)
    for (const title of ['Cleaned Services Template', 'Optional Service Rows']) {
      eachSectionRow(title, (row) => {
        const s = svcStatByKey.get(`${svcBasis}|${tVal(R, `A${row}`)}`);
        if (!s) return;
        put(R, `B${row}`, { v: s.item_name });
        put(R, `C${row}`, { v: s.fc_estimate_bucket });
        put(R, `D${row}`, { v: s.grouping });
        put(R, `E${row}`, { v: pyStr(s.case_presence_rate) });
        put(R, `F${row}`, { v: pyStr(s.quantity_p25) });
        put(R, `G${row}`, { v: pyStr(s.quantity_p50) });
        put(R, `H${row}`, { v: pyStr(s.quantity_p75) });
        put(R, `I${row}`, { v: pyStr(s.amount_cash_typical) });
      });
    }
    // resolved-tariff rate table (numeric cells; cols C..F = general/twin/single/icu)
    const leftRateByCode = new Map();
    for (const s of art.svcStats) {
      if (s.basis_label !== svcBasis) continue;
      if (s.tariff_general == null && s.tariff_single == null) continue;
      leftRateByCode.set(s.item_code, {
        name: s.item_name, general: s.tariff_general, twin: s.tariff_twin, single: s.tariff_single, icu: s.tariff_icu,
      });
    }
    for (const s of art.otSlotRows) {
      leftRateByCode.set(s.item_code, { name: s.item_name, general: s.general, twin: s.twin, single: s.single, icu: s.icu });
    }
    for (const it of items) {
      if (it.code && it.rate && !leftRateByCode.has(it.code)) leftRateByCode.set(it.code, { ...it.rate });
    }
    eachSectionRow(`${ctx.tariff.tariff_cd} Tariff Rates`, (row) => {
      const rate = leftRateByCode.get(tVal(R, `A${row}`));
      if (!rate) return;
      if (rate.name != null) put(R, `B${row}`, { v: rate.name });
      if (rate.general != null) put(R, `C${row}`, { v: rate.general });
      if (rate.twin != null) put(R, `D${row}`, { v: rate.twin });
      if (rate.single != null) put(R, `E${row}`, { v: rate.single });
      if (rate.icu != null) put(R, `F${row}`, { v: rate.icu });
    });
    // implant reference (family/brand/item stats, CSV-string cells)
    const implByCode = new Map(adv.implants.hierarchy.items.map((it) => [it.code, it]));
    eachSectionRow('Implant Reference', (row) => {
      const it = implByCode.get(tVal(R, `C${row}`));
      if (!it) return;
      put(R, `A${row}`, { v: it.family });
      put(R, `B${row}`, { v: it.brand });
      put(R, `D${row}`, { v: it.name });
      put(R, `E${row}`, { v: pyStr(it.presence_rate) });
      put(R, `F${row}`, { v: pyStr(it.quantity_p50) });
      put(R, `G${row}`, { v: pyStr(it.rate_p50) });
    });

    // -- OT tariff slot ladder J300..R331 --
    const ladder = [...art.otSlotRows].sort((a, b) => (a.ot_slot_hours - b.ot_slot_hours)
      || (a.ot_mode === b.ot_mode ? 0 : a.ot_mode === 'normal' ? -1 : 1));
    ladder.forEach((s, i) => {
      const row = 300 + i;
      put(R, `J${row}`, { v: s.tariff_code });
      put(R, `K${row}`, { v: s.ot_slot_hours });
      put(R, `L${row}`, { v: s.ot_mode });
      put(R, `M${row}`, { v: s.item_code });
      put(R, `N${row}`, { v: s.item_name });
      put(R, `O${row}`, { v: s.general });
      put(R, `P${row}`, { v: s.twin });
      put(R, `Q${row}`, { v: s.single });
      put(R, `R${row}`, { v: s.icu });
    });

    // -- cath lab family metrics T4/U4/V4 --
    put(R, 'T4', { v: 0 });
    put(R, 'U4', { v: 0 });
    put(R, 'V4', { v: 0 });

    // -- payer basis summary AZ2:CP7 --
    const SUMMARY_COLS = {
      AZ: 'basis_label', BA: 'cohort_size', BB: 'cash_count', BC: 'gipsa_count', BD: 'non_gipsa_count',
      BE: 'corporate_count', BF: 'los_p25', BG: 'los_p50', BH: 'los_p75', BI: 'icu_p25', BJ: 'icu_p50',
      BK: 'icu_p75', BL: 'ward_p25', BM: 'ward_p50', BN: 'ward_p75', BO: 'ot_p25', BP: 'ot_p50', BQ: 'ot_p75',
      BR: 'service_line_p25', BS: 'service_line_p50', BT: 'service_line_p75',
      BU: 'ip_drugs_p25', BV: 'ip_drugs_p50', BW: 'ip_drugs_p75',
      BX: 'ip_consumables_p25', BY: 'ip_consumables_p50', BZ: 'ip_consumables_p75',
      CA: 'ot_drugs_p25', CB: 'ot_drugs_p50', CC: 'ot_drugs_p75',
      CD: 'ot_consumables_p25', CE: 'ot_consumables_p50', CF: 'ot_consumables_p75',
      CG: 'implants_p25', CH: 'implants_p50', CI: 'implants_p75',
      CJ: 'ip_drugs_day_p25', CK: 'ip_drugs_day_p50', CL: 'ip_drugs_day_p75',
      CM: 'ip_consumables_day_p25', CN: 'ip_consumables_day_p50', CO: 'ip_consumables_day_p75',
    };
    art.basisSummary.forEach((b, i) => {
      const row = 2 + i;
      for (const [col, field] of Object.entries(SUMMARY_COLS)) put(R, `${col}${row}`, { v: b[field] ?? 0 });
      put(R, `CP${row}`, { v: String(b.cath_lab_p25 ?? 0) });
    });

    // -- payer basis service stats CQ2.. (row set/order from template keys) --
    const cashSvcByCode = new Map(art.svcStats.filter((s) => s.basis_label === svcBasis).map((s) => [s.item_code, s]));
    for (let row = 2; ; row++) {
      const key = tVal(R, `CQ${row}`);
      if (typeof key !== 'string') break;
      const [basis, code] = key.split('|');
      const s = svcStatByKey.get(key);
      const fallback = cashSvcByCode.get(code);
      const src = s ?? fallback;
      if (!src) continue;
      put(R, `CR${row}`, { v: basis });
      put(R, `CS${row}`, { v: code });
      put(R, `CT${row}`, { v: src.item_name });
      put(R, `CU${row}`, { v: src.fc_estimate_bucket });
      put(R, `CV${row}`, { v: src.grouping });
      put(R, `CW${row}`, { v: s ? round2(s.case_presence_rate) : 0 });
      if (s && tpl[`CX${row}`]) {
        put(R, `CX${row}`, { v: s.quantity_p25 });
        put(R, `CY${row}`, { v: s.quantity_p50 });
        put(R, `CZ${row}`, { v: s.quantity_p75 });
        put(R, `DA${row}`, { v: s.amount_cash_typical });
      }
      if (src.tariff_general != null) put(R, `DB${row}`, { v: src.tariff_general });
      if (src.tariff_twin != null) put(R, `DC${row}`, { v: src.tariff_twin });
      if (src.tariff_single != null) put(R, `DD${row}`, { v: src.tariff_single });
      if (src.tariff_icu != null) put(R, `DE${row}`, { v: src.tariff_icu });
    }

    // -- payer basis pharmacy stats DG2.. (row set/order from template keys) --
    for (let row = 2; ; row++) {
      const key = tVal(R, `DG${row}`);
      if (typeof key !== 'string') break;
      const s = pharmStatByKey.get(key);
      if (!s) continue; // engine stats do not carry all reference rows (kept from template)
      put(R, `DH${row}`, { v: s.basis_label });
      if (s.item_code) put(R, `DI${row}`, { v: s.item_code });
      put(R, `DJ${row}`, { v: s.item_name });
      put(R, `DL${row}`, { v: round2(s.case_presence_rate) });
      put(R, `DO${row}`, { v: s.ot_quantity_typical });
      put(R, `DP${row}`, { v: s.ot_amount_typical });
      put(R, `DQ${row}`, { v: s.overall_amount_typical });
      put(R, `DR${row}`, { v: s.name_key });
    }

    // -- tariff rate matrix EB.. : override rates for the resolved tariff only --
    const rateByCode = new Map();
    for (const s of art.svcStats) {
      if (s.basis_label !== svcBasis) continue;
      if (s.tariff_general == null && s.tariff_single == null) continue;
      rateByCode.set(s.item_code, { general: s.tariff_general, twin: s.tariff_twin, single: s.tariff_single, icu: s.tariff_icu });
    }
    for (const it of items) {
      if (it.code && it.rate && !rateByCode.has(it.code)) rateByCode.set(it.code, { ...it.rate });
    }
    for (let row = 2; ; row++) {
      const key = tVal(R, `EB${row}`);
      if (typeof key !== 'string') break;
      const [tariff, code] = key.split('|');
      if (tariff !== ctx.tariff.tariff_cd) continue;
      const rate = rateByCode.get(code);
      if (!rate) continue;
      if (rate.general != null) put(R, `EG${row}`, { v: rate.general });
      if (rate.twin != null) put(R, `EH${row}`, { v: rate.twin });
      if (rate.single != null) put(R, `EI${row}`, { v: rate.single });
      if (rate.icu != null) put(R, `EJ${row}`, { v: rate.icu });
    }

    // -- tariff OT slot matrix EL.. : resolved tariff rows from the engine ladder --
    const slotByKey = new Map(art.otSlotRows.map((s) => [s.matrix_key, s]));
    for (let row = 2; ; row++) {
      const key = tVal(R, `EL${row}`);
      if (typeof key !== 'string') break;
      const s = slotByKey.get(key);
      if (!s) continue;
      put(R, `EM${row}`, { v: s.tariff_code });
      put(R, `EN${row}`, { v: ctx.tariff.tariff_name });
      put(R, `EO${row}`, { v: s.ot_slot_hours });
      put(R, `EP${row}`, { v: s.ot_mode });
      put(R, `EQ${row}`, { v: s.item_code });
      put(R, `ER${row}`, { v: s.item_name });
      if (s.general != null) put(R, `ES${row}`, { v: s.general });
      if (s.twin != null) put(R, `ET${row}`, { v: s.twin });
      if (s.single != null) put(R, `EU${row}`, { v: s.single });
      if (s.icu != null) put(R, `EV${row}`, { v: s.icu });
    }

    // -- PF payor summary FC2:GC7 --
    const PF_COLS = [
      ['FD', (p) => p.case_count],
      ['FE', (p) => p.collectible_p25], ['FF', (p) => p.collectible_p50], ['FG', (p) => p.collectible_p75],
      ['FH', (p) => p.named_p25], ['FI', (p) => p.named_p50], ['FJ', (p) => p.named_p75],
      ['FK', (p) => p.general_needed_p25], ['FL', (p) => p.general_needed_p50], ['FM', (p) => p.general_needed_p75],
      ['FN', (p) => p.roles.surgeon.p25], ['FO', (p) => p.roles.surgeon.p50], ['FP', (p) => p.roles.surgeon.p75],
      ['FQ', (p) => p.roles.assistant_surgeon.p25], ['FR', (p) => p.roles.assistant_surgeon.p50], ['FS', (p) => p.roles.assistant_surgeon.p75],
      ['FT', (p) => p.roles.anesthetist.p25], ['FU', (p) => p.roles.anesthetist.p50], ['FV', (p) => p.roles.anesthetist.p75],
      ['FW', (p) => p.roles.assistant_anesthetist.p25], ['FX', (p) => p.roles.assistant_anesthetist.p50], ['FY', (p) => p.roles.assistant_anesthetist.p75],
      ['FZ', (p) => p.roles.consultant_or_physician.p25], ['GA', (p) => p.roles.consultant_or_physician.p50], ['GB', (p) => p.roles.consultant_or_physician.p75],
    ];
    art.pfSummary.forEach((p, i) => {
      const row = 2 + i;
      put(R, `FC${row}`, { v: p.payor_bucket });
      for (const [col, fn] of PF_COLS) put(R, `${col}${row}`, { v: fn(p) ?? 0 });
      if (p.dominant_pf_shape) put(R, `GC${row}`, { v: p.dominant_pf_shape });
    });

    // -- actual basis metrics HA2.. (row set/order from template keys) --
    for (let row = 2; ; row++) {
      const key = tVal(R, `HA${row}`);
      if (typeof key !== 'string') break;
      const a = actualByKey.get(key);
      if (!a) continue;
      put(R, `HB${row}`, { v: a.basis_label });
      put(R, `HC${row}`, { v: a.field_key });
      put(R, `HE${row}`, { v: a.min ?? 0 });
      put(R, `HF${row}`, { v: a.max ?? 0 });
      put(R, `HG${row}`, { v: a.average ?? 0 });
      put(R, `HH${row}`, { v: a.p25 ?? 0 });
      put(R, `HI${row}`, { v: a.p50 ?? 0 });
      put(R, `HJ${row}`, { v: a.p75 ?? 0 });
    }
  }

  // ------------------------------------------------------------------
  // Post-pass: propagate values through simple mirror formulas (=E2,
  // =Builder!G12, ='Advanced Controls'!C6 …) so cached results stay
  // consistent with the overridden cells.
  // ------------------------------------------------------------------
  const valueOf = (sheet, addr) => {
    const o = bands[sheet]?.[addr];
    if (o) return 'v' in o ? o.v : o.r;
    const c = T(sheet)[addr];
    if (!c) return undefined;
    if (c.f !== undefined) return c.r;
    return c.v;
  };
  const REF_RE = /^(?:(?:'([^']+)'|([A-Za-z][A-Za-z ]*))!)?\$?([A-Z]{1,3})\$?([0-9]+)$/;
  for (let pass = 0; pass < 3; pass++) {
    for (const sheet of template.sheetOrder) {
      for (const [addr, cell] of Object.entries(T(sheet))) {
        if (cell.f === undefined) continue;
        if (bands[sheet]?.[addr]) continue;
        const m = cell.f.match(REF_RE);
        if (!m) continue;
        const refSheet = m[1] ?? m[2] ?? sheet;
        const v = valueOf(refSheet, `${m[3]}${m[4]}`);
        if (v !== undefined && v !== null) put(sheet, addr, { r: v });
      }
    }
  }

  return bands;
}

/**
 * KNOWN_TEMPLATE_BLOCKS — blocks that intentionally keep reference-template
 * values because the engine payload does not (yet) carry the data:
 *  - Reference DT:DZ  insurance org directory with DB-wide case counts
 *  - Reference EX:FA  insurance FC policy (seed data, spec/reference_targets.json)
 *  - Reference GD:GS  payer-basis resolution narrative rows
 *  - Reference EB:EJ / EL:EV rows of non-resolved tariffs
 *  - Reference left TR1 rate table + implant reference mini-tables
 *  - Implant Selection family/brand/item statistic tables (R..AR + visible)
 *  - Pharmacy Template classification/presence-flag/observed-rate columns
 *  - Pharmacy Metrics gross-return-qty / unclassified-count columns
 *  - Professional Fees Review role-prevalence % and modeled-vs-actual rows
 */
