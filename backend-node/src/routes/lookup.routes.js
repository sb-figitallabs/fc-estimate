import { Router } from 'express';
import { query } from '../db/pool.js';

const router = Router();

/** GET /api/lookup/organizations — payor organizations with tariff mapping */
router.get('/organizations', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT organization_cd, organization_name, tariff_cd, tariff_name, priority_type
       FROM fc.organization_tariff_mapping ORDER BY organization_name`
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
