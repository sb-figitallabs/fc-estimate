// #9 (15-Jul): robotic presence rate per treatment — overall vs per payor
// group — to decide at which level the 90% robotic classification runs.
// Read-only; prints a markdown-ish table.
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// robotic detection mirrors rules.isRoboticRow: robotic-flavoured line items
// on the admission's linked bill lines (package_bill_lines has no robotic
// flag, so use the service_item mart signal instead: look for robotic rows
// in the admission's itemized services).
const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='mart' AND table_name='main_table' AND column_name ILIKE '%robot%'`);
console.log('mart robotic columns:', cols.rows.map((r) => r.column_name).join(', ') || '(none)');
const roboticCol = cols.rows[0]?.column_name;
if (!roboticCol) {
  console.log('No robotic column on mart.main_table — falling back to template-name detection.');
}

const detect = roboticCol
  ? `(${roboticCol})::boolean`
  : `EXISTS (SELECT 1 FROM jsonb_array_elements_text(curated_template_names_jsonb) t WHERE t ILIKE '%ROBOTIC%')`;

const { rows } = await c.query(`
  WITH per_treatment AS (
    SELECT t.template, m.payor_bucket, ${detect} AS robotic
    FROM mart.main_table m, jsonb_array_elements_text(m.curated_template_names_jsonb) t(template)
    WHERE t.template NOT ILIKE '%ROBOTIC%'
  )
  SELECT template,
         count(*)::int total,
         round(100.0 * avg(robotic::int), 1) AS overall_pct,
         round(100.0 * avg(robotic::int) FILTER (WHERE payor_bucket = 'Cash'), 1) AS cash_pct,
         round(100.0 * avg(robotic::int) FILTER (WHERE payor_bucket = 'GIPSA Insurance'), 1) AS gipsa_pct,
         round(100.0 * avg(robotic::int) FILTER (WHERE payor_bucket = 'Non-GIPSA Insurance'), 1) AS nongipsa_pct
  FROM per_treatment
  GROUP BY 1
  HAVING count(*) >= 10 AND avg(robotic::int) > 0
  ORDER BY 3 DESC
  LIMIT 40`);
console.log('\ntemplate | total | overall% | cash% | gipsa% | nongipsa%');
rows.forEach((r) => console.log(
  `${r.template.slice(0, 55)} | ${r.total} | ${r.overall_pct} | ${r.cash_pct ?? '-'} | ${r.gipsa_pct ?? '-'} | ${r.nongipsa_pct ?? '-'}`
));
console.log(`\n${rows.length} treatments with any robotic presence (≥10 cases).`);
console.log('Verdict guide: rows where cash% is high but gipsa%/nongipsa% ~0 ⇒ classification MUST run per payor group.');
await c.end();
