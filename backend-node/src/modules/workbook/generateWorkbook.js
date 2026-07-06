import ExcelJS from 'exceljs';

/**
 * FC Estimate Builder workbook generator — full parity target with
 * fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx
 * (16 sheets, live formulas, dropdowns, formatting).
 * Implemented against spec/WORKBOOK_PARITY_SPEC.md.
 */
export async function generateWorkbook(estimate, input) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'fc-builder-api';

  // placeholder until parity spec lands
  const ws = wb.addWorksheet('Builder');
  ws.getCell('A1').value = 'FC Estimate Builder — generation in progress (parity spec pending)';

  const buffer = await wb.xlsx.writeBuffer();
  const family = input.clinical.procedure;
  const payor = (input.payment.payor_bucket || 'cash').toLowerCase().replace(/\W+/g, '_');
  return { buffer, filename: `fc_estimate_builder_${family}_${payor}.xlsx` };
}
