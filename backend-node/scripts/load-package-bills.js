/**
 * load-package-bills.js — load the hospital's ACTUAL package-bill records
 * (manager call i15) into fc.package_bill_admissions / fc.package_bill_lines,
 * so that for admissions we already track in mart.main_table we know the
 * FINAL PACKAGE BILL amount + full line detail, excluding food & beverage.
 *
 * Sources (downloaded via `aws s3 cp` using the EC2 instance role):
 *   s3://hospital-os-prod/fc-data/records/bills_may_dec25.csv.gz  (~265k line rows)
 *   s3://hospital-os-prod/fc-data/records/bills_jan26.csv.gz      (~250k line rows)
 *   s3://hospital-os-prod/fc-data/records/pkg_detl.csv.gz         (12,648 admission rows)
 *
 * Data facts verified against the 2026-07-13 exports:
 *   - pkg_detl IP_NO is unique (12,648 distinct) → natural PK for admissions.
 *   - The two bill files have ZERO IP_NO overlap (1,969 + 1,727 distinct IPs);
 *     every bills IP exists in pkg_detl; all 3,696 of them are 'Package Bill'.
 *   - Bill lines: AMOUNT = RATE × QUANTITY; QUANTITY = INQUANTITY + EXQUANTITY.
 *     The BILLED portion of a line is RATE × EXQUANTITY — the package-price
 *     row itself carries EXQUANTITY=1, in-package consumption carries
 *     INQUANTITY only. Σ(RATE × EXQUANTITY) per admission reconciles with
 *     pkg_detl.PKG_GROSS_AMOUNT within 1% for ~98% of admissions.
 *   - Pharmacy-return rows carry negative RATE/AMOUNT and net out naturally.
 *
 * F&B rule: is_fnb = SERVICEGROUPCD = 'FNB' OR SERVICEGROUPDESC = 'FOOD AND
 * BEVERAGES' (the only F&B service group in both files; DIE|DIET is diet
 * CONSULTATION, a clinical service, and is NOT excluded — consistent with the
 * engine, whose FNB_KEYWORDS in src/modules/engine/artifacts.js also never
 * match "DIET CONSULTATION"). Group-based identification is used instead of
 * the engine's name-keyword scan because on THIS dataset name keywords
 * false-positive ("ADD TEARS EYE DROPS", "STEAM INHALER", "MENISCUS TEAR"),
 * while every TEA/COFFEE/JUICE/SOUP row already sits in the FNB group.
 *
 * Load semantics: TRUNCATE-and-reload, both tables in one transaction.
 * Chosen over upsert because bill LINES have no stable natural key (S_NO is a
 * per-export sequence and identical service rows legitimately repeat), and
 * the CSVs are full snapshots — a full reload is the only semantics that
 * cannot drift or double-count. Safe to re-run any time.
 *
 * How to run (maintenance runner, repo root):
 *   gh workflow run maintenance.yml --ref dev -f script=load-package-bills.js
 * Locally:
 *   node scripts/load-package-bills.js [--dry-run] [--limit N]
 *
 * Flags:
 *   --dry-run   download + parse + full stdout report, but NO DDL/DML.
 *               (mart match stats still computed via a read-only SELECT if
 *               the DB is reachable; skipped with a warning otherwise.)
 *   --limit N   parse at most N data rows per source file — smoke tests only.
 *               A non-dry-run limited load still TRUNCATEs, i.e. leaves the
 *               tables PARTIAL; a loud warning is printed.
 *
 * The stdout of a full run IS the coverage report (rows per table, detl vs
 * lines coverage, mart match %, Open/Pkg split, date ranges, top packages,
 * F&B share, line-vs-declared reconciliation).
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pool, query } from '../src/db/pool.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : null;
if (limitIdx >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('--limit expects a positive integer');
  process.exit(1);
}

const S3_PREFIX = 's3://hospital-os-prod/fc-data/records/';
const BILL_FILES = ['bills_may_dec25.csv.gz', 'bills_jan26.csv.gz'];
const DETL_FILE = 'pkg_detl.csv.gz';

const BILL_HEADER = [
  'S_NO', 'COMPANYCD', 'IP_NO', 'PATIENTNAME', 'DEPARTMENTNAME', 'DOCTORNAME',
  'SURGERY_NAME', 'PACKAGE_NAME', 'SERVICE_DEPTCD', 'SERVICEGROUPCD',
  'SERVICEGROUPDESC', 'SERVICECD', 'SERVICENAME', 'QUANTITY', 'RATE', 'AMOUNT',
  'INQUANTITY', 'EXQUANTITY', 'CREATEDT', 'DISCHARGEDT', 'BILLINQTY', 'BILLEXQTY',
];
const DETL_HEADER = [
  'S_NO', 'IP_NO', 'PATIENTNAME', 'P_TARIFFCD', 'PAYER_TYPE', 'ORGANIZATION_NAME',
  'DEPARTMENTNAME', 'DOCTORNAME', 'SURGERY_NAME', 'PACKAGE_NAME',
  'OPEN_BILL_OR_PKG_BILL', 'BILLTYPE', 'PKGIN_HIMS_OR_NOT',
  'OPEN_BILL_AMOUNT_AS_PER_TR1', 'OPEN_BILL_AMOUNT', 'PKG_GROSS_AMOUNT',
  'PKG_AMOUNT', 'INC_AMOUNT', 'DEFINED_EXC_AMOUNT', 'UNDEFINED_EXCLUDES',
  'NMEAMOUNT', 'DATE_OF_ADMISSION', 'DATE_OF_DISCHARGE', 'PATIENT_WARD_STAY',
  'PATIENT_ICU_STAY', 'PKG_DEFINED_WARD_STAY', 'PKG_DEFINED_ICU_STAY',
  'PKG_APPBILL_ST', 'SURGERYCD',
];

/* ------------------------------------------------------------------ utils */

const fail = (msg) => { console.error(`FATAL: ${msg}`); process.exit(1); };

/** '' / missing → null; anything non-numeric is a data error we surface. */
const toNum = (s, ctx) => {
  if (s === '' || s == null) return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`non-numeric value ${JSON.stringify(s)} in ${ctx}`);
  return n;
};
/** '' → null; PG parses 'YYYY-MM-DD HH:MM:SS' timestamps natively. */
const toTs = (s) => (s === '' || s == null ? null : s);

const isFnb = (groupCd, groupDesc) =>
  String(groupCd ?? '').trim().toUpperCase() === 'FNB' ||
  String(groupDesc ?? '').trim().toUpperCase() === 'FOOD AND BEVERAGES';

const pct = (num, den) => (den > 0 ? ((100 * num) / den).toFixed(1) + '%' : 'n/a');
const inr = (n) => (n == null ? 'n/a' : '₹' + Math.round(n).toLocaleString('en-IN'));

/* ------------------------------------------------- streaming CSV machinery */

/**
 * Minimal, correct state-machine CSV parser (RFC-4180 style): quoted fields,
 * embedded commas/newlines/doubled quotes; safe across chunk boundaries.
 */
class CsvParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.pendingQuote = false; // saw '"' inside quotes; next char decides
  }
  push(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (c === '"') { this.field += '"'; continue; } // escaped ""
        this.inQuotes = false; // closing quote; fall through, process c below
      }
      if (this.inQuotes) {
        if (c === '"') this.pendingQuote = true;
        else this.field += c;
        continue;
      }
      if (c === '"') { this.inQuotes = true; continue; }
      if (c === ',') { this.row.push(this.field); this.field = ''; continue; }
      if (c === '\n') { this.row.push(this.field); this.field = ''; this.#emit(); continue; }
      if (c === '\r') continue;
      this.field += c;
    }
  }
  end() {
    if (this.pendingQuote) { this.pendingQuote = false; this.inQuotes = false; }
    if (this.field !== '' || this.row.length) { this.row.push(this.field); this.#emit(); }
  }
  #emit() {
    const r = this.row;
    this.row = [];
    if (r.length === 1 && r[0] === '') return; // blank line
    this.onRow(r);
  }
}

/**
 * Stream file → gunzip (zlib stream) → CSV rows. Validates the header,
 * respects --limit (data rows), returns the number of rows delivered.
 */
async function streamCsvGz(filePath, expectedHeader, onDataRow) {
  let header = null;
  let delivered = 0;
  let stop = false;
  const parser = new CsvParser((row) => {
    if (stop) return;
    if (!header) {
      header = row.map((h) => h.trim());
      const missing = expectedHeader.filter((h) => !header.includes(h));
      if (missing.length) throw new Error(`${path.basename(filePath)}: header missing column(s) ${missing.join(', ')} — got: ${header.join(',')}`);
      return;
    }
    if (row.length !== header.length) throw new Error(`${path.basename(filePath)}: row width ${row.length} ≠ header width ${header.length}: ${row.slice(0, 5).join(',')}…`);
    if (limit != null && delivered >= limit) { stop = true; return; }
    delivered++;
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = row[i];
    onDataRow(obj);
  });
  const gunzip = zlib.createGunzip();
  gunzip.setEncoding('utf8'); // string_decoder: multibyte-safe across chunks
  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(filePath);
    src.on('error', reject);
    gunzip.on('error', reject);
    gunzip.on('data', (chunk) => {
      try { parser.push(chunk); } catch (e) { gunzip.destroy(e); }
    });
    gunzip.on('end', () => {
      try { parser.end(); resolve(); } catch (e) { reject(e); }
    });
    src.pipe(gunzip);
  });
  return delivered;
}

/* ------------------------------------------------------------ S3 download */

function downloadAll() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-bills-'));
  for (const f of [...BILL_FILES, DETL_FILE]) {
    const dest = path.join(dir, f);
    console.log(`[s3] downloading ${S3_PREFIX}${f}`);
    const res = spawnSync('aws', ['s3', 'cp', `${S3_PREFIX}${f}`, dest], {
      stdio: ['ignore', 'inherit', 'pipe'],
      encoding: 'utf8',
    });
    if (res.error && res.error.code === 'ENOENT') {
      fail('aws CLI not found. This script is meant to run on the EC2 maintenance runner, whose instance role grants read access to s3://hospital-os-prod. Install/configure the AWS CLI to run elsewhere.');
    }
    if (res.error) fail(`aws s3 cp failed to spawn: ${res.error.message}`);
    if (res.status !== 0) {
      fail(`aws s3 cp exited ${res.status} for ${f} — check that the instance role / credentials can read s3://hospital-os-prod/fc-data/records/.\n${res.stderr || ''}`);
    }
  }
  return dir;
}

/* ------------------------------------------------------------------ schema */

const DDL = `
CREATE SCHEMA IF NOT EXISTS fc;

-- One row per pkg_detl admission (IP_NO is unique in the export → natural PK).
CREATE TABLE IF NOT EXISTS fc.package_bill_admissions (
  ip_no                       text PRIMARY KEY,
  s_no                        integer,
  patient_name                text,
  p_tariff_cd                 text,
  payer_type                  text,
  organization_name           text,
  department_name             text,
  doctor_name                 text,
  surgery_name                text,
  surgery_cd                  text,
  package_name                text,
  open_bill_or_pkg_bill       text,
  bill_type                   text,
  pkg_in_hims                 text,
  open_bill_amount_as_per_tr1 numeric,
  open_bill_amount            numeric,
  pkg_gross_amount            numeric,
  pkg_amount                  numeric,
  inc_amount                  numeric,
  defined_exc_amount          numeric,
  undefined_excludes          numeric,
  nme_amount                  numeric,
  date_of_admission           timestamp,
  date_of_discharge           timestamp,
  patient_ward_stay           numeric,
  patient_icu_stay            numeric,
  pkg_defined_ward_stay       numeric,   -- empty in the 2026-07-13 export
  pkg_defined_icu_stay        numeric,   -- empty in the 2026-07-13 export
  pkg_appbill_st              text,
  -- derived from fc.package_bill_lines at load time:
  line_count                  integer NOT NULL DEFAULT 0,
  line_billed_total           numeric,   -- Σ rate×ex_qty (all lines)
  line_billed_fnb             numeric,   -- Σ rate×ex_qty (is_fnb lines)
  final_pkg_bill_excl_fnb     numeric,   -- line_billed_total − line_billed_fnb
  matched_in_mart             boolean NOT NULL DEFAULT false,
  loaded_at                   timestamptz NOT NULL DEFAULT now()
);

-- Bill line rows from the two bills files. No FK to admissions (kept
-- order-free and tolerant of partial exports); joined on ip_no.
CREATE TABLE IF NOT EXISTS fc.package_bill_lines (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_no              text NOT NULL,
  source_file        text NOT NULL,
  s_no               integer,
  company_cd         text,
  service_dept_cd    text,
  service_group_cd   text,
  service_group_desc text,
  service_cd         text,
  service_name       text,
  package_name       text,
  quantity           numeric,
  rate               numeric,
  amount             numeric,   -- rate × quantity (consumed value)
  in_qty             numeric,   -- within-package quantity
  ex_qty             numeric,   -- billed-beyond-package quantity
  bill_in_qty        numeric,
  bill_ex_qty        numeric,
  billed_amount      numeric,   -- rate × ex_qty: the actually-billed portion
  is_fnb             boolean NOT NULL DEFAULT false,
  create_dt          timestamp,
  discharge_dt       timestamp
);
CREATE INDEX IF NOT EXISTS idx_package_bill_lines_ip_no ON fc.package_bill_lines (ip_no);
`;

const ADMISSION_COLS = [
  'ip_no', 's_no', 'patient_name', 'p_tariff_cd', 'payer_type', 'organization_name',
  'department_name', 'doctor_name', 'surgery_name', 'surgery_cd', 'package_name',
  'open_bill_or_pkg_bill', 'bill_type', 'pkg_in_hims', 'open_bill_amount_as_per_tr1',
  'open_bill_amount', 'pkg_gross_amount', 'pkg_amount', 'inc_amount',
  'defined_exc_amount', 'undefined_excludes', 'nme_amount', 'date_of_admission',
  'date_of_discharge', 'patient_ward_stay', 'patient_icu_stay',
  'pkg_defined_ward_stay', 'pkg_defined_icu_stay', 'pkg_appbill_st',
  'line_count', 'line_billed_total', 'line_billed_fnb', 'final_pkg_bill_excl_fnb',
];
const LINE_COLS = [
  'ip_no', 'source_file', 's_no', 'company_cd', 'service_dept_cd',
  'service_group_cd', 'service_group_desc', 'service_cd', 'service_name',
  'package_name', 'quantity', 'rate', 'amount', 'in_qty', 'ex_qty',
  'bill_in_qty', 'bill_ex_qty', 'billed_amount', 'is_fnb', 'create_dt', 'discharge_dt',
];

/** Multi-row INSERT in parameter-limit-safe batches. */
async function batchInsert(client, table, cols, rows, batchSize = 500) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = chunk
      .map((_, ri) => '(' + cols.map((__, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')')
      .join(',');
    const params = [];
    for (const r of chunk) params.push(...r);
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params);
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`load-package-bills ${dryRun ? '(DRY RUN)' : ''}${limit != null ? ` (limit ${limit} rows/file)` : ''}`);
  if (!dryRun && limit != null) {
    console.warn('WARNING: --limit without --dry-run TRUNCATEs and loads PARTIAL data. Re-run without --limit for a full load.');
  }

  const dir = downloadAll();
  try {
    /* ---- parse bill lines (both files), aggregating per admission ---- */
    const perIp = new Map(); // ip → { lineCount, billed, fnbBilled }
    const lineRows = [];     // insert tuples, LINE_COLS order
    const lineIpSet = new Set();
    const fileStats = [];
    let totalBilled = 0, totalFnbBilled = 0, totalAmount = 0, fnbLineCount = 0;

    for (const f of BILL_FILES) {
      let n = 0, minDt = null, maxDt = null;
      await streamCsvGz(path.join(dir, f), BILL_HEADER, (r) => {
        n++;
        const ip = r.IP_NO;
        const ctx = `${f} S_NO=${r.S_NO}`;
        const rate = toNum(r.RATE, ctx) ?? 0;
        const exQty = toNum(r.EXQUANTITY, ctx) ?? 0;
        const amount = toNum(r.AMOUNT, ctx) ?? 0;
        const billed = rate * exQty;
        const fnb = isFnb(r.SERVICEGROUPCD, r.SERVICEGROUPDESC);
        lineIpSet.add(ip);
        const agg = perIp.get(ip) || { lineCount: 0, billed: 0, fnbBilled: 0 };
        agg.lineCount++;
        agg.billed += billed;
        if (fnb) { agg.fnbBilled += billed; fnbLineCount++; }
        perIp.set(ip, agg);
        totalBilled += billed;
        totalAmount += amount;
        if (fnb) totalFnbBilled += billed;
        const dt = r.CREATEDT || null;
        if (dt) { if (!minDt || dt < minDt) minDt = dt; if (!maxDt || dt > maxDt) maxDt = dt; }
        lineRows.push([
          ip, f, toNum(r.S_NO, ctx), r.COMPANYCD || null, r.SERVICE_DEPTCD || null,
          r.SERVICEGROUPCD || null, r.SERVICEGROUPDESC || null, r.SERVICECD || null,
          r.SERVICENAME || null, r.PACKAGE_NAME || null,
          toNum(r.QUANTITY, ctx), rate, amount, toNum(r.INQUANTITY, ctx), exQty,
          toNum(r.BILLINQTY, ctx), toNum(r.BILLEXQTY, ctx), billed, fnb,
          toTs(r.CREATEDT), toTs(r.DISCHARGEDT),
        ]);
      });
      fileStats.push({ file: f, rows: n, minDt, maxDt });
      console.log(`[parse] ${f}: ${n} line rows, CREATEDT ${minDt} → ${maxDt}`);
    }

    /* -------------------- parse pkg_detl admissions -------------------- */
    const admissionRows = []; // insert tuples, ADMISSION_COLS order
    const detlIpSet = new Set();
    const detlMeta = new Map(); // ip → { split, pkgGross, packageName, admDt }
    let dupDetlIps = 0, minAdm = null, maxAdm = null;
    const splitCounts = new Map();
    const pkgCounts = new Map();

    await streamCsvGz(path.join(dir, DETL_FILE), DETL_HEADER, (r) => {
      const ip = r.IP_NO;
      if (detlIpSet.has(ip)) { dupDetlIps++; return; } // keep first, count dupes
      detlIpSet.add(ip);
      const ctx = `${DETL_FILE} S_NO=${r.S_NO}`;
      const agg = perIp.get(ip);
      const billed = agg ? agg.billed : null;
      const fnbBilled = agg ? agg.fnbBilled : null;
      const split = r.OPEN_BILL_OR_PKG_BILL || '(blank)';
      splitCounts.set(split, (splitCounts.get(split) || 0) + 1);
      if (r.PACKAGE_NAME) pkgCounts.set(r.PACKAGE_NAME, (pkgCounts.get(r.PACKAGE_NAME) || 0) + 1);
      const admDt = r.DATE_OF_ADMISSION || null;
      if (admDt) { if (!minAdm || admDt < minAdm) minAdm = admDt; if (!maxAdm || admDt > maxAdm) maxAdm = admDt; }
      detlMeta.set(ip, { split, pkgGross: toNum(r.PKG_GROSS_AMOUNT, ctx) });
      admissionRows.push([
        ip, toNum(r.S_NO, ctx), r.PATIENTNAME || null, r.P_TARIFFCD || null,
        r.PAYER_TYPE || null, r.ORGANIZATION_NAME || null, r.DEPARTMENTNAME || null,
        r.DOCTORNAME || null, r.SURGERY_NAME || null, r.SURGERYCD || null,
        r.PACKAGE_NAME || null, r.OPEN_BILL_OR_PKG_BILL || null, r.BILLTYPE || null,
        r.PKGIN_HIMS_OR_NOT || null, toNum(r.OPEN_BILL_AMOUNT_AS_PER_TR1, ctx),
        toNum(r.OPEN_BILL_AMOUNT, ctx), toNum(r.PKG_GROSS_AMOUNT, ctx),
        toNum(r.PKG_AMOUNT, ctx), toNum(r.INC_AMOUNT, ctx),
        toNum(r.DEFINED_EXC_AMOUNT, ctx), toNum(r.UNDEFINED_EXCLUDES, ctx),
        toNum(r.NMEAMOUNT, ctx), toTs(r.DATE_OF_ADMISSION), toTs(r.DATE_OF_DISCHARGE),
        toNum(r.PATIENT_WARD_STAY, ctx), toNum(r.PATIENT_ICU_STAY, ctx),
        toNum(r.PKG_DEFINED_WARD_STAY, ctx), toNum(r.PKG_DEFINED_ICU_STAY, ctx),
        r.PKG_APPBILL_ST || null,
        agg ? agg.lineCount : 0, billed,
        fnbBilled, billed == null ? null : billed - (fnbBilled ?? 0),
      ]);
    });
    console.log(`[parse] ${DETL_FILE}: ${admissionRows.length} admissions (${dupDetlIps} duplicate IP_NO rows skipped)`);

    /* ----------------------- reconciliation stats ---------------------- */
    const recon = { n: 0, w01: 0, w1: 0, w5: 0, worse: 0, noGross: 0 };
    for (const [ip, agg] of perIp) {
      const meta = detlMeta.get(ip);
      if (!meta) continue;
      recon.n++;
      const gross = meta.pkgGross;
      if (!gross || gross <= 0) { recon.noGross++; continue; }
      const rel = Math.abs(agg.billed - gross) / gross;
      if (rel <= 0.001) recon.w01++;
      else if (rel <= 0.01) recon.w1++;
      else if (rel <= 0.05) recon.w5++;
      else recon.worse++;
    }

    /* --------------------------- database work ------------------------- */
    let matchedCount = null;
    if (dryRun) {
      console.log('[db] DRY RUN — no DDL/DML. Checking mart match read-only…');
      try {
        const { rows } = await query(
          'SELECT count(DISTINCT admission_no)::int AS n FROM mart.main_table WHERE admission_no = ANY($1)',
          [[...detlIpSet]]
        );
        matchedCount = rows[0].n;
      } catch (e) {
        console.warn(`[db] mart match check skipped (DB unreachable?): ${e.message}`);
      }
    } else {
      const client = await pool.connect();
      try {
        await client.query(DDL);
        await client.query('BEGIN');
        await client.query('TRUNCATE fc.package_bill_lines, fc.package_bill_admissions');
        await batchInsert(client, 'fc.package_bill_admissions', ADMISSION_COLS, admissionRows);
        console.log(`[db] inserted ${admissionRows.length} rows into fc.package_bill_admissions`);
        await batchInsert(client, 'fc.package_bill_lines', LINE_COLS, lineRows);
        console.log(`[db] inserted ${lineRows.length} rows into fc.package_bill_lines`);
        const upd = await client.query(
          `UPDATE fc.package_bill_admissions a
              SET matched_in_mart = true
             FROM mart.main_table m
            WHERE m.admission_no = a.ip_no`
        );
        matchedCount = upd.rowCount;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    /* ------------------------------ report ----------------------------- */
    const nDetl = detlIpSet.size;
    const nLineIps = lineIpSet.size;
    const lineIpsNotInDetl = [...lineIpSet].filter((ip) => !detlIpSet.has(ip)).length;
    console.log('\n================ COVERAGE REPORT ================');
    console.log(`Rows loaded: admissions=${admissionRows.length}, lines=${lineRows.length}${dryRun ? ' (dry-run: not written)' : ''}`);
    console.log(`Admissions in pkg_detl: ${nDetl}; distinct IP_NO in bill lines: ${nLineIps}`);
    console.log(`  with line detail: ${nLineIps - lineIpsNotInDetl}/${nDetl} (${pct(nLineIps - lineIpsNotInDetl, nDetl)}); bill-line IPs missing from pkg_detl: ${lineIpsNotInDetl}`);
    if (matchedCount != null) {
      console.log(`Matched in mart.main_table (admission_no): ${matchedCount}/${nDetl} (${pct(matchedCount, nDetl)}); unmatched: ${nDetl - matchedCount} (${pct(nDetl - matchedCount, nDetl)})`);
    } else {
      console.log('Matched in mart.main_table: (not checked — DB unavailable)');
    }
    console.log(`Open vs Pkg bill split: ${[...splitCounts.entries()].map(([k, v]) => `${k}=${v} (${pct(v, nDetl)})`).join(', ')}`);
    console.log(`Date ranges: admissions ${minAdm} → ${maxAdm}`);
    for (const s of fileStats) console.log(`  ${s.file}: ${s.rows} rows, CREATEDT ${s.minDt} → ${s.maxDt}`);
    console.log('Top-10 packages by admissions:');
    [...pkgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([name, n], i) => console.log(`  ${String(i + 1).padStart(2)}. ${name} — ${n}`));
    console.log(`F&B: ${fnbLineCount} lines; billed ${inr(totalFnbBilled)} of ${inr(totalBilled)} billed total (${pct(totalFnbBilled, totalBilled)}); line AMOUNT (consumed) total ${inr(totalAmount)}`);
    console.log(`Reconciliation (Σ rate×ex_qty per admission vs pkg_detl.PKG_GROSS_AMOUNT), n=${recon.n}:`);
    console.log(`  within 0.1%: ${recon.w01} (${pct(recon.w01, recon.n)}); within 1%: ${recon.w01 + recon.w1} (${pct(recon.w01 + recon.w1, recon.n)}); within 5%: ${recon.w01 + recon.w1 + recon.w5} (${pct(recon.w01 + recon.w1 + recon.w5, recon.n)}); worse: ${recon.worse}; no/zero declared gross: ${recon.noGross}`);
    console.log('=================================================\n');
    console.log(dryRun ? 'Dry run complete — nothing written.' : 'Load complete.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('FATAL:', e);
    pool.end().finally(() => process.exit(1));
  });
