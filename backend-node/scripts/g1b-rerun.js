// G1 part B rerun: include ot_json[].surgery_code / service_code — the real
// per-OT-booking surgery codes (derived_ot_service_codes are OT-time codes).
import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const B = await c.query(`
  WITH master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master),
  adm AS (
    SELECT m.admission_no, m.surgical_medical, m.payor_bucket,
      (m.package_code IS NOT NULL AND m.package_code IN (SELECT surgery_cd FROM master_codes)) AS pkg_code_hit,
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE jsonb_typeof(m.ot_json) WHEN 'array' THEN m.ot_json ELSE '[]'::jsonb END) e
              WHERE e->>'surgery_code' IN (SELECT surgery_cd FROM master_codes)
                 OR e->>'service_code' IN (SELECT surgery_cd FROM master_codes)) AS ot_surgery_hit,
      EXISTS (SELECT 1 FROM fc.package_bill_lines l
              WHERE l.ip_no = m.admission_no AND l.service_cd IN (SELECT surgery_cd FROM master_codes)) AS bill_line_hit
    FROM mart.main_table m
  )
  SELECT surgical_medical, count(*)::int AS admissions,
    count(*) FILTER (WHERE pkg_code_hit OR ot_surgery_hit OR bill_line_hit)::int AS mapped_any,
    count(*) FILTER (WHERE ot_surgery_hit)::int AS via_ot_surgery_code,
    count(*) FILTER (WHERE pkg_code_hit)::int AS via_package_code,
    count(*) FILTER (WHERE bill_line_hit)::int AS via_bill_line
  FROM adm GROUP BY surgical_medical ORDER BY admissions DESC`);
console.log('B2 =', JSON.stringify(B.rows));
const BX = await c.query(`
  WITH master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master)
  SELECT m.admission_no, m.department_name, m.has_ot,
    (SELECT string_agg(DISTINCT e->>'surgery_name', ' | ') FROM jsonb_array_elements(CASE jsonb_typeof(m.ot_json) WHEN 'array' THEN m.ot_json ELSE '[]'::jsonb END) e) AS ot_surgeries
  FROM mart.main_table m
  WHERE m.surgical_medical = 'Surgical'
    AND NOT (m.package_code IS NOT NULL AND m.package_code IN (SELECT surgery_cd FROM master_codes))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE jsonb_typeof(m.ot_json) WHEN 'array' THEN m.ot_json ELSE '[]'::jsonb END) e
                    WHERE e->>'surgery_code' IN (SELECT surgery_cd FROM master_codes) OR e->>'service_code' IN (SELECT surgery_cd FROM master_codes))
    AND NOT EXISTS (SELECT 1 FROM fc.package_bill_lines l WHERE l.ip_no = m.admission_no AND l.service_cd IN (SELECT surgery_cd FROM master_codes))
  ORDER BY m.has_ot DESC LIMIT 12`);
console.log('B2 unmapped surgical =', JSON.stringify(BX.rows));
await c.end();
