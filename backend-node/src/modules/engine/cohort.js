/**
 * Clinical-family cohort definitions over mart.main_table.
 * The exact robotic TKR cohort filter is being confirmed against
 * export_robotic_tkr_fc_estimate_builder.py (see spec/BUILD_SPEC.md).
 */
import GENERATED_FAMILIES from './generatedFamilies.js';

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
  total_knee_replacement_unilateral: {
    family: 'total_knee_replacement_unilateral',
    familyKind: 'surgical',
    // conventional (non-robotic) TKR unilateral — all LEFT/RIGHT/UNILATERAL name variants (~683 cases, insurance-heavy)
    whereSql: `package_name ~* '^TOTAL KNEE REPLACEMENT' AND package_name !~* 'BILATERAL'`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'Total Knee Replacement (TKR) — Unilateral (Conventional)',
    coreTemplate: 'auto',
    implantProfile: 'knee',
    rows: { cathLab: false },
  },
  total_knee_replacement_bilateral: {
    family: 'total_knee_replacement_bilateral',
    familyKind: 'surgical',
    whereSql: `package_name ~* '^TOTAL KNEE REPLACEMENT' AND package_name ~* 'BILATERAL'`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'Total Knee Replacement (TKR) — Bilateral (Conventional)',
    coreTemplate: 'auto',
    implantProfile: 'knee',
    rows: { cathLab: false },
  },
  ptca_single_vessel: {
    family: 'ptca_single_vessel',
    familyKind: 'surgical',
    // NOT daycare: ~3.7-day stay with ICU observation; cath-lab carries the procedure
    whereSql: `package_name IN ('PTCA (PERCUTANEOUS TRANSLUMINAL CORONARY ANGIOPLASTY) - 1 VESSEL','CORONARY ANGIOPLASTY (PTCA) - SINGLE VESSEL')`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'PTCA — Single Vessel',
    coreTemplate: 'auto',
    rows: { ot: false, cathLab: true, surgical: false },
    excludeCathLabFromTemplate: true,
  },
  lap_cholecystectomy: {
    family: 'lap_cholecystectomy',
    familyKind: 'surgical',
    // all laparoscopic-cholecystectomy name variants (~252 cases)
    whereSql: `package_name ~* 'CHOLECYSTECTOMY' AND package_name ~* 'LAP'`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'Laparoscopic Cholecystectomy',
    coreTemplate: 'auto',
    rows: { cathLab: false },
  },
  lscs_caesarean: {
    family: 'lscs_caesarean',
    familyKind: 'surgical',
    // LSCS/caesarean variants; excludes mixed normal-delivery packages (~186 cases)
    // ot:false — only ~8% have parseable OT-hour rows; procedure cost is in template rows
    whereSql: `package_name ~* 'LSCS|CAESAR' AND package_name !~* 'NORMAL DELIVERY'`,
    params: [],
    procedure: null,
    includeProcedure: false,
    templateName: 'LSCS (Caesarean Section)',
    coreTemplate: 'auto',
    rows: { ot: false, cathLab: false },
  },
};

// Merge in the auto-generated curated-template families (data-driven onboarding).
Object.assign(FAMILIES, GENERATED_FAMILIES);

/** Map a hospital package (name/code) back to a registered clinical family. */
export function familyForPackage({ package_name = '', package_code = '' }) {
  const n = package_name.toUpperCase();
  const c = package_code.toUpperCase();
  if (/^ROBOTIC TKR/.test(n) || c === 'ORT5535' || c === 'ORT5784' || c === 'ORT5536') {
    if (/BILATERAL/.test(n) || c === 'ORT5536') return 'robotic_tkr_bilateral';
    if (/LEFT/.test(n) || c === 'ORT5784') return 'robotic_tkr_unilateral_left';
    return 'robotic_tkr_unilateral_right';
  }
  if (/^TOTAL KNEE REPLACEMENT/.test(n)) {
    return /BILATERAL/.test(n) ? 'total_knee_replacement_bilateral' : 'total_knee_replacement_unilateral';
  }
  if (/HIP REPLACEMENT|HEMIARTHROPLASTY|\bTHR\b/.test(n)) return 'total_hip_replacement_thr_hemiarthroplasty';
  if (/CORONARY ANGIOGRAM.*CAT ?- ?1|CAG.*CAT ?- ?1/.test(n)) return 'coronary_angio_cag_cat_1_daycare';
  if (/PTCA|ANGIOPLASTY/.test(n) && /1 VESSEL|SINGLE VESSEL/.test(n)) return 'ptca_single_vessel';
  if (/CHOLECYSTECTOMY/.test(n) && /LAP/.test(n)) return 'lap_cholecystectomy';
  if (/LSCS|CAESAR/.test(n) && !/NORMAL DELIVERY/.test(n)) return 'lscs_caesarean';
  if (/CHEMOTHERAPY|SYSTEMIC THERAPY/.test(n)) return 'chemotherapy_systemic_therapy_infusion_daycare';
  return null; // family not yet onboarded
}

/**
 * Sub-limit likelihood per family (manager note i6: flag treatments with a
 * strong likelihood of policy sub-limits). Classified ONCE via Gemini
 * (2026-07-09) and baked in after review — groups follow common Indian
 * retail/group policy wording: implants/stents, maternity caps,
 * modern-treatment (robotic) caps, chemo/daycare caps, procedure caps.
 */
const SUBLIMIT_RISK = {
  robotic_tkr_unilateral_right: { level: 'high', groups: ['implants', 'modern_treatment', 'procedure_cap'] },
  robotic_tkr_unilateral_left: { level: 'high', groups: ['implants', 'modern_treatment', 'procedure_cap'] },
  robotic_tkr_bilateral: { level: 'high', groups: ['implants', 'modern_treatment', 'procedure_cap'] },
  total_hip_replacement_thr_hemiarthroplasty: { level: 'high', groups: ['implants', 'procedure_cap'] },
  general_medical_management: { level: 'low', groups: [] },
  chemotherapy_systemic_therapy_infusion_daycare: { level: 'high', groups: ['chemo_daycare'] },
  coronary_angio_cag_cat_1_daycare: { level: 'medium', groups: ['chemo_daycare'] },
  total_knee_replacement_unilateral: { level: 'high', groups: ['implants', 'procedure_cap'] },
  total_knee_replacement_bilateral: { level: 'high', groups: ['implants', 'procedure_cap'] },
  ptca_single_vessel: { level: 'high', groups: ['implants', 'procedure_cap'] },
  lap_cholecystectomy: { level: 'medium', groups: ['procedure_cap'] },
  lscs_caesarean: { level: 'high', groups: ['maternity'] },
};

/** Public registry view for UI/API consumers. */
export function listFamilies() {
  return Object.values(FAMILIES).map((f) => ({
    family: f.family,
    label: f.templateName,
    family_kind: f.familyKind,
    daycare: f.daycare === true,     // daycare ⇒ room selection not applicable
    validated: f.family === 'robotic_tkr_unilateral_right', // exact workbook parity
    sublimit_risk: SUBLIMIT_RISK[f.family] ?? { level: 'low', groups: [] },
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

/**
 * Narrow a family cohort to a specific care type (Surgical/Medical) and/or
 * setting (Daycare/Inpatient) from the build controls, and flip the template
 * flags to match. Values are validated against fixed literals (no SQL from
 * user input). Returns a shallow clone; `_careFiltered` marks that a cohort
 * filter was applied so the caller can fall back if it yields no cases.
 */
export function applyCareControls(def, controls = {}) {
  const care = controls.care_type;   // 'Surgical' | 'Medical'
  const setting = controls.setting;  // 'Daycare' | 'Inpatient'
  const next = { ...def };
  const clauses = [];

  if (care === 'Surgical' || care === 'Medical') {
    clauses.push(`surgical_medical = '${care}'`);
    next.familyKind = care === 'Surgical' ? 'surgical' : 'medical';
    if (care === 'Medical') {
      // medical: no OT / surgical / cath fixed template rows
      next.rows = { ...(def.rows || {}), ot: false, surgical: false, cathLab: false };
    }
  }
  if (setting === 'Daycare' || setting === 'Inpatient') {
    const isDay = setting === 'Daycare';
    clauses.push(`is_daycare_broad = ${isDay}`);
    next.daycare = isDay;
    if (isDay) next.ipPharmacyMode = 'bucket'; // per-day × 0-stay would zero out
  }

  if (clauses.length) {
    next.whereSql = `(${def.whereSql}) AND ${clauses.join(' AND ')}`;
    next._careFiltered = true;
    next._baseWhereSql = def.whereSql;
  }
  return next;
}
