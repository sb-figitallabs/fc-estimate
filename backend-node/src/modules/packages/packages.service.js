import { query } from '../../db/pool.js';
import { geminiJson } from '../ai/gemini.js';

/**
 * Package add-on (developer_handoff_fc_package_addon, manager note i4.md).
 * Rules enforced here:
 *  - lookup priority: tariff+package_code → tariff+package_name → alias
 *  - no match ⇒ status 'no_package_exists' — never a silent best guess
 *  - documentation comes ONLY from curated package fields
 *  - fc.v_package_case_history is supporting evidence, never fabrication material
 */

const RUNTIME_COLS = `
  organization_cd, organization_name, tariff_code, tariff_name,
  package_code, package_name, canonical_package_name, package_type,
  department_name, package_amount, package_atl_amount,
  pre_days, post_days, package_duration, is_active, payor_bucket,
  documentation_available, documentation_status, documentation_confidence,
  tariff_information, inclusions_text, exclusions_text, documentation_notes,
  matched_room_category, room_rates_jsonb,
  runtime_status, can_generate_estimate, primary_blocker, warning_reason,
  fc_template_package_code, fc_template_primary_package_name, fc_case_count_total`;

/** Org filter: insurance rows carry organization_cd; cash rows have it blank. */
const orgClause = (org, i) => (org
  ? `organization_cd = $${i}`
  : `(organization_cd IS NULL OR organization_cd = '')`);

function shape(row) {
  if (!row) return null;
  const {
    runtime_status, can_generate_estimate, primary_blocker, warning_reason, ...pkg
  } = row;
  return {
    ...pkg,
    readiness: {
      runtime_status,
      can_generate_estimate,
      primary_blocker: (primary_blocker && primary_blocker !== 'None') ? primary_blocker : null,
      warning_reason: (warning_reason && warning_reason !== 'None') ? warning_reason : null,
    },
  };
}

/**
 * Additive patient-facing rewrite columns. They live on fc.package_master
 * (base table of the runtime view; populated by scripts/rewrite-inclusions.js)
 * and are fetched separately + defensively so lookups keep working before the
 * columns are bootstrapped. Originals stay untouched as the audit copy.
 */
async function withCleanTexts(pkg) {
  if (!pkg) return pkg;
  try {
    const { rows } = await query(
      `SELECT inclusions_text_clean, exclusions_text_clean
       FROM fc.package_master WHERE tariff_code = $1 AND package_code = $2`,
      [pkg.tariff_code, pkg.package_code]);
    if (rows[0]) {
      pkg.inclusions_text_clean = rows[0].inclusions_text_clean;
      pkg.exclusions_text_clean = rows[0].exclusions_text_clean;
    }
  } catch { /* columns not bootstrapped yet — additive fields, omit */ }
  return pkg;
}

/** Direct lookup by code, then exact name. Returns runtime row or null. */
export async function lookupPackage({ tariff_code, package_code, package_name, organization_cd }) {
  if (!tariff_code) return null;
  if (package_code) {
    const params = [tariff_code, package_code, ...(organization_cd ? [organization_cd] : [])];
    const { rows } = await query(
      `SELECT ${RUNTIME_COLS} FROM fc.v_package_runtime_lookup
       WHERE tariff_code = $1 AND package_code = $2 AND ${orgClause(organization_cd, 3)}
       LIMIT 1`, params);
    if (rows[0]) return withCleanTexts(shape(rows[0]));
  }
  if (package_name) {
    const params = [tariff_code, package_name, ...(organization_cd ? [organization_cd] : [])];
    const { rows } = await query(
      `SELECT ${RUNTIME_COLS} FROM fc.v_package_runtime_lookup
       WHERE tariff_code = $1 AND upper(package_name) = upper($2) AND ${orgClause(organization_cd, 3)}
       LIMIT 1`, params);
    if (rows[0]) return withCleanTexts(shape(rows[0]));
  }
  return null;
}

/** Alias search: normalized word-AND over fc.package_alias, mapped to runtime rows. */
export async function aliasCandidates({ text, tariff_code, organization_cd, limit = 8 }) {
  const words = (text || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || !tariff_code) return [];
  // scored OR-match: rank aliases by how many query words they contain
  const score = words.map((_, i) => `(normalized_alias_text LIKE $${i + 2})::int`).join(' + ');
  const params = [tariff_code, ...words.map((w) => `%${w}%`)];
  const { rows } = await query(
    `SELECT package_code, package_name, alias_text, alias_confidence, MAX(${score}) AS score
     FROM fc.package_alias WHERE tariff_code = $1
     GROUP BY 1, 2, 3, 4
     HAVING MAX(${score}) >= 1
     ORDER BY score DESC, alias_confidence DESC
     LIMIT ${limit * 3}`, params);
  // resolve each distinct package_code to its runtime row
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.package_code)) continue;
    seen.add(r.package_code);
    const pkg = await lookupPackage({ tariff_code, package_code: r.package_code, organization_cd });
    if (pkg) out.push({ ...pkg, matched_alias: r.alias_text, alias_confidence: r.alias_confidence });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Free-text resolution: alias candidates; Gemini ranks when ambiguous.
 * AI never invents — result must be one of the DB candidates or null.
 */
export async function resolvePackageText({ text, tariff_code, organization_cd }) {
  const candidates = await aliasCandidates({ text, tariff_code, organization_cd });
  if (!candidates.length) return { status: 'no_package_exists', resolved: null, candidates: [] };
  if (candidates.length === 1) return { status: 'resolved', resolved: candidates[0], candidates, method: 'single_alias_match' };
  const pick = await geminiJson(
    `Raw treatment text: "${text}" (tariff ${tariff_code}).
Candidate hospital packages:
${candidates.map((c, i) => `${i}: [${c.package_code}] ${c.package_name} — ₹${c.package_amount}`).join('\n')}
Return JSON {"best_index": <int or null if none genuinely matches>, "confidence": "high"|"medium"|"low", "reason": "..."}`,
    { system: 'You match raw treatment descriptions to hospital package catalog rows. Prefer exact clinical matches; return null when nothing genuinely fits. Never invent packages.' }
  );
  const resolved = pick.best_index != null ? candidates[pick.best_index] ?? null : null;
  return {
    status: resolved ? 'resolved' : 'no_package_exists',
    resolved, candidates, method: 'gemini_ranked', ai: pick,
  };
}

/** Historical usage (evidence only) from fc.v_package_case_history. */
export async function packageHistory({ tariff_code, package_code, organization_cd }) {
  const params = [tariff_code, package_code, ...(organization_cd ? [organization_cd] : [])];
  const { rows } = await query(
    `SELECT admission_count, latest_admission_at,
            min_observed_package_amount, max_observed_package_amount, sample_admissions_jsonb
     FROM fc.v_package_case_history
     WHERE tariff_code = $1 AND package_code = $2 AND ${orgClause(organization_cd, 3)}
     LIMIT 1`, params);
  return rows[0] ?? null;
}

/**
 * Side-by-side offer for an estimate: resolve the package for this cohort +
 * payor context. Candidate order: explicit input → cohort-dominant package.
 */
export async function packageOfferForEstimate({ cohortRows, tariff_cd, organization_cd, inputPackage }) {
  // 1. explicit input wins
  if (inputPackage?.package_code || inputPackage?.package_name) {
    const pkg = await lookupPackage({
      tariff_code: tariff_cd, organization_cd,
      package_code: inputPackage.package_code, package_name: inputPackage.package_name,
    });
    return await finishOffer(pkg, tariff_cd, organization_cd, 'input');
  }
  if (inputPackage?.text) {
    const r = await resolvePackageText({ text: inputPackage.text, tariff_code: tariff_cd, organization_cd });
    return await finishOffer(r.resolved, tariff_cd, organization_cd, 'input_text', r.candidates);
  }
  // 2. cohort-dominant package (most frequent package_code+name among the historical cases)
  const freq = new Map();
  for (const r of cohortRows) {
    if (!r.package_code) continue;
    const key = `${r.package_code}|${r.package_name ?? ''}`;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return { status: 'no_package_exists', source: 'cohort', package: null };
  const [code, name] = top[0].split('|');
  const pkg = await lookupPackage({ tariff_code: tariff_cd, organization_cd, package_code: code, package_name: name });
  return await finishOffer(pkg, tariff_cd, organization_cd, 'cohort_dominant');
}

async function finishOffer(pkg, tariff_code, organization_cd, source, candidates) {
  if (!pkg) return { status: 'no_package_exists', source, package: null, ...(candidates ? { candidates } : {}) };
  const history = await packageHistory({ tariff_code, package_code: pkg.package_code, organization_cd });
  return {
    status: pkg.readiness.can_generate_estimate ? 'resolved' : 'not_ready',
    source,
    package: pkg,
    history,
    ...(candidates ? { candidates } : {}),
  };
}
