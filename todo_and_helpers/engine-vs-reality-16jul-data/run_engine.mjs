// Runs the FC estimate engine per extracted FC case.
// Usage: node run_engine.mjs [filefilter]
import fs from 'fs';

const BASE = 'https://fc-estimate-dev.figitallabs.com';
const DIR = '/private/tmp/fc-eval';
const OUT = `${DIR}/engine_runs.jsonl`;
const ONLY = process.argv[2];

const fcs = fs.readFileSync(`${DIR}/fc_cases.jsonl`, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const fbs = fs.readFileSync(`${DIR}/fb_cases.jsonl`, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const norm = (s) => s.replace(/\.pdf$/i, '').replace(/\b(FC|FB)\b/gi, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
const fbByName = new Map(fbs.map((b) => [norm(b.file), b]));

async function post(path, body, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(BASE + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { j = { parse_error: text.slice(0, 300) }; }
      if (!r.ok) { if (i < tries && r.status >= 500) { await new Promise((res) => setTimeout(res, 5000)); continue; } return { _http: r.status, ...j }; }
      return j;
    } catch (e) {
      if (i < tries) { await new Promise((res) => setTimeout(res, 5000)); continue; }
      return { _error: e.message };
    }
  }
}

let ORGS = null;
async function orgs() {
  if (!ORGS) ORGS = await (await fetch(BASE + '/api/lookup/organizations')).json();
  return ORGS;
}

const simplify = (s) => String(s || '').toUpperCase().replace(/\b(LIMITED|LIMIT|LTD|CO|COMPANY|PVT|PRIVATE|TPA|INSURANCE|GENERAL|HEALTH|CORPORATION|CORPO|INDIA)\b/g, ' ').replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

async function resolveOrg(fc, fb) {
  const list = await orgs();
  const targets = [fb?.organization, fc.tpa].filter(Boolean);
  for (const t of targets) {
    const tSimp = simplify(t);
    if (!tSimp) continue;
    // score: shared word overlap
    let best = null, bestScore = 0;
    for (const o of list) {
      const oSimp = simplify(o.organization_name);
      if (!oSimp) continue;
      const tw = new Set(tSimp.split(' ')), ow = new Set(oSimp.split(' '));
      let hit = 0; for (const w of tw) if (ow.has(w)) hit++;
      const score = hit / Math.max(tw.size, 1) + (oSimp === tSimp ? 1 : 0);
      // prefer orgs that actually have cases
      const cases = Object.values(o.buckets || {}).reduce((a, b) => a + b, 0);
      const adj = score + Math.min(cases, 500) / 100000;
      if (hit > 0 && adj > bestScore) { bestScore = adj; best = o; }
    }
    if (best && bestScore >= 0.5) {
      const buckets = best.buckets || {};
      const bucket = Object.keys(buckets).sort((a, b) => buckets[b] - buckets[a])[0] || 'Non-GIPSA Insurance';
      return { organization_cd: best.organization_cd, organization_name: best.organization_name, payor_bucket: bucket, matched_from: t, score: +bestScore.toFixed(2) };
    }
  }
  return { organization_cd: null, organization_name: null, payor_bucket: 'Non-GIPSA Insurance', matched_from: targets[0] ?? null, score: 0 };
}

const roomOf = (fc) => {
  const cands = [fc.opted_room, fc.eligible_room, fc.room, fc.remarks_other_notes];
  for (const c of cands) {
    if (!c) continue;
    const s = String(c).toUpperCase();
    if (/TWIN/.test(s)) return 'Twin';
    if (/SINGLE|DELUXE|SUITE/.test(s)) return 'Single';
    if (/GENERAL|WARD/.test(s)) return 'General';
  }
  return 'General';
};

const isRobotic = (fc) => {
  const t = [fc.surgery_name, fc.remarks_procedure_detail, fc.robotic_or_special_equipment].filter(Boolean).join(' ').replace(/Implants & Special Equipment[^]*$/i, '');
  if (/NON[- ]?ROBOTIC/i.test(t)) return false;
  return /ROBOTIC|ROBOT/i.test(t);
};
const specialEquip = (fc) => {
  const t = [fc.surgery_name, fc.remarks_procedure_detail, fc.remarks_other_notes, fc.robotic_or_special_equipment].filter(Boolean).join(' ');
  const m = t.match(/COB[AL]LAT\w*|COBLATOR|NAVIGATION|HOLMIUM|LASER/i);
  return m ? m[0] : null;
};

const treatmentTextOf = (fc) => {
  const parts = [];
  if (fc.surgery_name) parts.push(fc.surgery_name);
  const det = fc.remarks_procedure_detail;
  if (det && det.toUpperCase() !== (fc.surgery_name || '').toUpperCase()) parts.push(det.replace(/^SURGERY\s*:?-?\s*/i, ''));
  if (!parts.length) parts.push(fc.care_management === 'Medical' ? 'MEDICAL MANAGEMENT' : 'UNSPECIFIED');
  return parts.join(' / ');
};

async function flow2Resolve(treatmentText, payment, sel) {
  // iterate answering pending questions with FC-derived answers
  const selections = { ...sel };
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await post('/api/flow2/evaluate', { treatment_text: treatmentText, payment, selections, mode: 'historic' });
    if (last._error || last._http) return { flow2: last, selections };
    const pq = last.pending_question;
    if (!pq) break;
    const key = pq.selection_key;
    if (key && selections[key] == null) {
      // answer from provided defaults; else take the majority option
      const opt = pq.options?.[0];
      selections[key] = sel[`_${key}_default`] ?? opt?.value ?? null;
      if (selections[key] == null) break;
    } else break;
  }
  return { flow2: last, selections };
}

function summarizeBuild(b) {
  if (!b || b._error || b._http) return { error: b?._error || `http ${b?._http}`, detail: JSON.stringify(b).slice(0, 400) };
  const rc = b.resolved_context || {};
  const sel = b.grand_total?.selected || {};
  const roomKey = (rc.room_type || 'General').toLowerCase();
  const band = b.grand_total?.[roomKey] || null;
  const po = b.package_offer;
  return {
    family: rc.family, family_kind: rc.family_kind, cohort_cases: rc.cohort_case_count,
    tariff: rc.tariff?.tariff_name, room: rc.room_type,
    los: b.drivers?.los, icu: b.drivers?.icu,
    final_estimate: b.final_estimate != null ? Math.round(b.final_estimate) : null,
    band: band ? band.map((x) => Math.round(x)) : null,
    bucket_totals: Object.fromEntries(Object.entries(b.bucket_totals || {}).map(([k, v]) => [k, Math.round(v)])),
    robotic_addon: b.estimate?.robotic_addon ?? b.resolved_context?.robotic?.addon ?? null,
    package_offer: po ? {
      status: po.status, source: po.source,
      code: po.package?.package_code, name: po.package?.package_name,
      amount: po.package?.package_amount != null ? Number(po.package.package_amount) : null,
      atl_amount: po.package?.package_atl_amount != null ? Number(po.package.package_atl_amount) : null,
      payable_extras: po.payable_extras ?? po.extras_total ?? null,
      with_package_total: po.with_package_total ?? po.total_with_package ?? null,
    } : null,
    warnings: b.warnings, unresolved: b.unresolved_items,
  };
}

async function runCase(fc) {
  const fb = fbByName.get(norm(fc.file)) ?? null;
  const rec = { file: fc.file, patient: fc.patient, fb_file: fb?.file ?? null };
  const treatment_text = treatmentTextOf(fc);
  rec.treatment_text = treatment_text;
  rec.special_equipment = specialEquip(fc);
  rec.fc_robotic = isRobotic(fc);

  // payor
  let payment;
  if (/cash/i.test(fc.payment_mode || '')) payment = { payor_bucket: 'Cash' };
  else {
    const org = await resolveOrg(fc, fb);
    rec.org_resolution = org;
    payment = { payor_bucket: org.payor_bucket, ...(org.organization_cd ? { organization_cd: org.organization_cd } : {}) };
  }
  rec.payment = payment;

  // flow2: family + billing identification
  const careType = fc.care_management === 'Medical' ? 'Medical' : fc.care_management === 'Surgical' ? 'Surgical' : undefined;
  const daycare = /DAY ?CARE/i.test([fc.remarks_procedure_detail, fc.remarks_other_notes, fc.surgery_name].filter(Boolean).join(' '));
  const sel = {};
  if (careType) sel.care_type = careType;
  if (daycare) sel.setting = 'Daycare';
  sel._robotic_default = rec.fc_robotic ? 'yes' : 'no';
  sel._setting_default = daycare ? 'Daycare' : 'Inpatient';
  sel._care_type_default = careType ?? 'Surgical';
  const { flow2, selections } = await flow2Resolve(treatment_text, payment, sel);
  rec.flow2_selections = selections;
  if (flow2._error || flow2._http) rec.flow2_error = flow2;
  else {
    const steps = flow2.steps || [];
    const fam = steps.find((s) => (s.key || s.step_key || s.id) === 'family_match') || steps[1];
    rec.family_match = fam?.decision ?? null;
    rec.family_alternatives = (fam?.alternatives || []).slice(0, 3);
    const bill = steps.find((s) => /billing/.test(s.key || s.step_key || s.id || ''));
    rec.billing_identification = bill?.decision ?? null;
    rec.flow2_numbers = flow2.numbers ? { gross: flow2.numbers.gross?.approximate_bill ?? flow2.numbers.gross ?? null } : null;
    rec.flow2_pending = flow2.pending_question ? { q: flow2.pending_question.question, key: flow2.pending_question.selection_key } : null;
  }

  const family = rec.family_match?.family ?? null;
  rec.no_match = !family;
  if (family) {
    const room = roomOf(fc);
    rec.room_used = room;
    const controls = {
      room_type: room,
      ...(careType ? { care_type: careType } : {}),
      ...(selections.setting ? { setting: selections.setting } : {}),
      robotic: rec.fc_robotic ? 'yes' : (selections.robotic ?? 'auto'),
    };
    const clinical = { procedure: family, treatment_text };
    // a) planned-LOS build (FC's LOS)
    if (fc.los != null) {
      rec.build_planned = summarizeBuild(await post('/api/estimate/build', {
        clinical, payment, controls: { ...controls, los_basis: 'Manual', los_manual: fc.los },
      }));
    }
    // b) engine-default build (P50)
    rec.build_default = summarizeBuild(await post('/api/estimate/build', { clinical, payment, controls }));
    // c) replay at ACTUAL LOS (and actual ward room if parsable) when it differs
    const actualLos = fb?.actual_los_days;
    if (actualLos != null && fc.los != null && actualLos !== fc.los) {
      const wardRoom = /TWIN/i.test(fb.admitted_ward || '') ? 'Twin' : /SINGLE|DELUXE/i.test(fb.admitted_ward || '') ? 'Single' : /GENERAL|WARD\b/i.test(fb.admitted_ward || '') ? 'General' : room;
      rec.build_replay_actual = summarizeBuild(await post('/api/estimate/build', {
        clinical, payment, controls: { ...controls, room_type: wardRoom, los_basis: 'Manual', los_manual: actualLos },
      }));
      rec.replay_room = wardRoom; rec.replay_los = actualLos;
    }
  }
  return rec;
}

async function main() {
  let done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l.trim()) done.add(JSON.parse(l).file);
  let list = fcs.filter((c) => !done.has(c.file));
  if (ONLY) list = list.filter((c) => c.file.toLowerCase().includes(ONLY.toLowerCase()));
  console.log(`${list.length} cases to run (${done.size} already done)`);
  for (const fc of list) {
    const t0 = Date.now();
    try {
      const rec = await runCase(fc);
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log('ok', fc.file, `family=${rec.family_match?.family ?? 'NONE'}`, `planned=${rec.build_planned?.final_estimate ?? '-'}`, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      console.error('FAIL', fc.file, e.message);
      fs.appendFileSync(OUT, JSON.stringify({ file: fc.file, fatal: e.message }) + '\n');
    }
  }
  console.log('done');
}
main();
