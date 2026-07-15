import 'dotenv/config';
process.env.DATABASE_URL = 'postgresql://localhost/fc_handoff';
const { pool } = await import('./src/db/pool.js');
const { buildEstimate } = await import('./src/modules/engine/buildEstimate.js');

const est = await buildEstimate({
  patient: {},
  clinical: { procedure: 'total_knee_replacement_unilateral', treatment_text: 'Robotic TKR' },
  payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' },
  controls: { room_type: 'Single', estimate_mode: 'Typical' },
});
console.log('final_estimate:', est.final_estimate);
console.log('bucket_totals:', est.bucket_totals);
console.log('robotic ctx:', JSON.stringify(est.resolved_context.robotic, null, 2));
console.log('robotic_addon:', JSON.stringify(est.robotic_addon ?? null, null, 2));
console.log('robotic rows:', est.line_items.filter(r => /ROBO/i.test(r.name) || r.robotic_addon).map(r => ({ name: r.name, code: r.code, sel: r.selected, included: r.included })));
console.log('warnings:', est.warnings);
console.log('pkg:', est.package_offer?.status, est.package_offer?.package?.package_code, est.package_offer?.package?.package_name, 'with_package:', est.package_offer?.coverage?.totals?.with_package);
await pool.end();
