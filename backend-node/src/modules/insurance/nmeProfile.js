import { pool } from '../../db/pool.js';

/**
 * Expected patient-borne Non-Medical Expense (NME) for an insurance estimate,
 * from the historical HIMS-NME cohort profiles (fc.nme_profile, built by
 * scripts/backfill-nme.js from Estimate-Variance-Report HIMS NME).
 *
 * ADVISORY ONLY. This surfaces a separate patient-payable line — "typical NME
 * when it occurs (P50), and how often comparable cases incur it (positive_prob)".
 * It is NEVER folded into the settled insurer/patient split (guide: don't mix
 * expected hospital bill with expected patient-payable). Cash is excluded
 * (guide §7: keep Cash out of the insurance NME model).
 *
 * Walks the specificity ladder and returns the most specific cohort available:
 *   L1  payer + package + department + LOS band + ICU band
 *   L2  payer + package + department
 *   L3  payer + package                    (global fallback, always present)
 */
const losBand = (d) => (d <= 2 ? '0-2' : d <= 5 ? '3-5' : d <= 10 ? '6-10' : '11+');
const icuBand = (d) => (d <= 0 ? '0' : d <= 2 ? '1-2' : '3+');
const n = (v) => (v == null ? null : Number(v));

/**
 * @param {object} p
 * @param {string} p.payer_bucket    Cash | GIPSA Insurance | Non-GIPSA Insurance | Corporate
 * @param {string} p.package_status  'Open Bill' | 'Package Bill'
 * @param {string} [p.department]    clinical.department_name (case-insensitive)
 * @param {number} [p.los_days]      total length of stay (days)
 * @param {number} [p.icu_days]      ICU days
 * @returns {Promise<null | {expected_nme:number|null, positive_prob:number|null,
 *   p50:number|null, p75:number|null, p80:number|null, cohort_level:number,
 *   sample:number, blended:boolean, basis:string}>}
 */
export async function lookupExpectedNme({ payer_bucket, package_status, department, los_days = 0, icu_days = 0 }) {
  if (!payer_bucket || payer_bucket === 'Cash') return null;
  const dept = String(department ?? '').trim().toUpperCase();
  const lb = losBand(Number(los_days) || 0);
  const ib = icuBand(Number(icu_days) || 0);
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cohort_level, positive_prob, p50, p75, p80, admissions, blended
         FROM fc.nme_profile
        WHERE payer_bucket = $1 AND package_status = $2
          AND ( (cohort_level = 1 AND upper(department) = $3 AND los_band = $4 AND icu_band = $5)
             OR (cohort_level = 2 AND upper(department) = $3)
             OR (cohort_level = 3) )
        ORDER BY cohort_level ASC
        LIMIT 1`,
      [payer_bucket, package_status, dept, lb, ib]));
  } catch {
    return null; // profiles not built / table absent → no advisory, never break the estimate
  }
  if (!rows.length) return null;
  const r = rows[0];
  const level = r.cohort_level;
  const scope = level === 1 ? `${dept} · LOS ${lb} · ICU ${ib}` : level === 2 ? dept : 'all departments';
  return {
    expected_nme: n(r.p50),                 // typical NME when it occurs (P50)
    positive_prob: n(r.positive_prob),      // share of comparable cases that incur any NME
    p50: n(r.p50), p75: n(r.p75), p80: n(r.p80),
    cohort_level: level, sample: r.admissions, blended: r.blended,
    basis: `HIMS NME history · ${payer_bucket} · ${package_status} · ${scope} (n=${r.admissions})`,
  };
}
