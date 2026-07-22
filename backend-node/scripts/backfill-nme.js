/**
 * NME Phase-1 backfill — historical HIMS NME source + cohort profiles.
 *
 * Source : RawData/FC Data/Estimate-Variance-Report (1).csv  (HIMS NME Amount)
 * Target : fc.fc_nme_source   (per present-IP NME, lineage, negatives quarantined)
 *          fc.nme_profile      (cohort positive-prob + positive-value percentiles)
 *
 * Manager constraint (i23.md): import ONLY IPs already present in
 * fc.package_bill_admissions, only relevant fields, no PII/noise. HIMS NME is the
 * modelling target; FC NME is comparison only; negative HIMS NME is quarantined.
 *
 *   node scripts/backfill-nme.js ["/path/to/Estimate-Variance-Report (1).csv"]
 *
 * Idempotent: applies migration 003, then DELETE + reload in one transaction.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'fast-csv';
import { pool } from '../src/db/pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSV = process.argv[2] || `${process.env.HOME}/Downloads/FC Data/Estimate-Variance-Report (1).csv`;
const SRC_FILE = 'Estimate-Variance-Report (1).csv';

const normIp = (s) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const BLANK = new Set(['', 'NA', 'N/A', 'NULL', 'NONE', '-', '--']);
const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[₹,\s]/g, '').trim();
  if (s === '' || BLANK.has(s.toUpperCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  const s = String(v ?? '').trim();
  if (!s || BLANK.has(s.toUpperCase())) return null;
  const d = s.split(/[ T]/)[0];
  let m = d.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // DD-MM-YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = d.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
const boolPkg = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === '' ? null : ['yes', 'y', 'true', '1', 'package'].includes(s); };
// percentile over a sorted ascending numeric array (nearest-rank, clamped)
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : null;
const completeness = (r) => Object.values(r).filter((v) => v != null && v !== '').length;

async function readCsv() {
  return new Promise((resolve, reject) => {
    const rows = [];
    let i = 0;
    fs.createReadStream(CSV)
      .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
      .on('error', reject)
      .on('data', (row) => { i += 1; rows.push({ ...row, __row: i }); })
      .on('end', () => resolve(rows));
  });
}

async function main() {
  console.log(`[nme] source: ${CSV}`);
  if (!fs.existsSync(CSV)) throw new Error(`CSV not found: ${CSV}`);

  const client = await pool.connect();
  try {
    // migration (idempotent)
    const mig = fs.readFileSync(path.join(HERE, '../migrations/003_nme_source_and_profile.sql'), 'utf8');
    await client.query(mig);
    console.log('[migrate] applied 003_nme_source_and_profile.sql');

    // present-IP set + governed cohort dims from our DB
    const adm = await client.query(`
      SELECT ip_no, payer_type, p_tariff_cd, organization_name, department_name,
             open_bill_or_pkg_bill, patient_ward_stay, patient_icu_stay, matched_in_mart,
             date_of_admission
      FROM fc.package_bill_admissions`);
    const dbByIp = new Map();
    for (const r of adm.rows) { const k = normIp(r.ip_no); if (k) dbByIp.set(k, r); }
    console.log(`[db] present admissions: ${dbByIp.size}`);

    // parse EVR, keep present IPs, pick canonical row per IP
    const raw = await readCsv();
    console.log(`[csv] rows: ${raw.length}`);
    const canon = new Map(); // ip -> best EVR row
    let orphan = 0;
    for (const r of raw) {
      const ipRaw = r['Patient IP Number'];
      const ip = normIp(ipRaw);
      if (!ip || BLANK.has(String(ipRaw ?? '').trim().toUpperCase())) continue;
      if (!dbByIp.has(ip)) { orphan += 1; continue; }               // manager: present IPs only
      const cur = canon.get(ip);
      if (!cur) { canon.set(ip, r); continue; }
      // canonical selection: completeness → latest Final Estimate Date → highest row
      const a = completeness(r), b = completeness(cur);
      const da = toDate(r['Final Estimate Date']) ?? '', db = toDate(cur['Final Estimate Date']) ?? '';
      if (a > b || (a === b && da > db) || (a === b && da === db && r.__row > cur.__row)) canon.set(ip, r);
    }
    console.log(`[match] present IPs matched: ${canon.size} | EVR-only orphans dropped: ${orphan}`);

    await client.query('BEGIN');
    await client.query('TRUNCATE fc.fc_nme_source');

    let loaded = 0, neg = 0;
    const vals = [];
    for (const [ip, r] of canon) {
      const hims = num(r['HIMS NME Amount (Rs.)']);
      const isNeg = hims != null && hims < 0;
      if (isNeg) neg += 1;
      vals.push([
        ip, hims, num(r['FC NME Amount (Rs.)']), r['Payer Type'] || null, r['Department Name'] || null,
        r['Procedure Name'] || null, r['Estimate Type'] || null, boolPkg(r['IS PACKAGE']),
        num(r['Package Amount']), num(r['Final Bill (Rs.)']), num(r['Room Stay']), num(r['ICU Stay']),
        num(r['Length Of Stay']), toDate(r['Admission Date']), toDate(r['Discharge Date']),
        isNeg, toDate(r['Final Estimate Date']), SRC_FILE, r.__row,
      ]);
    }
    // bulk insert in chunks
    const COLS = 19;
    for (let i = 0; i < vals.length; i += 500) {
      const chunk = vals.slice(i, i + 500);
      const ph = chunk.map((_, k) => `(${Array.from({ length: COLS }, (_, j) => `$${k * COLS + j + 1}`).join(',')})`).join(',');
      await client.query(
        `INSERT INTO fc.fc_nme_source (ip_no, hims_nme_amount, fc_nme_amount, payer_type, department_name,
           procedure_name, estimate_type, is_package, package_amount, final_bill, room_stay, icu_stay,
           length_of_stay, admission_date, discharge_date, is_negative_nme, final_estimate_date, source_file, source_row)
         VALUES ${ph}`, chunk.flat());
      loaded += chunk.length;
    }
    console.log(`[load] fc_nme_source: ${loaded} rows (negatives quarantined: ${neg})`);

    // ---- profiles: governed-clean cohort (matched_in_mart), exclude negatives ----
    const payerBucket = (a) => {
      const p = String(a.payer_type ?? '').toUpperCase();
      if (p === 'PRIVATE') return 'Cash';
      if (p === 'CORPORATE') return 'Corporate';
      if (p === 'INTERNATIONAL') return 'International';
      if (p === 'INSURANCE') return String(a.p_tariff_cd ?? '').toUpperCase() === 'TR290' ? 'GIPSA Insurance' : 'Non-GIPSA Insurance';
      return 'Unknown';
    };
    const losBand = (d) => d <= 2 ? '0-2' : d <= 5 ? '3-5' : d <= 10 ? '6-10' : '11+';
    const icuBand = (d) => d <= 0 ? '0' : d <= 2 ? '1-2' : '3+';

    // one modelling record per clean admission that has a (non-negative) HIMS NME
    const src = await client.query(`SELECT ip_no, hims_nme_amount, admission_date FROM fc.fc_nme_source WHERE is_negative_nme = false AND hims_nme_amount IS NOT NULL`);
    const nmeByIp = new Map(src.rows.map((r) => [normIp(r.ip_no), { nme: Number(r.hims_nme_amount), adm: r.admission_date }]));

    const recs = [];
    for (const [ip, a] of dbByIp) {
      if (!a.matched_in_mart) continue;                 // governed-clean only
      const s = nmeByIp.get(ip); if (!s) continue;
      const los = (Number(a.patient_ward_stay) || 0) + (Number(a.patient_icu_stay) || 0);
      const icu = Number(a.patient_icu_stay) || 0;
      recs.push({
        payer: payerBucket(a),
        pkg: a.open_bill_or_pkg_bill || 'Unknown',
        dept: a.department_name || 'Unknown',
        los: losBand(los), icu: icuBand(icu),
        nme: s.nme, adm: s.adm,
      });
    }
    console.log(`[profile] clean modelling records: ${recs.length}`);

    // aggregate a group of records → percentile row
    const summarize = (group) => {
      const pos = group.filter((r) => r.nme > 0).map((r) => r.nme).sort((x, y) => x - y);
      const all = group.map((r) => r.nme).sort((x, y) => x - y);
      const last = group.reduce((m, r) => (r.adm && (!m || r.adm > m) ? r.adm : m), null);
      return {
        admissions: group.length, positive_count: pos.length,
        positive_prob: group.length ? +(pos.length / group.length).toFixed(4) : null,
        p25: pct(pos, .25), p50: pct(pos, .50), p75: pct(pos, .75), p80: pct(pos, .80),
        p50_incl_zero: pct(all, .50), p75_incl_zero: pct(all, .75), last_seen: last,
      };
    };
    const key = (o) => `${o.payer}||${o.pkg}||${o.dept}||${o.los}||${o.icu}`;
    const rollup = (recs2, level, dims) => {
      const g = new Map();
      for (const r of recs2) {
        const k = dims(r);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(r);
      }
      const out = [];
      for (const [k, grp] of g) {
        if (grp.length < 15 && level !== 3) continue;         // <15 → fall back to parent
        const [payer, pkg, dept, los, icu] = k.split('||');
        out.push({ level, payer, pkg, dept, los, icu, blended: grp.length < 30 && level !== 3, ...summarize(grp) });
      }
      return out;
    };

    const l1 = rollup(recs, 1, (r) => `${r.payer}||${r.pkg}||${r.dept}||${r.los}||${r.icu}`);
    const l2 = rollup(recs, 2, (r) => `${r.payer}||${r.pkg}||${r.dept}||All||All`);
    const l3 = rollup(recs, 3, (r) => `${r.payer}||${r.pkg}||All||All||All`);
    const profiles = [...l1, ...l2, ...l3];

    await client.query('TRUNCATE fc.nme_profile');
    for (let i = 0; i < profiles.length; i += 300) {
      const chunk = profiles.slice(i, i + 300);
      const C = 17;
      const ph = chunk.map((_, k) => `(${Array.from({ length: C }, (_, j) => `$${k * C + j + 1}`).join(',')})`).join(',');
      await client.query(
        `INSERT INTO fc.nme_profile (cohort_level, payer_bucket, package_status, department, los_band, icu_band,
           admissions, positive_count, positive_prob, p25, p50, p75, p80, p50_incl_zero, p75_incl_zero, blended, last_seen)
         VALUES ${ph}`,
        chunk.flatMap((p) => [p.level, p.payer, p.pkg, p.dept, p.los, p.icu, p.admissions, p.positive_count,
          p.positive_prob, p.p25, p.p50, p.p75, p.p80, p.p50_incl_zero, p.p75_incl_zero, p.blended, p.last_seen]));
    }
    console.log(`[profile] nme_profile rows: ${profiles.length}  (L1=${l1.length} L2=${l2.length} L3=${l3.length})`);

    await client.query('COMMIT');

    // ---- validation / reconciliation ----
    const clean = recs;
    const posAll = clean.filter((r) => r.nme > 0).map((r) => r.nme).sort((a, b) => a - b);
    console.log('\n=== RECONCILIATION (clean matched_in_mart cohort) ===');
    console.log(`clean admissions w/ HIMS NME : ${clean.length}`);
    console.log(`positive : ${posAll.length}  zero : ${clean.filter((r) => r.nme === 0).length}`);
    console.log(`positive P25=${pct(posAll, .25)} P50=${pct(posAll, .50)} P75=${pct(posAll, .75)} P80=${pct(posAll, .80)}`);
    console.log(`manager targets (13,974 clean): pos=4212 P25=3063.75 P50=5524.50 P75=9272.73`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('[nme] FAILED:', e.message); process.exit(1); });
