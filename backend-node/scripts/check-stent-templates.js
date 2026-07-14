// One-off audit: which curated templates cover DJ stenting, and what does the
// Minor Endourological Procedure cohort actually contain?
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const q1 = await c.query(`
  SELECT t.template, count(*) n
  FROM mart.main_table m, jsonb_array_elements_text(m.curated_template_names_jsonb) t(template)
  WHERE t.template ILIKE '%stent%' OR t.template ILIKE '%ureter%' OR t.template ILIKE '%endouro%' OR t.template ILIKE '%cysto%'
  GROUP BY 1 ORDER BY 2 DESC`);
console.log('TEMPLATES matching stent/ureter/endouro/cysto:');
q1.rows.forEach((r) => console.log(' ', r.template, '->', r.n));

const q2 = await c.query(`
  SELECT count(*) n,
         round(avg(fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin)) avg_bill,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin)::numeric) p50
  FROM mart.main_table WHERE curated_template_names_jsonb ? 'Minor Endourological Procedure'`);
console.log('Minor Endourological Procedure cohort:', JSON.stringify(q2.rows[0]));

const cols = await c.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='mart' AND table_name='main_table'
    AND (column_name ILIKE '%surg%' OR column_name ILIKE '%proc%' OR column_name ILIKE '%treat%' OR column_name ILIKE '%diag%')`);
console.log('candidate name columns:', cols.rows.map((r) => r.column_name).join(', '));
const SN = cols.rows.find((r) => /surg/i.test(r.column_name))?.column_name;
if (!SN) {
  console.log('no surgery-name column found — stopping');
  await c.end();
  process.exit(0);
}

const q3 = await c.query(`
  SELECT coalesce(${SN}::text,'-') s, count(*) n
  FROM mart.main_table WHERE curated_template_names_jsonb ? 'Minor Endourological Procedure'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
console.log('Top surgeries inside Minor Endourological Procedure:');
q3.rows.forEach((r) => console.log(' ', r.n, 'x', String(r.s).slice(0, 100)));

const q4 = await c.query(`
  SELECT coalesce(${SN}::text,'-') s, count(*) n,
         round(avg(fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin)) avg_bill
  FROM mart.main_table
  WHERE ${SN}::text ILIKE '%dj sten%' OR ${SN}::text ILIKE '%double j%' OR ${SN}::text ILIKE '%djs%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
console.log('mart rows whose surgery name mentions DJ stent:');
q4.rows.forEach((r) => console.log(' ', r.n, 'x', String(r.s).slice(0, 100), 'avg', r.avg_bill));

const q5 = await c.query(`
  SELECT t.template, count(*) n
  FROM mart.main_table m, jsonb_array_elements_text(m.curated_template_names_jsonb) t(template)
  WHERE m.${SN}::text ILIKE '%dj sten%' OR m.${SN}::text ILIKE '%double j%'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
console.log('Which templates those DJ-stent admissions were curated into:');
q5.rows.forEach((r) => console.log(' ', r.template, '->', r.n));

await c.end();
