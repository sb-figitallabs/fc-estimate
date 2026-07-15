// #9 (15-Jul): robotic presence rate per treatment — overall vs per payor
// group — to decide at which level the 90% robotic classification runs.
// Uses the engine's own presence computation (resolved_context.robotic) by
// building every family per payor group with zero manual input; prints only
// families with any robotic presence. Read-only.
import 'dotenv/config';
import { buildEstimate } from '../src/modules/engine/buildEstimate.js';
import { EstimateInput } from '../src/routes/estimate.routes.js';
import { listFamilies } from '../src/modules/engine/cohort.js';
import { pool } from '../src/db/pool.js';

const GIPSA_ORG = process.env.VERIFY_GIPSA_ORG || 'ORG55';
const NONGIPSA_ORG = process.env.VERIFY_NONGIPSA_ORG || 'ORG57';
const PAYORS = [
  { key: 'cash', payor_bucket: 'Cash' },
  { key: 'gipsa', payor_bucket: 'GIPSA Insurance', organization_cd: GIPSA_ORG },
  { key: 'nongipsa', payor_bucket: 'Non-GIPSA Insurance', organization_cd: NONGIPSA_ORG },
];

const families = listFamilies().filter((f) => f.family_kind !== 'medical');
console.log(`checking robotic presence for ${families.length} surgical families × ${PAYORS.length} payors…`);

const rows = [];
let done = 0;
for (const f of families) {
  const rec = { family: f.family, label: f.label };
  for (const p of PAYORS) {
    try {
      const input = EstimateInput.parse({
        clinical: { procedure: f.family },
        payment: { payor_bucket: p.payor_bucket, ...(p.organization_cd ? { organization_cd: p.organization_cd } : {}) },
        controls: { room_type: 'Single' },
      });
      const est = await buildEstimate(input);
      rec[p.key] = est?.resolved_context?.robotic?.presence_rate ?? null;
    } catch { rec[p.key] = null; }
  }
  done++;
  if (done % 20 === 0) console.log(`  …${done}/${families.length}`);
  if ([rec.cash, rec.gipsa, rec.nongipsa].some((v) => v != null && v > 0)) rows.push(rec);
}

const fmt = (v) => (v == null ? '-' : `${Math.round(v)}%`);
console.log('\n===== ROBOTIC VARIANCE REPORT =====');
console.log('family | cash% | gipsa% | nongipsa%');
for (const r of rows.sort((a, b) => (b.cash ?? 0) - (a.cash ?? 0))) {
  console.log(`${r.label.slice(0, 55)} | ${fmt(r.cash)} | ${fmt(r.gipsa)} | ${fmt(r.nongipsa)}`);
}
const divergent = rows.filter((r) => (r.cash ?? 0) >= 50 && ((r.gipsa ?? 0) < 10 || (r.nongipsa ?? 0) < 10));
console.log(`\n${rows.length} families with robotic presence; ${divergent.length} diverge sharply across payors.`);
console.log(divergent.length
  ? 'VERDICT: classification must run PER PAYOR GROUP — overall-level would misclassify these.'
  : 'VERDICT: overall-level classification is safe on current data.');
await pool.end();
