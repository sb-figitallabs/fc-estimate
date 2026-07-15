/**
 * Read helpers over the persisted robotic classification tables
 * (todo-15jul #28; populated by scripts/backfill-robotic-classification.js,
 * DDL in migrations/001_robotic_classification.sql).
 *
 * Pure reads — safe for the estimate engine, the resolver and the UI to adopt
 * without recomputing presence from mart at request time. All helpers
 * fail-open (return null / []) when the tables have not been backfilled yet,
 * mirroring the packages.service.js billedActualsForPackage pattern.
 */
import { query } from '../../db/pool.js';

/** mart payor_bucket → persisted payor_group (anything else falls to overall). */
export function payorGroupOf(payorBucket) {
  return ['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance'].includes(payorBucket)
    ? payorBucket
    : 'All Payers';
}

/**
 * Family classification across all payor groups.
 * @returns rows of fc.robotic_family_classification (or [] pre-backfill).
 */
export async function familyRobotic(family) {
  try {
    const { rows } = await query(
      `SELECT * FROM fc.robotic_family_classification WHERE family = $1 ORDER BY payor_group`,
      [family]
    );
    return rows;
  } catch { return []; }
}

/**
 * Family classification for ONE payor context — the row the engine/UI should
 * check (#25 robotic visibility, #27 add-on pricing default). Falls back to
 * the 'All Payers' row when the bucket has no persisted row.
 */
export async function familyRoboticFor(family, payorBucket) {
  try {
    const { rows } = await query(
      `SELECT * FROM fc.robotic_family_classification
       WHERE family = $1 AND payor_group = ANY($2::text[])
       ORDER BY (payor_group = 'All Payers')  -- specific group first
       LIMIT 1`,
      [family, [payorGroupOf(payorBucket), 'All Payers']]
    );
    return rows[0] ?? null;
  } catch { return null; }
}

/** Package classification for one (tariff_code, package_code). */
export async function packageRobotic(tariffCode, packageCode) {
  try {
    const { rows } = await query(
      `SELECT * FROM fc.robotic_package_classification
       WHERE tariff_code = $1 AND package_code = $2 LIMIT 1`,
      [tariffCode, packageCode]
    );
    return rows[0] ?? null;
  } catch { return null; }
}

/**
 * Contracted robotic line items for a tariff (e.g. TR290 'CHARGES FOR ROBOTIC
 * TKR' ≈ ₹1,20,000) — where the #27 add-on charge should price from.
 */
export async function tariffRoboticAddons(tariffCd) {
  try {
    const { rows } = await query(
      `SELECT * FROM fc.robotic_tariff_addon_rate
       WHERE tariff_cd = $1 ORDER BY charge_max DESC NULLS LAST`,
      [tariffCd]
    );
    return rows;
  } catch { return []; }
}

/** Admission-level classification: was robotic actually billed on this IP. */
export async function admissionRobotic(ipNo) {
  try {
    const { rows } = await query(
      `SELECT * FROM fc.robotic_admission_classification WHERE ip_no = $1 LIMIT 1`,
      [ipNo]
    );
    return rows[0] ?? null;
  } catch { return null; }
}
