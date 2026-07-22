// G1 (manager 18-Jul): ingest Surgery Master _SSG.xlsx → fc.surgery_master,
// then measure how cleanly our past IP admissions map to it.
//   A. fc.package_bill_admissions — his direct ask: surgery_cd / surgery_name
//      present in the master? (the surgical billing extract)
//   B. mart.main_table (ALL IP) — any billed OT/service code or package code
//      in the master; medical-management admissions expected to have none.
import 'dotenv/config';
import pg from 'pg';
import ExcelJS from 'exceljs';

const XLSX = process.env.SURGERY_MASTER_XLSX || '/Users/apple/Downloads/Surgery Master _SSG.xlsx';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// ---------- 1. ingest ----------
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX);
const ws = wb.worksheets[0];
const rows = [];
ws.eachRow((row, n) => {
  if (n === 1) return;
  const v = (i) => { const x = row.getCell(i).value; return x == null ? null : (x.text ?? x).toString().trim(); };
  const d = (i) => { const x = row.getCell(i).value; return x instanceof Date ? x : null; };
  if (!v(3)) return;
  rows.push([v(1), v(2), v(3), v(4), v(5), v(6), d(7), d(8)]);
});
console.log('xlsx rows parsed:', rows.length);

await c.query(`
  CREATE TABLE IF NOT EXISTS fc.surgery_master (
    surgery_design_cd TEXT, tariff_cd TEXT, surgery_cd TEXT, surgery_name TEXT,
    surgery_type TEXT, department_cd TEXT, effect_from DATE, effect_to DATE,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
await c.query('TRUNCATE fc.surgery_master');
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const vals = [];
  const params = [];
  chunk.forEach((r, j) => {
    const b = j * 8;
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    params.push(...r);
  });
  await c.query(`INSERT INTO fc.surgery_master (surgery_design_cd,tariff_cd,surgery_cd,surgery_name,surgery_type,department_cd,effect_from,effect_to) VALUES ${vals.join(',')}`, params);
}
const cnt = await c.query('SELECT count(*)::int AS n, count(DISTINCT surgery_cd)::int AS codes, count(DISTINCT tariff_cd)::int AS tariffs FROM fc.surgery_master');
console.log('ingested:', JSON.stringify(cnt.rows[0]));
await c.query('CREATE INDEX IF NOT EXISTS idx_surgery_master_cd ON fc.surgery_master (surgery_cd)');

// ---------- 2A. package_bill_admissions coverage ----------
const A = await c.query(`
  WITH adm AS (
    SELECT DISTINCT ON (ip_no) ip_no, payer_type,
      NULLIF(TRIM(surgery_cd), '') AS surgery_cd,
      NULLIF(TRIM(surgery_name), '') AS surgery_name
    FROM fc.package_bill_admissions
  ), master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master),
  master_names AS (SELECT DISTINCT upper(regexp_replace(surgery_name, '\\s+', ' ', 'g')) AS nm FROM fc.surgery_master),
  jud AS (
    SELECT a.ip_no, a.payer_type,
      a.surgery_cd IS NOT NULL AS has_cd,
      a.surgery_name IS NOT NULL AS has_name,
      EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(a.surgery_cd,''), ',')) x
              WHERE TRIM(x) IN (SELECT surgery_cd FROM master_codes)) AS code_hit,
      EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(a.surgery_name,''), ',')) x
              WHERE upper(regexp_replace(TRIM(x), '\\s+', ' ', 'g')) IN (SELECT nm FROM master_names)) AS name_hit
    FROM adm a
  )
  SELECT payer_type,
    count(*)::int AS admissions,
    count(*) FILTER (WHERE has_cd)::int AS with_surgery_cd,
    count(*) FILTER (WHERE code_hit)::int AS code_in_master,
    count(*) FILTER (WHERE has_name AND NOT code_hit AND name_hit)::int AS name_only_in_master,
    count(*) FILTER (WHERE (has_cd OR has_name) AND NOT code_hit AND NOT name_hit)::int AS named_but_unmapped,
    count(*) FILTER (WHERE NOT has_cd AND NOT has_name)::int AS no_surgery_recorded
  FROM jud GROUP BY payer_type ORDER BY admissions DESC`);
console.log('A =', JSON.stringify(A.rows));

// examples of named-but-unmapped
const AX = await c.query(`
  WITH master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master),
  master_names AS (SELECT DISTINCT upper(regexp_replace(surgery_name, '\\s+', ' ', 'g')) AS nm FROM fc.surgery_master)
  SELECT DISTINCT ON (surgery_name) surgery_name, surgery_cd, payer_type
  FROM fc.package_bill_admissions a
  WHERE NULLIF(TRIM(surgery_name),'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(a.surgery_cd,''), ',')) x WHERE TRIM(x) IN (SELECT surgery_cd FROM master_codes))
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(a.surgery_name, ',')) x WHERE upper(regexp_replace(TRIM(x), '\\s+', ' ', 'g')) IN (SELECT nm FROM master_names))
  LIMIT 15`);
console.log('A unmapped examples =', JSON.stringify(AX.rows));

// ---------- 2B. mart.main_table coverage (all IP) ----------
// discover ot_json/services_json shape from one surgical row
const shape = await c.query(`SELECT jsonb_typeof(ot_json) AS ot_t, jsonb_typeof(services_json) AS sv_t,
  left(ot_json::text, 300) AS ot_sample FROM mart.main_table WHERE has_ot LIMIT 1`);
console.log('B json shape =', JSON.stringify(shape.rows[0]));

const B = await c.query(`
  WITH master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master),
  adm AS (
    SELECT m.admission_no, m.surgical_medical, m.payor_bucket,
      m.package_code IS NOT NULL AND m.package_code IN (SELECT surgery_cd FROM master_codes) AS pkg_code_hit,
      EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(m.derived_ot_service_codes,''), ',')) x
              WHERE TRIM(x) IN (SELECT surgery_cd FROM master_codes)) AS ot_code_hit,
      EXISTS (SELECT 1 FROM fc.package_bill_lines l
              WHERE l.ip_no = m.admission_no AND l.service_cd IN (SELECT surgery_cd FROM master_codes)) AS bill_line_hit
    FROM mart.main_table m
  )
  SELECT surgical_medical,
    count(*)::int AS admissions,
    count(*) FILTER (WHERE pkg_code_hit OR ot_code_hit OR bill_line_hit)::int AS mapped_any,
    count(*) FILTER (WHERE ot_code_hit)::int AS via_ot_code,
    count(*) FILTER (WHERE pkg_code_hit)::int AS via_package_code,
    count(*) FILTER (WHERE bill_line_hit)::int AS via_bill_line
  FROM adm GROUP BY surgical_medical ORDER BY admissions DESC`);
console.log('B =', JSON.stringify(B.rows));

// surgical-but-unmapped examples
const BX = await c.query(`
  WITH master_codes AS (SELECT DISTINCT surgery_cd FROM fc.surgery_master)
  SELECT m.admission_no, m.department_name, m.package_name, m.derived_ot_service_codes
  FROM mart.main_table m
  WHERE m.surgical_medical = 'Surgical'
    AND NOT (m.package_code IS NOT NULL AND m.package_code IN (SELECT surgery_cd FROM master_codes))
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(m.derived_ot_service_codes,''), ',')) x
                    WHERE TRIM(x) IN (SELECT surgery_cd FROM master_codes))
    AND NOT EXISTS (SELECT 1 FROM fc.package_bill_lines l
                    WHERE l.ip_no = m.admission_no AND l.service_cd IN (SELECT surgery_cd FROM master_codes))
  LIMIT 12`);
console.log('B unmapped surgical examples =', JSON.stringify(BX.rows));

await c.end();
