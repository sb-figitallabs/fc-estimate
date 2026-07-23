/**
 * Load GIPSA package LOS + ICU/ward allocation from the manager-supplied
 * `gipsa Pkg def Master.xlsx` into fc.package_master (TR290 rows).
 *
 * Manager 23-Jul: the workbook is authoritative for package LOS and ICU/ward
 * ALLOCATION ONLY — NOT for rates. This script writes only pkg_defined_ward_stay
 * / pkg_defined_icu_stay / los_source. It NEVER touches any rate/amount column.
 * package_duration/pre_days/post_days are refreshed only under --refresh-duration
 * (a number-changing step — shifts the LOS default — gated on purpose).
 *
 * Usage:
 *   node scripts/load-gipsa-package-los.js                 # dry-run (default): report only
 *   node scripts/load-gipsa-package-los.js --apply         # write ward/ICU split
 *   node scripts/load-gipsa-package-los.js --apply --refresh-duration   # + refresh LOS default
 *   FILE=/path/to.xlsx node scripts/load-gipsa-package-los.js
 *
 * Applies migration 004 (idempotent) first. Join key: normalized PKGCD →
 * package_code WHERE tariff_code='TR290'.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { pool } from '../src/db/pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const REFRESH_DURATION = process.argv.includes('--refresh-duration');
const FILE = process.env.FILE || path.join(process.env.HOME, 'Downloads', 'gipsa Pkg def Master.xlsx');
const TARIFF = 'TR290';
const SOURCE = 'gipsa_workbook_2025-07';

const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '').trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const hdr = ws.getRow(1).values.map((v) => (v == null ? '' : String(v)));
  const ix = (name) => hdr.indexOf(name);
  const c = { pk: ix('PKGCD'), dur: ix('PKGDURATION'), icu: ix('ICU'), ward: ix('Ward'), pre: ix('PREDAYS'), post: ix('POSTDAYS'), name: ix('PKGNAME') };
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.values;
    const code = norm(v[c.pk]);
    if (!code) return;
    rows.push({ code, name: String(v[c.name] ?? ''), duration: num(v[c.dur]), icu: num(v[c.icu]) ?? 0, ward: num(v[c.ward]) ?? 0, pre: num(v[c.pre]), post: num(v[c.post]) });
  });
  return rows;
}

async function main() {
  console.log(`GIPSA LOS loader — file=${FILE}`);
  console.log(`mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  refresh_duration=${REFRESH_DURATION}\n`);
  const rows = await readWorkbook(FILE);
  console.log(`workbook packages: ${rows.length}`);

  const client = await pool.connect();
  try {
    // migration (idempotent)
    const mig = fs.readFileSync(path.join(HERE, '../migrations/004_package_master_ward_icu_stay.sql'), 'utf8');
    await client.query(mig);
    console.log('[migrate] applied 004_package_master_ward_icu_stay.sql');

    // existing TR290 codes (normalized) + current durations for delta report
    const { rows: master } = await client.query(
      `SELECT package_code, upper(replace(package_code,' ','')) AS code, package_duration
         FROM fc.package_master WHERE tariff_code = $1`, [TARIFF]);
    const byCode = new Map(master.map((m) => [m.code, m]));

    const matched = [], unmatched = [], durationDeltas = [];
    for (const r of rows) {
      const m = byCode.get(r.code);
      if (!m) { unmatched.push(r.code); continue; }
      matched.push(r);
      if (r.duration != null && Number(m.package_duration) !== r.duration) {
        durationDeltas.push({ code: r.code, from: Number(m.package_duration), to: r.duration });
      }
    }
    console.log(`matched TR290: ${matched.length}/${rows.length}`);
    console.log(`UNMATCHED (skipped): ${unmatched.join(', ') || 'none'}`);
    console.log(`package_duration deltas if --refresh-duration: ${durationDeltas.length}` +
      (durationDeltas.length ? ` e.g. ${durationDeltas.slice(0, 6).map((d) => `${d.code} ${d.from}→${d.to}`).join(', ')}` : ''));

    if (!APPLY) { console.log('\nDRY-RUN — no writes. Re-run with --apply to write the ward/ICU split.'); return; }

    await client.query('BEGIN');
    let n = 0;
    for (const r of matched) {
      const sets = ['pkg_defined_ward_stay = $2', 'pkg_defined_icu_stay = $3', 'los_source = $4'];
      const args = [TARIFF, r.ward, r.icu, SOURCE];
      if (REFRESH_DURATION && r.duration != null) {
        sets.push(`package_duration = $${args.length + 1}`); args.push(r.duration);
        if (r.pre != null) { sets.push(`pre_days = $${args.length + 1}`); args.push(r.pre); }
        if (r.post != null) { sets.push(`post_days = $${args.length + 1}`); args.push(r.post); }
      }
      const codeArg = args.length + 1; args.push(r.code);
      const res = await client.query(
        `UPDATE fc.package_master SET ${sets.join(', ')}
           WHERE tariff_code = $1 AND upper(replace(package_code,' ','')) = $${codeArg}`, args);
      n += res.rowCount;
    }
    await client.query('COMMIT');
    console.log(`\nAPPLIED — updated ${n} package_master row(s) (ward/ICU split${REFRESH_DURATION ? ' + duration refresh' : ''}).`);
    console.log('Next: add pkg_defined_ward_stay/pkg_defined_icu_stay to the packages.service.js SELECT, then verify T10 flips to per_setting_ledger.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
