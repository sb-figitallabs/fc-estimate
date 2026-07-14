// Alias enrichment (admission-notes test, 14-Jul): the word-overlap alias
// search missed common abbreviations and spelling variants. Two passes:
//  1. curated variants → attached to every package whose name matches
//  2. billed package names (package_bill_admissions) that match a master
//     package on the same tariff but have no alias row — backfilled
// Idempotent: WHERE NOT EXISTS on (tariff_code, package_code, normalized text).
import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function addAlias(tariff, code, name, aliasText, source, confidence, note) {
  const { rowCount } = await c.query(
    `INSERT INTO fc.package_alias
       (tariff_code, package_code, package_name, alias_text, alias_type, alias_source, alias_confidence, normalized_alias_text, notes)
     SELECT $1, $2, $3, $4, 'name', $5, $6, $7, $8
     WHERE NOT EXISTS (
       SELECT 1 FROM fc.package_alias
       WHERE tariff_code = $1 AND package_code = $2 AND normalized_alias_text = $7)
     ON CONFLICT (tariff_code, package_code, alias_text, alias_type) DO NOTHING`,
    [tariff, code, name, aliasText, source, confidence, norm(aliasText), note]
  );
  return rowCount;
}

// ── pass 1: curated abbreviation/spelling variants ──────────────────────────
const CURATED = [
  { like: '%APPENDECTOMY%', aliases: ['LAP APPENDICECTOMY', 'APPENDICECTOMY', 'EMERGENCY LAP APPENDICECTOMY', 'LAP APPENDECTOMY', 'APPENDIX SURGERY'] },
  { like: '%INGUINAL%HERNIA%', aliases: ['LAP TEP', 'TEP', 'TAPP', 'ROBOTIC TAPP', 'LAP TEP HERNIA REPAIR', 'TEP HERNIOPLASTY', 'TAPP HERNIOPLASTY'] },
  { like: '%HERNIA%INGUINAL%', aliases: ['LAP TEP', 'TEP', 'TAPP', 'ROBOTIC TAPP'] },
  { like: '%(TKR)%BILATERAL%', aliases: ['B/L TKR', 'BL TKR', 'BILATERAL TKR', 'B/L RA TKR', 'RA TKR BILATERAL'] },
  { like: '%KNEE REPLACEMENT%BILATERAL%', aliases: ['B/L TKR', 'BL TKR', 'BILATERAL TKR'] },
  { like: '%DILATATION%CURETTAGE%', aliases: ['HYS D&C', 'D&C', 'DNC', 'HYSTEROSCOPY D&C', 'HYS DC'] },
  { like: '%D&C%', aliases: ['HYS D&C', 'DNC', 'HYSTEROSCOPY D&C'] },
  { like: '%OVARIAN CYSTECTOMY%', aliases: ['LAP OVARIAN CYSTECTOMY', 'LAPAROSCOPIC OVARIAN CYSTECTOMY', 'OVARIAN CYST REMOVAL'] },
  { like: 'LSCS%', aliases: ['CAESAREAN', 'CESAREAN', 'C SECTION', 'C-SECTION', 'NVD / LSCS'] },
];

let curatedAdded = 0;
for (const { like, aliases } of CURATED) {
  const { rows: pkgs } = await c.query(
    `SELECT DISTINCT tariff_code, package_code, package_name FROM fc.package_master
     WHERE package_name ILIKE $1 AND package_name NOT ILIKE '%REMOVAL%'`,
    [like]
  );
  for (const p of pkgs) {
    for (const a of aliases) {
      curatedAdded += await addAlias(p.tariff_code, p.package_code, p.package_name, a,
        'Curated Enrichment 14-Jul', 'High', `Abbreviation/spelling variant for ${like}`);
    }
  }
}
console.log('pass 1 — curated variants inserted:', curatedAdded);

// ── pass 2: billed package names missing from the alias table ───────────────
const { rows: billed } = await c.query(`
  SELECT DISTINCT b.p_tariff_cd AS tariff_code, pm.package_code, pm.package_name, b.package_name AS billed_name
  FROM (SELECT DISTINCT p_tariff_cd, package_name FROM fc.package_bill_admissions WHERE package_name IS NOT NULL) b
  JOIN fc.package_master pm
    ON upper(btrim(pm.tariff_code)) = upper(btrim(b.p_tariff_cd))
   AND upper(btrim(pm.package_name)) = upper(btrim(b.package_name))
  LIMIT 2000`);
let backfilled = 0;
for (const r of billed) {
  backfilled += await addAlias(r.tariff_code, r.package_code, r.package_name, r.billed_name,
    'Billed-name backfill 14-Jul', 'Exact', 'Name observed on actual package bills');
}
console.log('pass 2 — billed-name backfills inserted:', backfilled);

const { rows: [{ n }] } = await c.query(`SELECT count(*)::int n FROM fc.package_alias`);
console.log('fc.package_alias total rows now:', n);
await c.end();
