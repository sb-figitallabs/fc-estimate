import 'dotenv/config';
process.env.DATABASE_URL = 'postgresql://localhost/fc_handoff';
const { pool } = await import('./src/db/pool.js');
const { buildEstimate } = await import('./src/modules/engine/buildEstimate.js');

const cases = [
  ['A. GIPSA TKR-bilateral, no robotic ask (61% presence => optional+prompt)',
    { clinical: { procedure: 'total_knee_replacement_bilateral' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, controls: { room_type: 'Single' } }],
  ['B. GIPSA TKR-uni via gate flag robotic_addon (no robotic text)',
    { clinical: { procedure: 'total_knee_replacement_unilateral', robotic_addon: true }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, controls: { room_type: 'Single' } }],
  ['C. GIPSA TKR-uni robotic text BUT controls.robotic=no (explicit decline wins)',
    { clinical: { procedure: 'total_knee_replacement_unilateral', treatment_text: 'Robotic TKR' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, controls: { room_type: 'Single', robotic: 'no' } }],
  ['D. Cash TKR-uni, no robotic ask (0% cash presence => absent)',
    { clinical: { procedure: 'total_knee_replacement_unilateral' }, payment: { payor_bucket: 'Cash' }, controls: { room_type: 'Single' } }],
  ['E. Cash robotic TKR family (parity family — addon must be absent; procedure row prices robotic)',
    { clinical: { procedure: 'robotic_tkr_unilateral_right' }, payment: { payor_bucket: 'Cash' }, controls: { room_type: 'Single' } }],
  ['F. GIPSA THR (42% => optional+prompt)',
    { clinical: { procedure: 'total_hip_replacement_thr_hemiarthroplasty' }, payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, controls: { room_type: 'Single' } }],
];
for (const [label, input] of cases) {
  const est = await buildEstimate({ patient: {}, ...input });
  const ra = est.robotic_addon ?? null;
  const row = est.line_items.find(r => r.robotic_addon);
  console.log('\n---', label);
  console.log('final:', est.final_estimate, '| selection:', est.resolved_context.robotic.selection, '| presence:', Math.round(est.resolved_context.robotic.presence_rate * 10) / 10);
  console.log('addon:', ra ? { status: ra.status, source: ra.source, amount: ra.amount, code: ra.item_code, prompt: ra.prompt ?? null } : null);
  console.log('row:', row ? { name: row.name, included: row.included, single: row.selected.single, bucket: row.bucket } : null);
}
await pool.end();
