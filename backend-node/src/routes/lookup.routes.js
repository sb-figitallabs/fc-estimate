import { Router } from 'express';
import { query } from '../db/pool.js';
import { listFamilies, getCohort } from '../modules/engine/cohort.js';
import { fetchCohortRows, basisCohorts, buildBasisSummary } from '../modules/engine/artifacts.js';
import { payorBucketCounts, resolveBasis } from '../modules/resolve/payerBasis.js';

const router = Router();

/** GET /api/lookup/families — clinical families (drives the UI dropdown; daycare ⇒ no room selection) */
router.get('/families', (_req, res) => res.json(listFamilies()));

/**
 * GET /api/lookup/stay-stats?procedure=&payor_bucket=
 * Lightweight cohort stay stats (LOS / ward / ICU day quartiles) for the
 * resolved payer basis — lets the UI show the typical stay before a full build.
 */
router.get('/stay-stats', async (req, res, next) => {
  try {
    const procedure = String(req.query.procedure || '');
    const payorBucket = String(req.query.payor_bucket || 'Cash');
    const def = await getCohort(procedure); // throws 400 for unknown family
    const rows = await fetchCohortRows(def.whereSql, def.params);
    if (!rows.length) return res.json({ procedure, basis: null, case_count: 0 });
    const cohorts = basisCohorts(rows);
    const counts = await payorBucketCounts(def.whereSql, def.params);
    const { selected_basis: basis } = resolveBasis(payorBucket, counts, def.familyKind);
    const b = buildBasisSummary(cohorts).find((r) => r.basis_label === basis);
    res.json({
      procedure, basis, case_count: (cohorts[basis] ?? []).length,
      los: { p25: b?.los_p25, p50: b?.los_p50, p75: b?.los_p75 },
      ward: { p25: b?.ward_p25, p50: b?.ward_p50, p75: b?.ward_p75 },
      icu: { p25: b?.icu_p25, p50: b?.icu_p50, p75: b?.icu_p75 },
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/lookup/organizations — payor organizations with tariff mapping,
 * enriched with the payor bucket(s) each org was historically billed under
 * (admission counts) and how many packages apply to it. The UI uses `buckets`
 * to show only the insurers that belong to the selected payor bucket.
 */
router.get('/organizations', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.organization_cd, m.organization_name, m.tariff_cd, m.tariff_name, m.priority_type,
              COALESCE(h.buckets, '{}'::jsonb) AS buckets,
              COALESCE(p.packages, 0)::int AS packages,
              COALESCE(p.packages_priced, 0)::int AS packages_priced
       FROM fc.organization_tariff_mapping m
       LEFT JOIN (
         SELECT organization_cd, jsonb_object_agg(payor_bucket, n) AS buckets
         FROM (SELECT organization_cd, payor_bucket, count(*) AS n
               FROM mart.main_table WHERE organization_cd <> '' GROUP BY 1, 2) t
         GROUP BY organization_cd
       ) h USING (organization_cd)
       LEFT JOIN (
         SELECT a.organization_cd, count(*) AS packages,
                count(*) FILTER (WHERE pm.can_generate_estimate AND pm.package_amount > 1000) AS packages_priced
         FROM fc.package_organization_applicability a
         JOIN fc.package_master pm
           ON pm.tariff_code = a.tariff_code AND pm.package_code = a.package_code
         WHERE a.organization_cd <> ''
         GROUP BY a.organization_cd
       ) p USING (organization_cd)
       ORDER BY m.organization_name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/service-items?q= — search canonical service items */
router.get('/service-items', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await query(
      `SELECT canonical_item_key, item_code, item_name, fc_estimate_bucket, grouping,
              billing_head, sub_head, room_category_dependent
       FROM fc.service_item_mapping
       WHERE item_name ILIKE $1 OR item_code ILIKE $1 OR canonical_item_key ILIKE $1
       ORDER BY item_name LIMIT 50`, [q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/pharmacy-items?q= — search canonical pharmacy items */
router.get('/pharmacy-items', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await query(
      `SELECT m.canonical_item_key, m.item_code, m.item_name, m.classification,
              m.fc_estimate_bucket, m.grouping, r.mrp, r.sale_rate
       FROM fc.pharmacy_item_mapping m
       LEFT JOIN fc.pharmacy_catalog_rate_reference r USING (canonical_item_key)
       WHERE m.item_name ILIKE $1 OR m.item_code ILIKE $1
       ORDER BY m.item_name LIMIT 50`, [q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lookup/doctors?q=&tariff_name= — consultation doctors */
router.get('/doctors', async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const tariff = req.query.tariff_name || 'KIMS';
    const { rows } = await query(
      `SELECT DISTINCT doctor_cd, doctor_name
       FROM fc.consultation_tariff_rate_matrix
       WHERE tariff_name = $2 AND (doctor_name ILIKE $1 OR doctor_cd ILIKE $1)
       ORDER BY doctor_name LIMIT 50`, [q, tariff]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
