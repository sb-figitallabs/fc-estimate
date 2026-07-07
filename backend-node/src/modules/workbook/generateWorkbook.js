import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { TEXTS } from './texts.js';
import { buildBands } from './bands.js';
import {
  dynamicLayout, buildLineItemDetail, buildServiceAddOns, buildGroupedAdjustments,
  buildAdvancedControls, buildImplantSelection, buildEstimateSummary,
  buildEstimateVsActuals, buildEstimateBreakdown,
} from './dynamicSheets.js';

/**
 * FC Estimate Builder workbook generator — full parity with
 * fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx
 * (16 sheets, live formulas, dropdowns, formatting).
 *
 * Strategy (spec/WORKBOOK_PARITY_SPEC.md + spec/BUILD_SPEC.md §4):
 * TEMPLATE-REPLAY. template.json (built once by scripts/build_template.js from
 * the reference workbook) carries the full layout: column widths, row heights,
 * hidden columns, autofilters, data validations, the 49-style table and every
 * cell (static value / live formula + cached result / long-text reference).
 * At runtime the DATA BANDS — every cell that carries cohort/engine data —
 * are overridden from the live `estimate` payload (see bands.js), so the
 * workbook is data-driven while formulas/layout follow the reference exactly.
 * fullCalcOnLoad is set, so any cached value is refreshed on open.
 */

const template = JSON.parse(
  fs.readFileSync(new URL('./template.json', import.meta.url), 'utf8')
);

const argb = (hex) => 'FF' + hex.replace('#', '').toUpperCase();

const colToNum = (s) => [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
const numToCol = (n) => {
  let s = '';
  while (n > 0) { s = String.fromCharCode(((n - 1) % 26) + 65) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
/** Expand "A1" / "A1:B3" into individual cell addresses. */
function expandRange(ref) {
  const [a, b] = ref.split(':');
  if (!b) return [a];
  const m1 = a.match(/^([A-Z]+)(\d+)$/), m2 = b.match(/^([A-Z]+)(\d+)$/);
  const out = [];
  for (let c = colToNum(m1[1]); c <= colToNum(m2[1]); c++) {
    for (let r = Number(m1[2]); r <= Number(m2[2]); r++) out.push(`${numToCol(c)}${r}`);
  }
  return out;
}

function toExcelStyle(s) {
  const style = {};
  if (s.font) {
    // colors are either "#RRGGBB" or "theme:<n>,tint:<t>" (parity extractor encoding)
    const colorSpec = (c) => {
      const m = /^theme:(\d+)(?:,tint:([\d.-]+))?$/i.exec(c);
      if (m) return { theme: Number(m[1]), ...(Number(m[2]) ? { tint: Number(m[2]) } : {}) };
      return { argb: argb(c) };
    };
    style.font = {
      name: s.font.name || 'Cambria',
      size: 11,
      bold: !!s.font.bold,
      ...(s.font.color ? { color: colorSpec(s.font.color) } : {}),
    };
  }
  if (s.fill) {
    style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.fill) } };
  }
  if (s.border) {
    const side = (spec) => {
      const [st, color] = spec.split(':');
      return { style: st, color: { argb: argb(color) } };
    };
    style.border = Object.fromEntries(
      Object.entries(s.border).map(([edge, spec]) => [edge, side(spec)])
    );
  }
  if (s.align) {
    style.alignment = {
      ...(s.align.h ? { horizontal: s.align.h } : {}),
      ...(s.align.v ? { vertical: s.align.v } : {}),
      ...(s.align.wrap ? { wrapText: true } : {}),
    };
  }
  if (s.nf) style.numFmt = s.nf;
  return style;
}

export async function generateWorkbook(estimate, input) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'fc-builder-api';
  wb.calcProperties.fullCalcOnLoad = true;

  const styles = template.styles.map(toExcelStyle);
  // DYNAMIC mode: when this family's row counts differ from the reference
  // template, the interactive sheets are generated from the estimate itself
  // (live formulas over correct row ranges) instead of template replay.
  const dynamicMode =
    estimate.line_items.length !== 72 ||
    estimate.add_ons.length !== 27 ||
    estimate.grouped_adjustments.length !== 3 ||
    estimate.advanced_controls.ot_consumables.shortlist.length !== 10;
  const L = dynamicMode ? dynamicLayout(estimate) : null;
  const DYNAMIC_BUILDERS = {
    'Line Item Detail': buildLineItemDetail,
    'Service Add-Ons': buildServiceAddOns,
    'Grouped Adjustments': buildGroupedAdjustments,
    'Advanced Controls': buildAdvancedControls,
    'Implant Selection': buildImplantSelection,
    'Estimate Summary': buildEstimateSummary,
    'Estimate vs IP FC Actuals': buildEstimateVsActuals,
    'Estimate Breakdown': buildEstimateBreakdown,
  };

  const bands = buildBands(estimate, input, template);

  for (const name of template.sheetOrder) {
    const sheet = template.sheets[name];
    const ws = wb.addWorksheet(name, {
      views: [{ showGridLines: sheet.gridlines, zoomScale: sheet.zoom }],
    });
    if (dynamicMode && DYNAMIC_BUILDERS[name]) {
      DYNAMIC_BUILDERS[name](ws, estimate, L);
      continue;
    }

    // columns
    for (const [letter, col] of Object.entries(sheet.cols)) {
      const c = ws.getColumn(letter);
      c.width = col.w;
      if (col.hidden) c.hidden = true;
    }
    // row heights
    for (const [row, h] of Object.entries(sheet.rowHeights)) {
      ws.getRow(Number(row)).height = h;
    }

    // cells
    const over = bands[name] || {};
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      const o = over[addr];
      const c = ws.getCell(addr);
      if (cell.f !== undefined) {
        const result = o && 'r' in o ? o.r : cell.r;
        c.value = result === undefined ? { formula: cell.f } : { formula: cell.f, result };
      } else {
        let v;
        if (o && 'v' in o) v = o.v;
        else if (cell.t !== undefined) v = TEXTS[cell.t];
        else v = cell.v;
        if (v !== undefined) c.value = v;
      }
      if (cell.s !== undefined) c.style = styles[cell.s];
    }
    // band cells not present in the template (future families with more rows)
    for (const [addr, o] of Object.entries(over)) {
      if (sheet.cells[addr]) continue;
      if ('v' in o && o.v !== undefined) ws.getCell(addr).value = o.v;
    }

    // autofilter + validations
    if (sheet.autoFilter) ws.autoFilter = sheet.autoFilter;
    for (const dv of sheet.validations) {
      const model = { type: dv.type, allowBlank: dv.allowBlank, formulae: [dv.formula1] };
      // exceljs expects per-cell entries (it re-merges contiguous ranges itself)
      for (const part of dv.sqref.split(/\s+/)) {
        for (const addr of expandRange(part)) ws.dataValidations.add(addr, model);
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const family = input.clinical.procedure;
  const payor = (input.payment.payor_bucket || 'cash').toLowerCase().replace(/\W+/g, '_');
  return { buffer, filename: `fc_estimate_builder_${family}_${payor}.xlsx` };
}
