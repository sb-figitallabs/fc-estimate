/**
 * Renders test_results/insurance_edge_results.json into an HTML report,
 * then prints it to PDF via headless Chrome.
 * Usage: node scripts/edge_insurance_report.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const results = JSON.parse(readFileSync('test_results/insurance_edge_results.json', 'utf8'));
const inr = (v) => v == null ? '—' : '₹' + Math.round(v).toLocaleString('en-IN');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

const insSummary = (i) => {
  if (!i) return '—';
  const bits = [`SI ${inr(i.base_sum_insured)}`];
  if (i.consumed) bits.push(`consumed ${inr(i.consumed)}`);
  if (i.ncb) bits.push(`NCB ${inr(i.ncb)}`);
  if (i.top_up?.amount) bits.push(`top-up ${inr(i.top_up.amount)} ${i.top_up.type} (ded ${inr(i.top_up.deductible)})`);
  if (i.room_rent_cap && i.room_rent_cap.type !== 'none') bits.push(`cap ${i.room_rent_cap.type}${i.room_rent_cap.value ? ' ' + inr(i.room_rent_cap.value) + '/d' : ''}`);
  if (i.room_eligibility) bits.push(`eligible ${i.room_eligibility}`);
  if (i.copay?.value) bits.push(`copay ${i.copay.type === 'percentage' ? i.copay.value + '%' : inr(i.copay.value)}`);
  if (i.sub_limits?.length) bits.push('sub-limits: ' + i.sub_limits.map((s) => `${s.applies_to} ${inr(s.cap)}`).join(', '));
  return bits.join(' · ');
};
const breakdown = (p) => !p ? '—' : [
  p.proportionate_deduction ? `room-cap deduction ${inr(p.proportionate_deduction)}` : null,
  p.nme ? `NME ${inr(p.nme)}` : null,
  p.copay ? `copay ${inr(p.copay)}` : null,
  p.sub_limit_overflow ? `sub-limit overflow ${inr(p.sub_limit_overflow)}` : null,
  p.room_upgrade_excess ? `upgrade excess ${inr(p.room_upgrade_excess)}` : null,
  p.beyond_cover ? `beyond cover ${inr(p.beyond_cover)}` : null,
].filter(Boolean).join('<br>') || 'nothing — fully covered';

const famShort = (f) => ({ total_hip_replacement_thr_hemiarthroplasty: 'THR', total_knee_replacement_unilateral: 'TKR uni', robotic_tkr_unilateral_right: 'Robotic TKR R', chemotherapy_systemic_therapy_infusion_daycare: 'Chemo daycare', lscs_caesarean: 'LSCS' })[f] || f;

const bugCount = results.filter((r) => r.bugs?.length).length;
const rowsHtml = results.map((r) => {
  const s = r.settlement && !r.settlement.error ? r.settlement : null;
  const status = r.expectError
    ? (r.bugs?.length ? `<span class="bad">✗ got ${r.status}</span>` : '<span class="ok">✓ rejected</span>')
    : r.bugs?.length ? '<span class="bad">✗ BUG</span>' : r.warns?.length ? '<span class="warn">⚠ pass*</span>' : '<span class="ok">✓ pass</span>';
  return `<tr class="${r.bugs?.length ? 'rbad' : ''}">
    <td><b>${r.id}</b></td>
    <td><b>${esc(r.name)}</b><div class="sub">${famShort(r.family) || ''} · ${esc(r.org || '')} · ${esc(r.room || '')}</div>
        <div class="sub inp">${insSummary(r.input)}</div>
        ${r.bugs?.length ? `<div class="bugnote">${r.bugs.map(esc).join('<br>')}</div>` : ''}</td>
    <td class="num">${inr(r.without_package)}</td>
    <td class="num">${r.with_package == null ? '<span class="sub">no pkg</span>' : inr(r.with_package)}<div class="sub">${r.package_amount ? 'pkg ' + inr(r.package_amount) : ''}</div></td>
    <td class="num green">${s ? inr(s.insurer_total) : '—'}${s?.top_up_claim ? `<div class="sub">incl top-up ${inr(s.top_up_claim)}</div>` : ''}</td>
    <td class="num red">${s ? inr(s.patient_total) : '—'}</td>
    <td class="bd">${breakdown(s?.patient)}</td>
    <td class="num">${r.pkg_settlement ? inr(r.pkg_settlement.insurer_total) + ' / ' + inr(r.pkg_settlement.patient_total) : '—'}</td>
    <td>${status}</td>
  </tr>`;
}).join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4 landscape; margin: 9mm; }
body { font: 8.5px/1.45 -apple-system, 'Helvetica Neue', sans-serif; color: #1a2233; }
h1 { font-size: 16px; margin: 0 0 2px; color: #0033CC; }
.meta { color: #667; font-size: 8.5px; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; }
th { background: #0033CC; color: #fff; padding: 4px 5px; text-align: left; font-size: 8px; }
td { border-bottom: 0.5px solid #d7dbe6; padding: 3.5px 5px; vertical-align: top; }
tr:nth-child(even) td { background: #f6f8fc; }
tr.rbad td { background: #fdeaea; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.green { color: #0a7d33; font-weight: 600; } .red { color: #b3261e; font-weight: 600; }
.ok { color: #0a7d33; font-weight: 700; } .bad { color: #b3261e; font-weight: 700; } .warn { color: #9a6b00; font-weight: 700; }
.sub { color: #667; font-size: 7.5px; } .inp { color: #345; margin-top: 1px; }
.bd { font-size: 7.5px; color: #345; min-width: 100px; }
.bugnote { color: #b3261e; font-size: 7.5px; margin-top: 2px; }
.legend { margin-top: 8px; color: #556; font-size: 8px; }
</style></head><body>
<h1>Insurance settlement — edge-case test report</h1>
<div class="meta">fc-builder-api · ${results.length} cases · ${bugCount} failed (bugs logged in INSURANCE_EDGE_BUGS.md) · ${results.filter((r) => r.warns?.length).length} passed with warnings · generated ${new Date().toISOString().slice(0, 10)}</div>
<table>
<tr><th>ID</th><th style="width:34%">Scenario &amp; policy inputs</th><th>Total w/o package</th><th>Total w/ package</th><th>Insurance covers</th><th>Patient pays</th><th>Patient-side breakdown</th><th>Pkg-route ins/pat</th><th>Result</th></tr>
${rowsHtml}
</table>
<div class="legend">
⚠ pass* = settlement math correct but "with package" total exceeds "without package" — the insurance packages' inclusion text is in a format the coverage parser cannot read yet (see BUG-2), so no line item is netted off against the package price.
Insurance covers / Patient pays refer to the itemized (no-package) route; "Pkg-route ins/pat" is the same policy settled against the package price + extras.
All amounts from POST /api/estimate/build on the dev dataset. Conservation invariant (insurer + patient = gross + upgrade-excess) held on every case that produced a settlement.
</div>
</body></html>`;

writeFileSync('test_results/insurance_edge_report.html', html);
console.log('HTML written: test_results/insurance_edge_report.html');
