import { query } from '../../db/pool.js';

/**
 * Payor → tariff resolution (docs/04_core_logic_rules.md, docs/14_payer_basis...):
 * - Cash / General Patients / GENERAL → TR1 / KIMS
 * - otherwise resolve via fc.organization_tariff_mapping by organization_cd
 * - never silently guess another tariff on failure
 */
const CASH_LIKE = new Set(['cash', 'general', 'general patients']);

export async function resolveTariff({ payorBucket, organizationCd }) {
  const bucket = (payorBucket || '').trim().toLowerCase();
  if (CASH_LIKE.has(bucket)) {
    return { tariff_cd: 'TR1', tariff_name: 'KIMS', source: 'cash_default', warnings: [] };
  }
  if (!organizationCd) {
    return {
      tariff_cd: null, tariff_name: null, source: 'unresolved',
      warnings: [`Non-cash payor "${payorBucket}" requires organization_cd for tariff resolution`],
    };
  }
  const { rows } = await query(
    `SELECT tariff_cd, tariff_name, organization_name, priority_type
     FROM fc.organization_tariff_mapping WHERE organization_cd = $1`,
    [organizationCd]
  );
  if (!rows.length) {
    return {
      tariff_cd: null, tariff_name: null, source: 'unresolved',
      warnings: [`No tariff mapping found for organization_cd=${organizationCd}`],
    };
  }
  const m = rows[0];
  return {
    tariff_cd: m.tariff_cd, tariff_name: m.tariff_name,
    organization_name: m.organization_name, priority_type: m.priority_type,
    source: 'organization_tariff_mapping', warnings: [],
  };
}
