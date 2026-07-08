import { Router } from 'express';
import {
  lookupPackage, resolvePackageText, packageHistory, aliasCandidates,
} from '../modules/packages/packages.service.js';
import { splitVariants } from '../modules/packages/coverage.js';
import { familyForPackage, listFamilies } from '../modules/engine/cohort.js';
import { query } from '../db/pool.js';

const router = Router();

/**
 * GET /api/packages/detail?tariff_code&package_code&organization_cd?
 * The FULL curated picture: runtime row (all fields + doc variants), aliases,
 * org applicability, history w/ sample admissions, and the registered-family
 * mapping ("family not yet onboarded" when null).
 */
router.get('/detail', async (req, res, next) => {
  try {
    const { tariff_code, package_code, organization_cd } = req.query;
    if (!tariff_code || !package_code) return res.status(400).json({ error: 'tariff_code and package_code required' });
    const pkg = await lookupPackage({ tariff_code, package_code, organization_cd });
    if (!pkg) return res.json({ status: 'no_package_exists' });

    const variants = splitVariants(pkg.inclusions_text);
    if (variants.length) pkg.inclusions_display = variants[0];
    if (variants.length > 1) pkg.inclusions_variants = variants;

    const [aliases, applicability, history] = await Promise.all([
      query(`SELECT alias_text, alias_type, alias_confidence, alias_source
             FROM fc.package_alias WHERE tariff_code=$1 AND package_code=$2
             ORDER BY alias_confidence DESC, alias_text LIMIT 40`, [tariff_code, package_code]),
      query(`SELECT organization_cd, organization_name, payor_bucket
             FROM fc.package_organization_applicability WHERE tariff_code=$1 AND package_code=$2
             ORDER BY organization_name NULLS FIRST LIMIT 100`, [tariff_code, package_code]),
      packageHistory({ tariff_code, package_code, organization_cd }),
    ]);
    const family = familyForPackage(pkg);
    const known = new Set(listFamilies().map((f) => f.family));
    res.json({
      status: pkg.readiness.can_generate_estimate ? 'resolved' : 'not_ready',
      package: pkg,
      aliases: aliases.rows,
      applicability: applicability.rows,
      history,
      family: family && known.has(family)
        ? { family, onboarded: true }
        : { family: null, onboarded: false, hint: 'family not yet onboarded' },
    });
  } catch (err) { next(err); }
});

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
