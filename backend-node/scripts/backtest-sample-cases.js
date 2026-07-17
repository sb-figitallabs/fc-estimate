// Backtest sampler (16-Jul): pick real historical admissions across the key
// families × payors, with the inputs an FC would have typed (family, payor,
// org, LOS/ICU, room) and the ACTUAL bucket-wise bill amounts — so the HO
// builder can replay them as saved estimates and we can diff bucket-by-bucket.
// Output: one JSON array on stdout between BACKTEST_JSON_START/END markers.
import 'dotenv/config';
import pg from 'pg';
import { getCohort } from '../src/modules/engine/cohort.js';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// family key → per-payor sample size (stratified across what the manager reviews)
const PLAN = [
  ['total_knee_replacement_unilateral', { 'GIPSA Insurance': 3, 'Cash': 2, 'Non-GIPSA Insurance': 2 }],
  ['robotic_tkr_unilateral_right', { 'Cash': 2 }],
  ['coronary_angio_cag_cat_1_daycare', { 'Cash': 2, 'GIPSA Insurance': 2 }],
  ['lscs_caesarean', { 'GIPSA Insurance': 2, 'Cash': 2 }],
  ['ursl_ureteroscopic_lithotripsy', { 'Cash': 2, 'Non-GIPSA Insurance': 2 }],
  ['lap_cholecystectomy', { 'GIPSA Insurance': 2, 'Cash': 2 }],
  ['total_hip_replacement_thr_hemiarthroplasty', { 'Cash': 2, 'GIPSA Insurance': 2 }],
  ['hemodialysis_management', { 'GIPSA Insurance': 2 }],
  ['general_medical_management', { 'GIPSA Insurance': 2, 'Cash': 1 }],
  ['inguinal_hernia_repair', { 'Non-GIPSA Insurance': 2 }],
  ['hysterectomy', { 'Non-GIPSA Insurance': 2 }],
  ['general_surgical_procedure', { 'Cash': 1 }],
];

const out = [];
for (const [family, payors] of PLAN) {
  const def = await getCohort(family).catch(() => null);
  if (!def) { console.error(`skip unknown family ${family}`); continue; }
  for (const [payor, n] of Object.entries(payors)) {
    const { rows } = await c.query(
      `SELECT admission_no, patient_name, payor_bucket, organization_name,
              package_code, package_name, room_category,
              los_days::float, icu_days::float, ward_days::float,
              derived_ot_hours::float AS ot_hours,
              fc_actual_bucket_totals_jsonb AS buckets,
              fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin::float AS actual_total
       FROM mart.main_table
       WHERE (${def.whereSql}) AND payor_bucket = $${def.params.length + 1}
         AND fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin > 0
       ORDER BY admission_no DESC
       LIMIT $${def.params.length + 2}`,
      [...def.params, payor, n]
    );
    for (const r of rows) {
      // representative org for insurance payors: the admission's own org name
      // mapped to a code (the builder needs organization_cd for the tariff)
      let organization_cd = null, tariff_cd = null;
      if (payor !== 'Cash' && r.organization_name) {
        const m = await c.query(
          `SELECT organization_cd, tariff_cd FROM fc.organization_tariff_mapping
           WHERE upper(btrim(organization_name)) = upper(btrim($1)) LIMIT 1`,
          [r.organization_name]
        );
        organization_cd = m.rows[0]?.organization_cd ?? null;
        tariff_cd = m.rows[0]?.tariff_cd ?? null;
      }
      out.push({
        family,
        family_label: def.templateName ?? family,
        admission_no: r.admission_no,
        patient_name: r.patient_name,
        payor_bucket: r.payor_bucket,
        organization_name: r.organization_name,
        organization_cd,
        tariff_cd,
        package_code: r.package_code,
        package_name: r.package_name,
        room_category: r.room_category,
        los_days: r.los_days,
        icu_days: r.icu_days,
        ward_days: r.ward_days,
        ot_hours: r.ot_hours,
        actual_buckets: r.buckets,
        actual_total: r.actual_total,
      });
    }
  }
}
console.log(`sampled ${out.length} cases`);
console.log('BACKTEST_JSON_START');
console.log(JSON.stringify(out));
console.log('BACKTEST_JSON_END');
await c.end();
