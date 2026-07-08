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
  // NOTE: families are CLINICAL cohorts only — payor/tariff/room are user inputs.
  // (robotic_tkr_unilateral_right above keeps its Cash-scoped cohort because that
  // exact 26-case cohort is the workbook parity-validation target.)
  general_medical_management: {
    family: 'general_medical_management',
    familyKind: 'medical',
    // curated-template cohort (245 cases across payors; 119 cash)
    whereSql: `curated_template_names_jsonb ? 'General Medical Management'`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'General Medical Management',
    coreTemplate: 'auto',
    rows: { ot: false, cathLab: false, surgical: false }, // medical: no OT/cath/surgical fixed rows
  },
  chemotherapy_systemic_therapy_infusion_daycare: {
    family: 'chemotherapy_systemic_therapy_infusion_daycare',
    familyKind: 'daycare',
    daycare: true, // no room selection — daycare stay
    // curated-template daycare cohort (~900 cases across payors; 532 cash)
    whereSql: `curated_template_names_jsonb ? 'Chemotherapy / Systemic Therapy Infusion' AND is_daycare_broad = true`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'Chemotherapy / Systemic Therapy Infusion — Daycare',
    coreTemplate: 'auto',
    rows: { ot: false, cathLab: false, surgical: false, medicalRecords: 'MSC10' },
    ipPharmacyMode: 'bucket', // daycare: IP pharmacy from bucket quartiles (per-day × 0-stay would zero out)
  },
  coronary_angio_cag_cat_1_daycare: {
    family: 'coronary_angio_cag_cat_1_daycare',
    familyKind: 'daycare',
    daycare: true,
    // both CAT-1 name spellings (all daycare; 151 cash + insurance CAT-1 cases)
    whereSql: `package_name IN ('CORONARY ANGIOGRAM (CAG) - CAT - 1','CORONARY ANGIOGRAM (CAG) - CAT-1')`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'Coronary Angiogram (CAG) CAT-1 — Daycare',
    coreTemplate: 'auto',
    rows: { ot: false, cathLab: true, surgical: false, medicalRecords: 'MSC10' }, // cath-lab family
    excludeCathLabFromTemplate: true, // cath rows priced via the cath-lab history row
    ipPharmacyMode: 'bucket',
  },
};

/** Public registry view for UI/API consumers. */
export function listFamilies() {
  return Object.values(FAMILIES).map((f) => ({
    family: f.family,
    label: f.templateName,
    family_kind: f.familyKind,
    daycare: f.daycare === true,     // daycare ⇒ room selection not applicable
    validated: f.family === 'robotic_tkr_unilateral_right', // exact workbook parity
  }));
}

export async function getCohort(procedure) {
  const def = FAMILIES[procedure];
  if (!def) {
    const err = new Error(`Unknown procedure family: ${procedure}`);
    err.status = 400;
    throw err;
  }
  return def;
}
