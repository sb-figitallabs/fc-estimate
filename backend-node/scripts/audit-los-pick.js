// D1 audit: conventional-TKR (robotic add-on) cohort shows LOS 5 (4–5) in
// flow-2 — manager expects ~3. Dump the underlying cases + both stay fields.
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows } = await c.query(`
  SELECT m.admission_no, m.payor_bucket, m.los_days, m.ward_days, m.icu_days,
         m.normalized_billable_stay_days AS norm, m.normalized_billable_stay_reason AS why,
         (r.ip_no IS NOT NULL) AS robotic
  FROM mart.main_table m
  LEFT JOIN fc.robotic_admission_classification r
         ON r.ip_no = m.admission_no AND r.robotic_billed
  WHERE m.curated_template_names_jsonb ? 'Total Knee Replacement (TKR)'
  ORDER BY m.admission_no DESC`);

const cash = rows.filter((r) => String(r.payor_bucket) === 'Cash');
const robo = cash.filter((r) => r.robotic);
const nonRobo = cash.filter((r) => !r.robotic);
const stats = (arr, k) => {
  const v = arr.map((r) => Number(r[k])).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))] : null;
  return `n=${v.length} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)}`;
};
console.log('cash conventional-TKR w/ robotic billed:', robo.length, 'rows');
for (const r of robo) console.log(` ${r.admission_no} raw_los=${r.los_days} ward=${r.ward_days} icu=${r.icu_days} norm=${r.norm} why="${(r.why || '').slice(0, 55)}"`);
console.log('robotic-billed  raw los:', stats(robo, 'los_days'), '| norm:', stats(robo, 'norm'));
console.log('non-robotic     raw los:', stats(nonRobo, 'los_days'), '| norm:', stats(nonRobo, 'norm'));
await c.end();
