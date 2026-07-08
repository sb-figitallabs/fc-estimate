import { Router } from 'express';
import {
  lookupPackage, resolvePackageText, packageHistory, aliasCandidates,
} from '../modules/packages/packages.service.js';

const router = Router();

/** GET /api/packages/lookup?tariff_code&package_code|package_name&organization_cd */
router.get('/lookup', async (req, res, next) => {
  try {
    const { tariff_code, package_code, package_name, organization_cd } = req.query;
    if (!tariff_code || (!package_code && !package_name)) {
      return res.status(400).json({ error: 'tariff_code and package_code|package_name required' });
    }
    const pkg = await lookupPackage({ tariff_code, package_code, package_name, organization_cd });
    if (!pkg) return res.json({ status: 'no_package_exists' });
    const history = await packageHistory({ tariff_code, package_code: pkg.package_code, organization_cd });
    res.json({ status: pkg.readiness.can_generate_estimate ? 'resolved' : 'not_ready', package: pkg, history });
  } catch (err) { next(err); }
});

/** GET /api/packages/search?tariff_code&q — alias candidates (no AI) */
router.get('/search', async (req, res, next) => {
  try {
    const { tariff_code, q, organization_cd } = req.query;
    if (!tariff_code || !q) return res.status(400).json({ error: 'tariff_code and q required' });
    res.json(await aliasCandidates({ text: q, tariff_code, organization_cd }));
  } catch (err) { next(err); }
});

/** POST /api/packages/resolve { text, tariff_code, organization_cd? } — alias + Gemini ranking */
router.post('/resolve', async (req, res, next) => {
  try {
    const { text, tariff_code, organization_cd } = req.body;
    if (!text || !tariff_code) return res.status(400).json({ error: 'text and tariff_code required' });
    res.json(await resolvePackageText({ text, tariff_code, organization_cd }));
  } catch (err) { next(err); }
});

/** GET /api/packages/history?tariff_code&package_code&organization_cd */
router.get('/history', async (req, res, next) => {
  try {
    const { tariff_code, package_code, organization_cd } = req.query;
    if (!tariff_code || !package_code) return res.status(400).json({ error: 'tariff_code and package_code required' });
    res.json(await packageHistory({ tariff_code, package_code, organization_cd }) ?? { admission_count: 0 });
  } catch (err) { next(err); }
});

export default router;
