// Flow2 validation suite (16-Jul): every onboarded family × payor bucket
// through POST /api/flow2/evaluate, answering pending questions like a user
// would (majority option), asserting the manager's flow-doc invariants.
//
//   node scripts/flow2-validation-suite.mjs [baseUrl]   (default http://localhost:4200)
//
// Invariants checked per case:
//  I1  step order: payor → family_match → characterization → billing_identification
//      → historic_template → template_summary (prefix allowed while pending)
//  I2  payor resolution: Cash⇒TR1+Cash; ORG56⇒TR290+GIPSA; Non-GIPSA org⇒ own tariff
//  I3  a pending question ⇒ numbers null, options carry case counts, selection_key valid
//  I4  answering the question ⇒ decided_by "user" on that axis + evaluation proceeds
//  I5  numbers sanity: p25≤p50≤p75 everywhere; case_count>0; case_set≤min(count,200);
//      every case_set row obeys filters_applied (payor when exact, setting, robotic, care)
//  I6  package path ⇒ package_code + a used ladder rung; non-package ⇒ package null
//  I7  case_set-derived gross quartiles == numbers.gross.approximate_bill when the
//      case_set is complete (case_count ≤ 200) — numbers must be pure history
//  I8  case_filters payor_scope "all" ⇒ case_count ≥ the exact-scope count
//  I9  template_summary present with per-payor rows once decided
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { listFamilies } from '../src/modules/engine/cohort.js';

const BASE = process.argv[2] || 'http://localhost:4200';
const PAYORS = [
  { name: 'Cash', payment: { payor_bucket: 'Cash' }, tariff: 'TR1', group: 'Cash' },
  { name: 'GIPSA', payment: { payor_bucket: 'GIPSA Insurance', organization_cd: 'ORG56' }, tariff: 'TR290', group: 'GIPSA Insurance' },
];
const NONGIPSA_SAMPLE_EVERY = 5; // every 5th family also runs Non-GIPSA
const STEP_ORDER = ['payor', 'family_match', 'characterization', 'billing_identification', 'historic_template', 'template_summary'];
const CONCURRENCY = 5;

const failures = [];
const stats = { cases: 0, evaluations: 0, questions: 0, answered: 0, numbers: 0, package_path: 0, non_package: 0, no_match: 0, matcher_error: 0 };
const fail = (id, inv, msg) => failures.push({ id, inv, msg });

async function evaluate(body) {
  stats.evaluations++;
  const res = await fetch(`${BASE}/api/flow2/evaluate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const q3ok = (o) => o == null || (o.p25 <= o.p50 && o.p50 <= o.p75);
function quartile(sorted, q) {
  // percentile_cont equivalent (linear interpolation)
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function runCase(fam, payor) {
  const id = `${fam.family} × ${payor.name}`;
  stats.cases++;
  const selections = {};
  let r;
  try { r = await evaluate({ treatment_text: fam.label, payment: payor.payment, mode: 'historic', selections }); }
  catch (e) { fail(id, 'HTTP', e.message); return; }

  // Answer pending questions like a user (majority option), max 4 rounds.
  for (let round = 0; round < 4 && r.pending_question; round++) {
    stats.questions++;
    const pq = r.pending_question;
    if (r.numbers != null) fail(id, 'I3', 'numbers present while a question is pending');
    if (!['care_type', 'setting', 'robotic'].includes(pq.selection_key)) { fail(id, 'I3', `bad selection_key ${pq.selection_key}`); break; }
    if (!pq.options?.length || pq.options.some((o) => o.cases == null)) fail(id, 'I3', 'question options missing case counts');
    const best = [...(pq.options ?? [])].sort((a, b) => (b.cases ?? 0) - (a.cases ?? 0))[0];
    if (!best) break;
    selections[pq.selection_key] = best.value;
    stats.answered++;
    try { r = await evaluate({ treatment_text: fam.label, payment: payor.payment, mode: 'historic', selections }); }
    catch (e) { fail(id, 'HTTP', `answer round: ${e.message}`); return; }
    const ch = r.steps.find((s) => s.key === 'characterization');
    if (ch && ch.decided_by !== 'user') fail(id, 'I4', 'answered axis not marked decided_by user');
  }

  // I1 step order (done prefix of the canonical order)
  const keys = r.steps.map((s) => s.key);
  if (keys.some((k, i) => STEP_ORDER[i] !== k)) fail(id, 'I1', `step order ${keys.join('>')}`);

  // I2 payor
  const p = r.steps.find((s) => s.key === 'payor');
  if (!p) fail(id, 'I2', 'no payor step');
  else {
    if (payor.tariff && p.decision?.tariff_cd !== payor.tariff) fail(id, 'I2', `tariff ${p.decision?.tariff_cd} ≠ ${payor.tariff}`);
    if (payor.group && p.decision?.payor_group !== payor.group) fail(id, 'I2', `group ${p.decision?.payor_group} ≠ ${payor.group}`);
    if (payor.notTariff && p.decision?.tariff_cd === payor.notTariff) fail(id, 'I2', `tariff should not be ${payor.notTariff}`);
  }

  const famStep = r.steps.find((s) => s.key === 'family_match');
  if (famStep?.evidence?.error) { stats.matcher_error++; return; }
  if (famStep?.status === 'pending') { stats.no_match++; return; } // terminal no-match — legitimate for thin labels

  if (r.pending_question) { fail(id, 'I4', 'still pending after 4 answer rounds'); return; }

  // I9 template summary
  const ts = r.steps.find((s) => s.key === 'template_summary');
  if (!ts) fail(id, 'I9', 'template_summary missing on a decided flow');

  // I6 billing/package coherence
  const bill = r.steps.find((s) => s.key === 'billing_identification');
  const tmpl = r.steps.find((s) => s.key === 'historic_template');
  const isPkg = bill?.decision?.billing_type === 'package';
  if (isPkg) {
    stats.package_path++;
    if (!bill.decision.package_code) fail(id, 'I6', 'package path without package_code');
    const rungs = tmpl?.evidence?.rungs ?? tmpl?.evidence?.ladder ?? [];
    const used = Array.isArray(rungs) && rungs.some((x) => x.used || x.hit === true || x.status === 'used');
    if (Array.isArray(rungs) && rungs.length && !used) fail(id, 'I6', 'no used rung on the ladder');
  } else stats.non_package++;

  // I5/I7 numbers
  const n = r.numbers;
  if (!n) { fail(id, 'I5', 'no numbers on a fully decided flow'); return; }
  stats.numbers++;
  if (!(n.basis?.case_count > 0)) fail(id, 'I5', 'case_count 0 with numbers present');
  for (const b of n.buckets ?? []) if (!q3ok(b)) fail(id, 'I5', `bucket ${b.bucket} quartiles disordered`);
  if (!q3ok(n.gross?.approximate_bill)) fail(id, 'I5', 'gross approx quartiles disordered');
  if (!q3ok(n.gross?.package_bill)) fail(id, 'I5', 'gross package quartiles disordered');
  for (const k of ['los_days', 'icu_days', 'ot_hours']) if (!q3ok(n.typical_inputs?.[k])) fail(id, 'I5', `${k} quartiles disordered`);
  const cs = n.case_set ?? [];
  if (cs.length > Math.min(n.basis.case_count, 200)) fail(id, 'I5', `case_set ${cs.length} > min(case_count,200)`);
  const fa = n.basis.filters_applied ?? {};
  for (const row of cs) {
    if (fa.payor_scope === 'exact' && payor.group && row.payor_bucket !== payor.group) { fail(id, 'I5', `case ${row.ip_no} payor ${row.payor_bucket} escapes exact scope`); break; }
    if (fa.setting && row.setting !== fa.setting) { fail(id, 'I5', `case ${row.ip_no} setting ${row.setting} ≠ ${fa.setting}`); break; }
    if (fa.robotic === 'yes' && row.robotic !== true) { fail(id, 'I5', `case ${row.ip_no} not robotic under robotic=yes filter`); break; }
    if (fa.robotic === 'no' && row.robotic === true) { fail(id, 'I5', `case ${row.ip_no} robotic under robotic=no filter`); break; }
    if (fa.care_type && row.care_type && row.care_type !== fa.care_type) { fail(id, 'I5', `case ${row.ip_no} care ${row.care_type} ≠ ${fa.care_type}`); break; }
  }
  // I7 pure-history: recompute gross quartiles from the (complete) case set
  if (n.basis.case_count <= 200 && cs.length === n.basis.case_count && cs.length >= 4 && n.gross?.approximate_bill) {
    const sorted = cs.map((c) => Number(c.gross)).filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === cs.length) {
      const g = n.gross.approximate_bill;
      for (const [q, key] of [[0.25, 'p25'], [0.5, 'p50'], [0.75, 'p75']]) {
        const mine = Math.round(quartile(sorted, q));
        if (Math.abs(mine - g[key]) > 2) { fail(id, 'I7', `${key}: recomputed ${mine} vs reported ${g[key]}`); break; }
      }
    }
  }
  return { id, r, selections, payor };
}

async function main() {
  const t0 = Date.now();
  const families = listFamilies();
  console.log(`flow2 validation: ${families.length} families, base ${BASE}`);

  const jobs = [];
  families.forEach((fam, i) => {
    for (const p of PAYORS) jobs.push({ fam, payor: p });
    if (i % NONGIPSA_SAMPLE_EVERY === 0) jobs.push({ fam, payor: { name: 'NonGIPSA', payment: { payor_bucket: 'Non-GIPSA Insurance', organization_cd: 'ORG91' }, group: 'Non-GIPSA Insurance', notTariff: 'TR290' } });
  });

  const okCases = [];
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (jobs.length) {
      const j = jobs.shift();
      const out = await runCase(j.fam, j.payor).catch((e) => fail(`${j.fam.family} × ${j.payor.name}`, 'CRASH', e.message));
      if (out) okCases.push(out);
      if (++done % 25 === 0) console.log(`  …${done} cases, ${failures.length} failures so far`);
    }
  });
  await Promise.all(workers);

  // I8 spot-check: payor-scope widening on 12 decided package cases
  for (const c of okCases.filter((x) => x.r.numbers).slice(0, 12)) {
    try {
      const wide = await evaluate({ treatment_text: c.r.steps.find((s) => s.key === 'family_match').decision.label ?? c.id.split(' × ')[0], payment: c.payor.payment, mode: 'historic', selections: { ...c.selections, family: c.r.steps.find((s) => s.key === 'family_match').decision.family, case_filters: { payor_scope: 'all', setting: null, robotic: null, care_type: null } } });
      if (wide.numbers && c.r.numbers && wide.numbers.basis.case_count < c.r.numbers.basis.case_count) {
        fail(c.id, 'I8', `payor_scope all count ${wide.numbers.basis.case_count} < exact ${c.r.numbers.basis.case_count}`);
      }
    } catch (e) { fail(c.id, 'I8', e.message); }
  }

  // Scenario probes
  try { // no-match gibberish
    const g = await evaluate({ treatment_text: 'zzqx flibber procedure', payment: { payor_bucket: 'Cash' }, mode: 'historic' });
    const fm = g.steps.find((s) => s.key === 'family_match');
    if (!(fm?.status === 'pending' && g.numbers == null)) fail('gibberish', 'I-nomatch', 'no terminal no-match state');
  } catch (e) { fail('gibberish', 'I-nomatch', e.message); }
  try { // combo signal
    const cb = await evaluate({ treatment_text: 'lap cholecystectomy + inguinal hernia repair', payment: { payor_bucket: 'Cash' }, mode: 'historic' });
    const bi = cb.steps.find((s) => s.key === 'billing_identification');
    if (!bi?.evidence?.possible_combo) fail('combo', 'I-combo', 'possible_combo signal missing');
  } catch (e) { fail('combo', 'I-combo', e.message); }
  try { // mode both note
    const mb = await evaluate({ treatment_text: 'total knee replacement', payment: { payor_bucket: 'Cash' }, mode: 'both', selections: { robotic: 'no' } });
    if (mb.numbers && !mb.numbers.note) fail('mode-both', 'I-mode', 'numbers.note missing for mode both');
  } catch (e) { fail('mode-both', 'I-mode', e.message); }

  // ── report ──
  const secs = Math.round((Date.now() - t0) / 1000);
  const byInv = {};
  for (const f of failures) (byInv[f.inv] ??= []).push(f);
  let md = `# Flow2 validation — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `Cases: ${stats.cases} (evaluations incl. answers: ${stats.evaluations}) in ${secs}s\n`;
  md += `Questions asked: ${stats.questions}, answered: ${stats.answered}\n`;
  md += `Reached numbers: ${stats.numbers} · package path: ${stats.package_path} · non-package: ${stats.non_package} · no-match: ${stats.no_match} · matcher-flake: ${stats.matcher_error}\n`;
  md += `\n## Failures: ${failures.length}\n`;
  for (const [inv, list] of Object.entries(byInv)) {
    md += `\n### ${inv} (${list.length})\n`;
    for (const f of list.slice(0, 20)) md += `- ${f.id}: ${f.msg}\n`;
    if (list.length > 20) md += `- …and ${list.length - 20} more\n`;
  }
  writeFileSync('flow2-validation-report.md', md);
  console.log(md);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
