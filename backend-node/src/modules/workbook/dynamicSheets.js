/**
 * DYNAMIC sheet builders — used when a family's row counts differ from the
 * robotic-TKR reference template (spec/WORKBOOK_PARITY_SPEC.md). Sheets are
 * generated from the live estimate with LIVE formulas for everything a user
 * would toggle in Excel (estimate mode, room, MLC, include/exclude add-ons,
 * grouped residuals, OT-consumables shortlist, implant override, PF cascade),
 * while historical stats (rates, quantities, percentiles) are baked as values.
 *
 * The robotic-TKR family keeps the cell-exact template-replay path.
 */

const F = {
  header: { font: { name: 'Cambria', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } } },
  sub: { font: { name: 'Cambria', size: 11, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAF7' } } },
  body: { font: { name: 'Cambria', size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F8' } } },
  input: { font: { name: 'Cambria', size: 11 }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } } },
  result: { font: { name: 'Cambria', size: 11, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF4EA' } } },
  money: '#,##0.00',
};
const thin = { style: 'thin', color: { argb: 'FFD9D9D9' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

function setRow(ws, row, values, style = F.body, numFmtCols = []) {
  if (!values) return;
  values.forEach((v, i) => {
    if (v === undefined) return;
    const c = ws.getCell(row, i + 1);
    c.value = v;
    c.style = { ...style, border };
    if (numFmtCols.includes(i + 1)) c.numFmt = F.money;
  });
}
const colL = (n) => { let s = ''; while (n > 0) { s = String.fromCharCode(((n - 1) % 26) + 65) + s; n = Math.floor((n - 1) / 26); } return s; };
const modePickF = (l, t, h) => `IF(Builder!$B$5="Low",${l},IF(Builder!$B$5="Typical",${t},${h}))`;
const roomPickF = (g, t, s) => `IF(Builder!$B$4="General",${g},IF(Builder!$B$4="Twin",${t},${s}))`;
const fml = (formula, result) => (result === undefined ? { formula } : { formula, result });
const listDV = (ws, addr, list) => ws.dataValidations.add(addr, { type: 'list', allowBlank: false, formulae: [`"${list}"`] });

/** Layout positions shared across sheets. */
export function dynamicLayout(estimate) {
  const items = estimate.line_items;
  const lidRowOf = (i) => i + 2; // engine index -> LID excel row
  const lastItemRow = lidRowOf(items.length - 1);
  const pf0 = items.findIndex((r) => r.name === 'Surgeon');
  const addOnRows = new Map(); // item_code -> Service Add-Ons excel row
  estimate.add_ons.forEach((a, i) => addOnRows.set(a.code, 7 + i));
  const groupedRows = new Map();
  estimate.grouped_adjustments.forEach((g, i) => groupedRows.set(g.grouping, 7 + i));
  return {
    items, lidRowOf, lastItemRow,
    pfStartRow: lidRowOf(pf0), pfEndRow: lidRowOf(pf0 + 3),
    pharmStartRow: lidRowOf(items.findIndex((r) => r.name === 'IP Drugs & Medications')),
    pharmEndRow: lidRowOf(items.findIndex((r) => r.name === 'Implants')),
    subtotalRow: lastItemRow + 1,
    grandRow: lastItemRow + 2,
    addOnRows, groupedRows,
    saEnd: 6 + estimate.add_ons.length,
    gaEnd: 6 + estimate.grouped_adjustments.length,
    acEnd: 7 + estimate.advanced_controls.ot_consumables.shortlist.length,
  };
}

/* ------------------------------------------------------------------ */
export function buildLineItemDetail(ws, estimate, L) {
  ws.getColumn(1).width = 34; ws.getColumn(2).width = 20; ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 14; ws.getColumn(5).width = 24; ws.getColumn(6).hidden = true;
  for (let c = 7; c <= 25; c++) ws.getColumn(c).width = 12;
  ws.getColumn(23).width = 14;

  setRow(ws, 1, ['Line Item', 'Parent Bucket', 'Sub-Bucket', 'Source', 'How', 'Item Code', 'Selected Qty',
    'Qty Low', 'Qty Typical', 'Qty High', 'Rate General', 'Rate Twin', 'Rate Single',
    'General Low', 'General Typical', 'General High', 'Twin Low', 'Twin Typical', 'Twin High',
    'Single Low', 'Single Typical', 'Single High', 'Selected Total General', 'Selected Total Twin', 'Selected Total Single'], F.sub);

  estimate.line_items.forEach((row, i) => {
    const r = L.lidRowOf(i);
    const qty = row.qty ?? {};
    const rate = row.rate ?? {};
    const hasQty = qty.low != null;
    const isAddOn = !!row.addOn;
    const isGrouped = !!row.groupedResidual;
    const isMlc = row.name === 'MLC Charges';
    const isDrugAdmin = row.name === 'Drug Administration Charges';
    const isPf = i >= (L.pfStartRow - 2) && i <= (L.pfEndRow - 2);
    const isOtCons = row.name === 'OT Consumables';
    const isImplants = row.name === 'Implants';
    const isOtCharges = row.name === 'OT Charges';
    const genericLive = hasQty && rate.general != null && !isAddOn && !isMlc && !isOtCharges &&
      !/History|Advanced|Cath/i.test(row.source || '') && !isPf && !isDrugAdmin;

    setRow(ws, r, [row.name, row.bucket, row.sub, row.source, row.how, row.code ?? '',
      undefined, hasQty ? qty.low : undefined, hasQty ? qty.typ : undefined, hasQty ? qty.high : undefined,
      rate.general ?? undefined, rate.twin ?? undefined, rate.single ?? undefined],
    F.body, [11, 12, 13]);
    if (hasQty) ws.getCell(r, 7).value = fml(modePickF(`H${r}`, `I${r}`, `J${r}`), qty.selected);

    const cellCols = { general: [14, 15, 16], twin: [17, 18, 19], single: [20, 21, 22] };
    const rateCol = { general: 'K', twin: 'L', single: 'M' };
    const qtyCol = ['H', 'I', 'J'];
    for (const [roomKey, cols] of Object.entries(cellCols)) {
      row.cells[roomKey].forEach((v, m) => {
        const c = ws.getCell(r, cols[m]);
        c.numFmt = F.money; c.style = { ...F.body, border, numFmt: F.money };
        if (isPf) {
          const col = colL(cols[m]);
          const mult = ['0.25*' + col + L.subtotalRow, '0.15*' + col + L.pfStartRow, '0.25*' + col + L.pfStartRow, '0.25*' + col + (L.pfStartRow + 2)][i - (L.pfStartRow - 2)];
          c.value = fml(`IF(Builder!$E$2="Insurance / Org Tariff",0,${mult})`, v);
        } else if (isDrugAdmin) {
          const col = colL(cols[m]);
          c.value = fml(`IF(Builder!$E$2="Insurance / Org Tariff",0,0.125*SUM(${col}${L.pharmStartRow}:${col}${L.pharmEndRow}))`, v);
        } else if (isMlc) {
          c.value = fml(`IF(Builder!$E$6="Yes",1,0)*${rateCol[roomKey]}${r}`, v);
        } else if (isAddOn) {
          const sa = L.addOnRows.get(row.code);
          c.value = fml(`IF('Service Add-Ons'!$I$${sa}="Include",${qtyCol[m]}${r}*${rateCol[roomKey]}${r},0)`, v);
        } else if (isGrouped) {
          const ga = L.groupedRows.get(row.sub);
          const netCol = ['I', 'J', 'K'][m];
          c.value = fml(`IF('Grouped Adjustments'!$L$${ga}="Include",'Grouped Adjustments'!$${netCol}$${ga},0)`, v);
        } else if (isOtCons && m === 1) {
          c.value = fml(`'Advanced Controls'!$C$6`, v);
        } else if (isImplants && m === 1) {
          c.value = fml(`'Implant Selection'!$F$6`, v);
        } else if (isOtCharges) {
          c.value = fml(`${rateCol[roomKey]}${r}`, v);
        } else if (genericLive) {
          c.value = fml(`${qtyCol[m]}${r}*${rateCol[roomKey]}${r}`, v);
        } else {
          c.value = v;
        }
      });
      // selected totals W/X/Y
      const selCol = { general: 23, twin: 24, single: 25 }[roomKey];
      const [lo, ty, hi] = cols.map((c2) => colL(c2) + r);
      const sc = ws.getCell(r, selCol);
      sc.value = fml(modePickF(lo, ty, hi), row.selected[roomKey]);
      sc.numFmt = F.money; sc.style = { ...F.body, border, numFmt: F.money };
    }
  });

  // subtotal + grand total
  const sub = L.subtotalRow, gt = L.grandRow;
  setRow(ws, sub, ['Subtotal Before Professional Fees', 'Grand Total'], F.result);
  setRow(ws, gt, ['Grand Total', 'Grand Total'], F.result);
  for (let c = 14; c <= 25; c++) {
    const col = colL(c);
    const s1 = `SUM(${col}2:${col}${L.pfStartRow - 1})`;
    const s2 = L.pfEndRow < L.lastItemRow ? `+SUM(${col}${L.pfEndRow + 1}:${col}${L.lastItemRow})` : '';
    ws.getCell(sub, c).value = fml(`${s1}${s2}`);
    ws.getCell(gt, c).value = fml(`${col}${sub}+SUM(${col}${L.pfStartRow}:${col}${L.pfEndRow})`);
    ws.getCell(sub, c).style = { ...F.result, border, numFmt: F.money };
    ws.getCell(gt, c).style = { ...F.result, border, numFmt: F.money };
  }
}

/* ------------------------------------------------------------------ */
export function buildServiceAddOns(ws, estimate, L) {
  [40, 18, 12, 10, 10, 10, 14, 14, 12, 14, 14, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(13).hidden = true;
  ws.getColumn(15).width = 28; ws.getColumn(16).width = 16;
  setRow(ws, 1, ['Service Add-Ons — optional items with include/exclude control'], F.header);
  setRow(ws, 4, ['Optional Add-Ons Total', 'Low', 'Typical', 'High'], F.sub);
  const end = L.saEnd;
  ws.getCell('B5').value = fml(`SUMIF($I$7:$I$${end},"Include",J$7:J$${end})`);
  ws.getCell('C5').value = fml(`SUMIF($I$7:$I$${end},"Include",K$7:K$${end})`);
  ws.getCell('D5').value = fml(`SUMIF($I$7:$I$${end},"Include",L$7:L$${end})`);
  ['B5', 'C5', 'D5'].forEach((a) => { ws.getCell(a).style = { ...F.result, border, numFmt: F.money }; });

  setRow(ws, 6, ['Service Name', 'Grouping', 'Presence Rate', 'Qty P25', 'Qty P50', 'Qty P75',
    'Selected Tariff Rate', 'Typical Gross', 'Selected', 'Low Amt', 'Typical Amt', 'High Amt', 'Code'], F.sub);
  const lidByCode = new Map();
  estimate.line_items.forEach((r, i) => { if (r.addOn) lidByCode.set(r.code, r); });
  estimate.add_ons.forEach((a, i) => {
    const r = 7 + i;
    const li = lidByCode.get(a.code) ?? { rate: {} };
    setRow(ws, r, [a.name, a.grouping, a.presence, a.q25, a.q50, a.q75, undefined, undefined,
      a.selected, undefined, undefined, undefined, a.code], F.body, [7, 8, 10, 11, 12]);
    ws.getCell(r, 7).value = fml(roomPickF(li.rate.general ?? 0, li.rate.twin ?? 0, li.rate.single ?? 0));
    ws.getCell(r, 8).value = fml(`E${r}*G${r}`);
    ws.getCell(r, 9).style = { ...F.input, border };
    ws.getCell(r, 10).value = fml(`IF($I${r}="Include",D${r}*G${r},0)`);
    ws.getCell(r, 11).value = fml(`IF($I${r}="Include",E${r}*G${r},0)`);
    ws.getCell(r, 12).value = fml(`IF($I${r}="Include",F${r}*G${r},0)`);
    [7, 8, 10, 11, 12].forEach((c) => { ws.getCell(r, c).numFmt = F.money; });
  });
  if (estimate.add_ons.length) listDV(ws, `I7:I${end}`, 'Include,Exclude');

  // service line count alert
  const slc = estimate.service_line_count;
  setRow(ws, 4, undefined, F.sub); // noop guard
  ws.getCell('O4').value = 'Service Count Check'; ws.getCell('O4').style = { ...F.sub, border };
  const alerts = [['Historical P25', slc.p25], ['Historical P50', slc.p50], ['Historical P75', slc.p75],
    ['Base Included Non-Pharmacy Count', slc.base]];
  alerts.forEach(([label, v], i) => {
    ws.getCell(5 + i, 15).value = label; ws.getCell(5 + i, 15).style = { ...F.body, border };
    ws.getCell(5 + i, 16).value = v; ws.getCell(5 + i, 16).style = { ...F.body, border };
  });
  ws.getCell('O9').value = 'Selected Optional Count'; ws.getCell('O9').style = { ...F.body, border };
  ws.getCell('P9').value = fml(`COUNTIF($I$7:$I$${end},"Include")`, slc.selectedAddOns);
  ws.getCell('O10').value = 'Current Included Non-Pharmacy Count'; ws.getCell('O10').style = { ...F.body, border };
  ws.getCell('P10').value = fml('P8+P9', slc.current);
  ws.getCell('O11').value = 'Alert'; ws.getCell('O11').style = { ...F.body, border };
  ws.getCell('P11').value = fml('IF(P10<P5,"Below historical P25",IF(P10>P7,"Above historical P75","Within historical range"))', slc.status);
  ['P9', 'P10', 'P11'].forEach((a) => { ws.getCell(a).style = { ...F.result, border }; });
}

/* ------------------------------------------------------------------ */
export function buildGroupedAdjustments(ws, estimate, L) {
  [30, 22, 14, 16, 16, 16, 16, 14, 14, 14, 14, 12, 16, 34].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(15).hidden = true; ws.getColumn(16).hidden = true; ws.getColumn(17).hidden = true;
  setRow(ws, 1, ['Grouped Adjustments — common-case residuals net of selected add-ons'], F.header);
  setRow(ws, 4, ['Grouped Residuals Total', 'Low', 'Typical', 'High', 'Included Count'], F.sub);
  const end = L.gaEnd;
  ws.getCell('B5').value = fml(`SUMIF($L$7:$L$${end},"Include",I$7:I$${end})`);
  ws.getCell('C5').value = fml(`SUMIF($L$7:$L$${end},"Include",J$7:J$${end})`);
  ws.getCell('D5').value = fml(`SUMIF($L$7:$L$${end},"Include",K$7:K$${end})`);
  ws.getCell('E5').value = fml(`COUNTIF($L$7:$L$${end},"Include")`);
  ['B5', 'C5', 'D5'].forEach((a) => { ws.getCell(a).style = { ...F.result, border, numFmt: F.money }; });
  ws.getCell('E5').style = { ...F.result, border };

  setRow(ws, 6, ['Grouping', 'FC Bucket', 'Group Presence Rate', 'Group Amount P25 Exact', 'Group Amount P50 Exact',
    'Group Amount P75 Exact', 'Captured By Default', 'Selected Add-On Amount', 'Net Residual Low', 'Net Residual Typical',
    'Net Residual High', 'Selected', 'Selected Amount', 'Why'], F.sub);
  const sa = L.saEnd;
  estimate.grouped_adjustments.forEach((g, i) => {
    const r = 7 + i;
    setRow(ws, r, [g.grouping, g.bucket, g.presence / 100, g.p25Exact, g.p50Exact, g.p75Exact, g.captured,
      undefined, undefined, undefined, undefined, g.selected, undefined, g.why], F.body, [4, 5, 6, 7, 8, 9, 10, 11, 13]);
    ws.getCell(r, 3).numFmt = '0.0%';
    ws.getCell(r, 15).value = fml(`SUMIFS('Service Add-Ons'!$J$7:$J$${sa},'Service Add-Ons'!$B$7:$B$${sa},$A${r},'Service Add-Ons'!$I$7:$I$${sa},"Include")`);
    ws.getCell(r, 16).value = fml(`SUMIFS('Service Add-Ons'!$K$7:$K$${sa},'Service Add-Ons'!$B$7:$B$${sa},$A${r},'Service Add-Ons'!$I$7:$I$${sa},"Include")`);
    ws.getCell(r, 17).value = fml(`SUMIFS('Service Add-Ons'!$L$7:$L$${sa},'Service Add-Ons'!$B$7:$B$${sa},$A${r},'Service Add-Ons'!$I$7:$I$${sa},"Include")`);
    ws.getCell(r, 8).value = fml(modePickF(`O${r}`, `P${r}`, `Q${r}`));
    ws.getCell(r, 9).value = fml(`MAX(0,D${r}-G${r}-O${r})`);
    ws.getCell(r, 10).value = fml(`MAX(0,E${r}-G${r}-P${r})`);
    ws.getCell(r, 11).value = fml(`MAX(0,F${r}-G${r}-Q${r})`);
    ws.getCell(r, 12).style = { ...F.input, border };
    ws.getCell(r, 13).value = fml(`IF(L${r}="Include",${modePickF(`I${r}`, `J${r}`, `K${r}`)},0)`);
  });
  if (estimate.grouped_adjustments.length) listDV(ws, `L7:L${end}`, 'Include,Exclude');
}

/* ------------------------------------------------------------------ */
export function buildAdvancedControls(ws, estimate, L) {
  [40, 12, 14, 14, 14, 18, 14, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const ac = estimate.advanced_controls.ot_consumables;
  setRow(ws, 1, ['Advanced Controls — OT consumables shortlist'], F.header);
  setRow(ws, 4, ['OT Consumables Benchmark', 'P25', 'P50', 'P75'], F.sub);
  setRow(ws, 5, ['Historical band', ac.p25, ac.p50, ac.p75], F.body, [2, 3, 4]);
  ws.getCell('A6').value = 'Resolved OT Consumables (Applied Typical)'; ws.getCell('A6').style = { ...F.body, border };
  const end = L.acEnd;
  ws.getCell('C6').value = fml(
    `IF(COUNTIF($H$8:$H$${end},"Include")=0,C5,IF(IFERROR(SUMIF($H$8:$H$${end},"Include",F$8:F$${end})/SUM(F$8:F$${end}),0)<=0.3,B5,IF(IFERROR(SUMIF($H$8:$H$${end},"Include",F$8:F$${end})/SUM(F$8:F$${end}),0)<=0.5,C5,D5)))`,
    ac.applied
  );
  ws.getCell('C6').style = { ...F.result, border, numFmt: F.money };
  setRow(ws, 7, ['Item', 'Typical Qty', 'Typical Rate', 'Typical Amount', 'Presence Rate', 'Expected Contribution', 'Cumulative Share', 'Selected'], F.sub);
  ac.shortlist.forEach((s, i) => {
    const r = 8 + i;
    setRow(ws, r, [s.item_name, s.ot_quantity_typical, undefined, s.ot_amount_typical, s.case_presence_rate,
      undefined, undefined, s.selected], F.body, [3, 4, 6]);
    ws.getCell(r, 3).value = fml(`IF(B${r}>0,D${r}/B${r},0)`);
    ws.getCell(r, 6).value = fml(`E${r}*B${r}*C${r}/100`, s.expected_contribution);
    ws.getCell(r, 7).value = i === 0
      ? fml(`F8/SUM($F$8:$F$${end})`)
      : fml(`G${r - 1}+F${r}/SUM($F$8:$F$${end})`);
    ws.getCell(r, 7).numFmt = '0.0%';
    ws.getCell(r, 8).style = { ...F.input, border };
  });
  if (ac.shortlist.length) listDV(ws, `H8:H${end}`, 'Include,Exclude');
}

/* ------------------------------------------------------------------ */
export function buildImplantSelection(ws, estimate, L) {
  [22, 22, 42, 12, 16, 14, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const imp = estimate.advanced_controls.implants;
  const hier = imp.hierarchy;
  setRow(ws, 1, ['Implant Selection'], F.header);
  setRow(ws, 3, ['Control', 'Value'], F.sub);
  setRow(ws, 4, ['Implant Estimate Mode', imp.controls?.mode ?? 'Default P50'], F.body);
  setRow(ws, 5, ['Selected Family', imp.controls?.family ?? 'All'], F.body);
  setRow(ws, 6, ['Selected Brand', imp.controls?.brand ?? 'All'], F.body);
  setRow(ws, 7, ['Selected Item Code', imp.controls?.itemCode ?? 'None'], F.body);
  ['B4', 'B5', 'B6', 'B7'].forEach((a) => { ws.getCell(a).style = { ...F.input, border }; });
  setRow(ws, 3, undefined, F.sub);
  ws.getCell('E4').value = 'Implants'; ws.getCell('E4').style = { ...F.sub, border };
  ['F4', 'G4', 'H4'].forEach((a, i) => { ws.getCell(a).value = ['Low', 'Typical', 'High'][i]; ws.getCell(a).style = { ...F.sub, border }; });
  setRow(ws, 5, undefined, F.body);
  ws.getCell('E5').value = 'Historical band'; ws.getCell('E5').style = { ...F.body, border };
  ws.getCell('F5').value = imp.p25; ws.getCell('G5').value = imp.p50; ws.getCell('H5').value = imp.p75;
  ['F5', 'G5', 'H5'].forEach((a) => { ws.getCell(a).style = { ...F.body, border, numFmt: F.money }; });
  ws.getCell('E6').value = 'Resolved Implant Estimate'; ws.getCell('E6').style = { ...F.body, border };

  // hidden lookup blocks: families U:AB-style → here R..T lists + U..W amounts
  const famStart = 2;
  hier.families.forEach((f, i) => {
    ws.getCell(famStart + i, 18).value = f.key;                    // R: family list
    ws.getCell(famStart + i, 21).value = f.key;                    // U: family key
    ws.getCell(famStart + i, 22).value = f.amount_p50;             // V: family amount
  });
  ws.getCell(famStart + hier.families.length, 18).value = 'All';
  const brands = [...new Set(hier.brands.map((b) => b.brand))];
  brands.forEach((b, i) => ws.getCell(famStart + i, 19).value = b); // S: brand list
  ws.getCell(famStart + brands.length, 19).value = 'All';
  hier.brands.forEach((b, i) => {
    ws.getCell(famStart + i, 24).value = `${b.family}|${b.brand}`;  // X: brand key
    ws.getCell(famStart + i, 25).value = b.amount_p50;              // Y: brand amount
  });
  hier.items.forEach((it, i) => {
    ws.getCell(famStart + i, 20).value = it.code;                   // T: item list
    ws.getCell(famStart + i, 27).value = it.code;                   // AA: item key
    ws.getCell(famStart + i, 28).value = it.amount_p50;             // AB: item amount
    ws.getCell(famStart + i, 29).value = it.name;                   // AC
  });
  ws.getCell(famStart + hier.items.length, 20).value = 'None';
  [18, 19, 20, 21, 22, 24, 25, 27, 28, 29].forEach((c) => { ws.getColumn(c).hidden = true; });

  const famN = hier.families.length + 1, brN = hier.brands.length + 1, itN = hier.items.length + 1;
  ws.getCell('F6').value = fml(
    `IF(B4="Default P50",$G$5,IF(B4="Family Override",IFERROR(INDEX($V$2:$V$${famN + 1},MATCH(B5,$U$2:$U$${famN + 1},0)),$G$5),` +
    `IF(B4="Brand Override",IFERROR(INDEX($Y$2:$Y$${brN + 1},MATCH(B5&"|"&B6,$X$2:$X$${brN + 1},0)),$G$5),` +
    `IFERROR(INDEX($AB$2:$AB$${itN + 1},MATCH(B7,$AA$2:$AA$${itN + 1},0)),$G$5))))`,
    imp.resolved
  );
  ws.getCell('F6').style = { ...F.result, border, numFmt: F.money };
  listDV(ws, 'B4', 'Default P50,Family Override,Brand Override,Exact Item Override');
  ws.dataValidations.add('B5', { type: 'list', allowBlank: true, formulae: [`$R$2:$R$${famN + 1}`] });
  ws.dataValidations.add('B6', { type: 'list', allowBlank: true, formulae: [`$S$2:$S$${brN + 1}`] });
  ws.dataValidations.add('B7', { type: 'list', allowBlank: true, formulae: [`$T$2:$T$${itN + 1}`] });

  // visible family summary
  setRow(ws, 10, ['Family', 'Presence Rate', 'Qty P50', 'Rate P50', 'Amount P50'], F.sub);
  hier.families.forEach((f, i) => {
    setRow(ws, 11 + i, [f.key, f.presence_rate / 100, f.quantity_p50, f.rate_p50, f.amount_p50], F.body, [4, 5]);
    ws.getCell(11 + i, 2).numFmt = '0.0%';
  });
}

/* ------------------------------------------------------------------ */
export function buildEstimateSummary(ws, estimate, L) {
  [24, 18, 4, 20, 18, 14, 14, 4, 30, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const ctx = estimate.resolved_context;
  setRow(ws, 1, ['Estimate Summary'], F.header);
  const mirrors = [
    ['Selected Room Type', `Builder!B4`], ['Estimate Mode', `Builder!B5`],
    ['Historical Payer Basis', `Builder!E3`], ['Pricing Mode', `Builder!E2`],
    ['Resolved Payor Bucket', `Builder!E4`], ['Resolved Tariff Code', `Builder!E5`],
    ['Resolved Pharmacy Basis', `Builder!G5`], ['Resolved Service Basis', `Builder!G6`], ['Resolved PF Basis', `Builder!G7`],
  ];
  mirrors.forEach(([label, ref], i) => {
    setRow(ws, 2 + i, [label], F.body);
    ws.getCell(2 + i, 2).value = fml(ref); ws.getCell(2 + i, 2).style = { ...F.body, border };
  });
  ws.getCell('D2').value = 'Final Estimate'; ws.getCell('D2').style = { ...F.sub, border };
  ws.getCell('E2').value = fml(roomPickF(`'Line Item Detail'!W${L.grandRow}`, `'Line Item Detail'!X${L.grandRow}`, `'Line Item Detail'!Y${L.grandRow}`), estimate.final_estimate);
  ws.getCell('E2').style = { ...F.result, border, numFmt: F.money };
  // room x mode matrix
  setRow(ws, 6, [undefined, undefined, undefined, 'Room / Mode', 'Low', 'Typical', 'High'], F.sub);
  ['General', 'Twin', 'Single'].forEach((room, i) => {
    const r = 7 + i;
    ws.getCell(r, 4).value = room; ws.getCell(r, 4).style = { ...F.body, border };
    const cols = { General: ['N', 'O', 'P'], Twin: ['Q', 'R', 'S'], Single: ['T', 'U', 'V'] }[room];
    cols.forEach((c, m) => {
      ws.getCell(r, 5 + m).value = fml(`'Line Item Detail'!${c}${L.grandRow}`);
      ws.getCell(r, 5 + m).style = { ...F.body, border, numFmt: F.money };
    });
  });
  // bucket table
  setRow(ws, 12, ['Bucket', 'Selected Estimate'], F.sub);
  const buckets = Object.keys(estimate.bucket_totals);
  buckets.forEach((b, i) => {
    const r = 13 + i;
    setRow(ws, r, [b], F.body);
    ws.getCell(r, 2).value = fml(
      roomPickF(
        `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},A${r},'Line Item Detail'!$W$2:$W$${L.lastItemRow})`,
        `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},A${r},'Line Item Detail'!$X$2:$X$${L.lastItemRow})`,
        `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},A${r},'Line Item Detail'!$Y$2:$Y$${L.lastItemRow})`,
      ), estimate.bucket_totals[b]);
    ws.getCell(r, 2).style = { ...F.body, border, numFmt: F.money };
  });
  const gtr = 13 + buckets.length;
  setRow(ws, gtr, ['Grand Total'], F.result);
  ws.getCell(gtr, 2).value = fml('E2', estimate.final_estimate);
  ws.getCell(gtr, 2).style = { ...F.result, border, numFmt: F.money };
  // drivers panel
  setRow(ws, 6, undefined, F.sub);
  ws.getCell('I6').value = 'Selected Drivers & Controls'; ws.getCell('I6').style = { ...F.sub, border };
  const drivers = [
    ['LOS (days)', 'Builder!G10'], ['ICU days', 'Builder!G11'], ['Ward days', 'Builder!G12'], ['OT hours', 'Builder!G13'],
    ['Emergency OT', 'Builder!B6'], ['MLC', 'Builder!E6'], ['Robotic', 'Builder!B8'],
    ['OT Consumables Selected Typical', `'Advanced Controls'!C6`], ['Implants Selected Typical', `'Implant Selection'!F6`],
    ['Optional Add-Ons Selected Typical', `'Service Add-Ons'!C5`], ['Grouped Adjustments Selected Typical', `'Grouped Adjustments'!C5`],
    ['Service Count Alert', `'Service Add-Ons'!P11`],
  ];
  drivers.forEach(([label, ref], i) => {
    ws.getCell(7 + i, 9).value = label; ws.getCell(7 + i, 9).style = { ...F.body, border };
    ws.getCell(7 + i, 10).value = fml(ref); ws.getCell(7 + i, 10).style = { ...F.body, border };
  });
  // context note
  ws.getCell('D4').value = `Cohort: ${ctx.cohort_case_count} historical cases (${ctx.family}); basis ${ctx.payer_bases?.service_basis?.selected_basis} — ${ctx.payer_bases?.service_basis?.reason ?? ''}`;
  ws.getCell('D4').style = { ...F.body };
}

/* ------------------------------------------------------------------ */
export function buildEstimateVsActuals(ws, estimate, L) {
  [28, 22, 16, 14, 14, 14, 14, 14, 14, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  setRow(ws, 1, ['Estimate vs IP FC Actuals'], F.header);
  setRow(ws, 4, ['Metric', 'Comparison Basis', 'Selected Estimate', 'Actual P25', 'Actual P50', 'Actual P75',
    'Delta vs P25', 'Delta vs P50', 'Delta vs P75', 'Status'], F.sub);
  const basis = estimate.resolved_context.payer_bases?.pharmacy_basis?.selected_basis ?? 'Cash';
  const am = new Map((estimate.artifacts?.actualMetrics ?? []).map((a) => [a.key, a]));
  const rowsSpec = [
    ['Room Charges', 'Room Charges', 'room_charges'],
    ['Investigations', 'Investigations', 'investigations'],
    ['Procedure / OT Charges', 'Procedure / OT Charges', 'procedure_ot_charges'],
    ['Bedside Services', 'Bedside Services', 'bedside_services'],
    ['Pharmacy Total', 'Pharmacy', 'pharmacy_total'],
    ['Implants', null, 'implants'],
    ['OT Consumables', null, 'ot_consumables'],
    ['Drug Administration Charges', 'Drug Administration Charges', 'drug_administration_charges'],
    ['Professional Fees (calculated)', 'Professional Fees', 'professional_fees'],
    ['Grand Total', '__grand__', 'total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin'],
  ];
  rowsSpec.forEach(([label, bucket, key], i) => {
    const r = 5 + i;
    const a = am.get(`${basis}|${key}`) ?? {};
    setRow(ws, r, [label, basis, undefined, a.p25 ?? 0, a.p50 ?? 0, a.p75 ?? 0], F.body, [3, 4, 5, 6, 7, 8, 9]);
    let cRef;
    if (bucket === '__grand__') cRef = `'Estimate Summary'!E2`;
    else if (bucket) cRef = roomPickF(
      `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},"${bucket}",'Line Item Detail'!$W$2:$W$${L.lastItemRow})`,
      `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},"${bucket}",'Line Item Detail'!$X$2:$X$${L.lastItemRow})`,
      `SUMIF('Line Item Detail'!$B$2:$B$${L.lastItemRow},"${bucket}",'Line Item Detail'!$Y$2:$Y$${L.lastItemRow})`);
    else cRef = roomPickF(
      `SUMIF('Line Item Detail'!$A$2:$A$${L.lastItemRow},"${label}",'Line Item Detail'!$W$2:$W$${L.lastItemRow})`,
      `SUMIF('Line Item Detail'!$A$2:$A$${L.lastItemRow},"${label}",'Line Item Detail'!$X$2:$X$${L.lastItemRow})`,
      `SUMIF('Line Item Detail'!$A$2:$A$${L.lastItemRow},"${label}",'Line Item Detail'!$Y$2:$Y$${L.lastItemRow})`);
    ws.getCell(r, 3).value = fml(cRef);
    ws.getCell(r, 7).value = fml(`C${r}-D${r}`);
    ws.getCell(r, 8).value = fml(`C${r}-E${r}`);
    ws.getCell(r, 9).value = fml(`C${r}-F${r}`);
    ws.getCell(r, 10).value = fml(
      `IF(AND(OR(C${r}<D${r},C${r}>F${r}),ABS(H${r})>MAX(5000,0.2*MAX(E${r},1))),"Material Gap",IF(C${r}<D${r},"Below Range",IF(C${r}>F${r},"Above Range","Within Range")))`);
  });
}

/* ------------------------------------------------------------------ */
/**
 * "Package Comparison" sheet — appended as sheet 17 in BOTH template and
 * dynamic modes whenever a package resolves (side-by-side rule: the package
 * never replaces the itemized estimate). Curated fields only; history is
 * labelled as evidence.
 */
export function buildPackageComparison(ws, estimate) {
  const po = estimate.package_offer || {};
  const p = po.package;
  [30, 24, 20, 20, 20].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  setRow(ws, 1, ['Package Comparison — hospital package vs itemized estimate (side-by-side)'], F.header);
  if (!p) {
    setRow(ws, 3, ['No hospital package exists for this cohort / payor. Itemized estimate only.'], F.body);
    return;
  }
  const num = (v) => (v == null ? null : Number(v));
  const cov = po.coverage && !po.coverage.error ? po.coverage : null;
  setRow(ws, 3, ['Comparison', 'Amount (₹)'], F.sub);
  setRow(ws, 4, ['Hospital Package Amount', num(p.package_amount)], F.result, [2]);
  setRow(ws, 5, ['Itemized Estimate — WITHOUT package'], F.result);
  ws.getCell('B5').value = fml(`'Estimate Summary'!E2`, estimate.final_estimate);
  ws.getCell('B5').style = { ...F.result, border, numFmt: F.money };
  if (cov) {
    setRow(ws, 6, ['Payable extras beyond package', cov.totals.payable_extras], F.body, [2]);
    setRow(ws, 7, ['Total WITH package (package + extras)'], F.result);
    ws.getCell('B7').value = fml('B4+B6', cov.totals.with_package);
    ws.getCell('B7').style = { ...F.result, border, numFmt: F.money };
    setRow(ws, 8, ['Patient saves with package'], F.body);
    ws.getCell('B8').value = fml('B5-B7');
    ws.getCell('B8').style = { ...F.body, border, numFmt: F.money };
  } else {
    setRow(ws, 6, ['Difference (itemized − package)'], F.body);
    ws.getCell('B6').value = fml('B5-B4');
    ws.getCell('B6').style = { ...F.body, border, numFmt: F.money };
  }

  setRow(ws, 10, ['Package Details (curated)', ''], F.sub);
  const details = [
    ['Package', `${p.package_name} (${p.package_code})`],
    ['Tariff / Payor', `${p.tariff_code} ${p.tariff_name ?? ''} · ${p.payor_bucket ?? ''}${p.organization_name ? ' · ' + p.organization_name : ''}`],
    ['Department / Type', `${p.department_name ?? ''} ${p.package_type ? '· ' + p.package_type : ''}`],
    ['Duration (days)', p.package_duration ?? ''],
    ['Pre / Post days', `${p.pre_days ?? ''} / ${p.post_days ?? ''}`],
    ['Room category', p.matched_room_category ?? ''],
    ['ATL amount', num(p.package_atl_amount) ?? ''],
    ['Readiness', `${p.readiness.runtime_status}${p.readiness.primary_blocker ? ' — ' + p.readiness.primary_blocker : ''}`],
    ['Documentation confidence', p.documentation_confidence ?? ''],
    ['Source of match', po.source === 'cohort_dominant' ? 'Auto-detected from cohort' : 'User-selected'],
  ];
  details.forEach(([k, v], i) => setRow(ws, 11 + i, [k, v], F.body));

  // room rates
  let r = 22;
  const rates = Array.isArray(p.room_rates_jsonb) ? p.room_rates_jsonb : [];
  if (rates.length) {
    setRow(ws, r, ['Room / Category Rates', '', ''], F.sub); r++;
    for (const rr of rates.slice(0, 12)) {
      setRow(ws, r, [rr.room_category ?? rr.category ?? rr.ordinal ?? '', num(rr.amount ?? rr.rate) ?? '', rr.notes ?? ''], F.body, [2]);
      r++;
    }
    r++;
  }
  // curated documentation (wrapped text blocks)
  const docBlock = (title, text) => {
    if (!text) return;
    setRow(ws, r, [title], F.sub); r++;
    const c = ws.getCell(r, 1);
    c.value = text;
    c.style = { ...F.body, border, alignment: { vertical: 'top', wrapText: true } };
    ws.mergeCells(r, 1, r, 5);
    ws.getRow(r).height = Math.min(180, 16 * Math.ceil(text.length / 110));
    r += 2;
  };
  docBlock(`Inclusions (curated)${cov && cov.parse.variants > 1 ? ` — text has ${cov.parse.variants} source variants, showing first` : ''}`,
    p.inclusions_display || p.inclusions_text);
  docBlock('Exclusions (curated)', p.exclusions_text);

  // per-line coverage table (drives the WITH-package total)
  if (cov) {
    const LBL = { fully_included: 'Fully Included', partially_included: 'Partially Included', capped: 'Capped', excluded: 'Excluded', not_included: 'Not Included', review: 'Review', recomputed: 'Recomputed' };
    setRow(ws, r, ['Line-Item Coverage', '', '', '', ''], F.sub); r++;
    setRow(ws, r, ['Line Item', 'Itemized (₹)', 'Package Inclusion Status', 'Final Amount (₹)', 'Basis (curated source / note)'], F.sub); r++;
    for (const c of cov.rows) {
      if (!c.amount && !c.final_amount) continue; // skip zero rows for readability
      setRow(ws, r, [c.name, c.amount, LBL[c.status] ?? c.status, c.final_amount,
        [c.note, c.source].filter(Boolean).join(' — ').slice(0, 140)], F.body, [2, 4]);
      r++;
    }
    setRow(ws, r, ['Payable Extras Total', '', '', cov.totals.payable_extras, ''], F.result, [4]); r += 2;
  }

  // history — evidence only
  const h = po.history;
  if (h) {
    setRow(ws, r, ['FC Package History (supporting evidence only — not package documentation)'], F.sub); r++;
    setRow(ws, r, ['Admissions', Number(h.admission_count) || 0], F.body); r++;
    setRow(ws, r, ['Observed amount range', `₹${h.min_observed_package_amount ?? '—'} – ₹${h.max_observed_package_amount ?? '—'}`], F.body); r++;
    setRow(ws, r, ['Latest admission', h.latest_admission_at ? String(h.latest_admission_at).slice(0, 10) : '—'], F.body); r++;
  }
}

/* ------------------------------------------------------------------ */
export function buildEstimateBreakdown(ws, estimate, L) {
  [34, 22, 18, 14, 34, 12, 14, 12, 14, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  setRow(ws, 1, ['Estimate Breakdown — selected estimate only'], F.header);
  setRow(ws, 3, ['Line Item', 'Summary Bucket', 'Sub-Bucket', 'Source Type', 'How Calculated', 'Included?',
    'Selected Quantity', 'Selected Room', 'Selected Rate', 'Selected Amount'], F.sub);
  let r = 4;
  let lastBucket = null;
  estimate.line_items.forEach((row, i) => {
    if (row.bucket !== lastBucket) {
      lastBucket = row.bucket;
      setRow(ws, r, [row.bucket], F.sub);
      r++;
    }
    const lid = L.lidRowOf(i);
    setRow(ws, r, [undefined, row.bucket, undefined, undefined, undefined, row.addOn ? undefined : 'Included'], F.body, [7, 9, 10]);
    ws.getCell(r, 1).value = fml(`'Line Item Detail'!A${lid}`);
    ws.getCell(r, 3).value = fml(`'Line Item Detail'!C${lid}`);
    ws.getCell(r, 4).value = fml(`'Line Item Detail'!D${lid}`);
    ws.getCell(r, 5).value = fml(`'Line Item Detail'!E${lid}`);
    if (row.addOn) ws.getCell(r, 6).value = fml(`IF('Service Add-Ons'!I${L.addOnRows.get(row.code)}="Include","Included","Excluded")`);
    if (row.groupedResidual) ws.getCell(r, 6).value = fml(`IF('Grouped Adjustments'!L${L.groupedRows.get(row.sub)}="Include","Included","Excluded")`);
    ws.getCell(r, 7).value = fml(`'Line Item Detail'!G${lid}`);
    ws.getCell(r, 8).value = fml('Builder!B4');
    ws.getCell(r, 9).value = fml(roomPickF(`'Line Item Detail'!K${lid}`, `'Line Item Detail'!L${lid}`, `'Line Item Detail'!M${lid}`));
    ws.getCell(r, 10).value = fml(roomPickF(`'Line Item Detail'!W${lid}`, `'Line Item Detail'!X${lid}`, `'Line Item Detail'!Y${lid}`));
    r++;
  });
  setRow(ws, r, ['Grand Total'], F.result);
  ws.getCell(r, 10).value = fml(`'Estimate Summary'!E2`, estimate.final_estimate);
  ws.getCell(r, 10).style = { ...F.result, border, numFmt: F.money };
  ws.autoFilter = `A3:J${r}`;
}
