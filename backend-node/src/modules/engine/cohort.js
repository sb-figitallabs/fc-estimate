/**
 * Clinical-family cohort definitions over mart.main_table.
 * The exact robotic TKR cohort filter is being confirmed against
 * export_robotic_tkr_fc_estimate_builder.py (see spec/BUILD_SPEC.md).
 */
const FAMILIES = {
  robotic_tkr_unilateral_right: {
    family: 'robotic_tkr_unilateral_right',
    familyKind: 'surgical',
    // exact cohort: verified against the finalized workbook's 26 admissions
    whereSql: `package_name = 'ROBOTIC TKR - UNILATERAL - RIGHT' AND payor_bucket = 'Cash'`,
    params: [],
    procedure: { code: 'OTI0098', label: 'ROBO (TKR) - UNILATERAL' },
    templateName: 'Robotic TKR Unilateral - Right',
    baseServiceCount: 36,
  },
  robotic_tkr_unilateral_left: {
    family: 'robotic_tkr_unilateral_left',
    familyKind: 'surgical',
    whereSql: `package_code = 'ORT5784'`,
    params: [],
    procedure: { code: 'OTI0098', label: 'ROBO (TKR) - UNILATERAL' },
    templateName: 'Robotic TKR Unilateral - Left',
  },
  robotic_tkr_bilateral: {
    family: 'robotic_tkr_bilateral',
    familyKind: 'surgical',
    whereSql: `package_code = 'ORT5536'`,
    params: [],
    procedure: { code: 'OTI0098', label: 'ROBO (TKR) - BILATERAL' },
    templateName: 'Robotic TKR Bilateral',
  },
  total_hip_replacement_thr_hemiarthroplasty: {
    family: 'total_hip_replacement_thr_hemiarthroplasty',
    familyKind: 'surgical',
    // THR unilateral/bilateral variants + hemiarthroplasty + cash THR packages (95 cases)
    whereSql: `package_code IN ('ORT5383','ORT5205','ORT5206','ORT0052','ORT0123','ORT0034','ORT5792','ORT5010')`,
    params: [],
    // THR bills the procedure through OT-hour slots — no single package procedure row
    procedure: null,
    includeProcedure: false,
    templateName: 'Total Hip Replacement (THR) / Hemiarthroplasty',
    coreTemplate: 'auto',   // template rows derived from the cohort's default-included items
    implantProfile: 'hip',  // hip implant family classifier
  },
};

export async function getCohort(procedure) {
  const def = FAMILIES[procedure];
  if (!def) {
    const err = new Error(`Unknown procedure family: ${procedure}`);
    err.status = 400;
    throw err;
  }
  return def;
}
