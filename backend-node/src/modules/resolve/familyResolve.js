import { geminiJson } from '../ai/gemini.js';
import { listFamilies, familyPayorCounts, roboticBaseOf } from '../engine/cohort.js';
import { aliasCandidates } from '../packages/packages.service.js';

/**
 * Shared treatment-matching brain (15-Jul flow doc) — used by the package
 * gate, /lookup/resolve-treatment AND the estimate build, so family and
 * package selection behave identically everywhere:
 *  - family matches are payor-aware (zero-case matches never win; robotic
 *    families with no payor history fall back to base family + robotic add-on)
 *  - package candidates are AI-ranked (word-overlap alias hits alone have no
 *    clinical sense) and dropped entirely when nothing genuinely fits.
 */

// Short-TTL result cache: the SAME wording within a session (question→answer
// round-trips, step re-evaluations) must resolve to the SAME family without
// re-asking the model — kills both mid-conversation cohort flips and most
// transient matcher flakes. Size-capped FIFO; entries expire after TTL.
const MATCH_CACHE = new Map();
const MATCH_CACHE_TTL_MS = 10 * 60 * 1000;
const MATCH_CACHE_MAX = 500;

/** geminiJson with exponential backoff — transient Vertex 429/5xx flakes
 * under concurrency should retry, not surface as "matcher unavailable". */
async function geminiJsonRetry(prompt, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await geminiJson(prompt, opts); }
    catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

/** AI family matcher — high-confidence keys from the registry, best-first. */
export async function familyMatches(text) {
  const cacheKey = String(text || '').trim().toLowerCase();
  const hit = MATCH_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < MATCH_CACHE_TTL_MS) return hit.matches;

  const families = listFamilies();
  const system = `You map a doctor's free-text treatment/surgery wording to a hospital's
known procedure families for cost estimation.

Known procedure families (use the exact key):
${families.map((f) => `- ${f.family}: ${f.label}`).join('\n')}

Return STRICT JSON: { "matches": [{ "family": "<exact key from the list>",
"confidence": "high"|"medium"|"low", "reason": "<one line why it matches>" }] }.
Return at most the top 3 matches ordered best-first; fewer if fewer plausibly fit,
and an empty array if nothing fits. Never invent family keys not in the list.`;
  const out = await geminiJsonRetry(`Doctor's wording: ${text}`, { system });
  const byKey = new Map(families.map((f) => [f.family, f]));
  const seen = new Set();
  const matches = (Array.isArray(out?.matches) ? out.matches : [])
    .filter((m) => m && byKey.has(m.family) && !seen.has(m.family) && seen.add(m.family))
    .slice(0, 3)
    .map((m) => ({
      family: m.family,
      label: byKey.get(m.family).label,
      confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'low',
      reason: typeof m.reason === 'string' ? m.reason : '',
    }));
  if (MATCH_CACHE.size >= MATCH_CACHE_MAX) MATCH_CACHE.delete(MATCH_CACHE.keys().next().value);
  MATCH_CACHE.set(cacheKey, { at: Date.now(), matches });
  return matches;
}

/**
 * Payor-aware reorder of family matches. A match with NO cases for this payor
 * group must not win over one that has them; a robotic family with no payor
 * history yields its BASE family + robotic add-on (robotic cohorts are
 * Cash-only). Returns { matches, payor_note } — matches carry payor_cases.
 */
export async function payorAwareFamilies(matches, payorBucket) {
  if (!payorBucket || !matches.length) return { matches, payor_note: null };
  let counts = null;
  try { counts = await familyPayorCounts(); } catch { /* keep the AI order */ }
  if (!counts) return { matches, payor_note: null };

  let families = matches.map((m) => ({ ...m, payor_cases: counts[m.family]?.[payorBucket] ?? 0 }));
  let payorNote = null;
  const best = families[0];
  if (best && best.payor_cases === 0) {
    const withCases = families.find((m) => m.payor_cases > 0);
    const baseKey = roboticBaseOf(best.family);
    const baseCases = baseKey ? counts[baseKey]?.[payorBucket] ?? 0 : 0;
    if (baseKey && baseCases > 0) {
      const baseLabel = listFamilies().find((f) => f.family === baseKey)?.label ?? baseKey;
      families = [
        { family: baseKey, label: baseLabel, confidence: best.confidence, payor_cases: baseCases, reason: `Base family of ${best.label} — apply the robotic add-on on top`, robotic_addon: true },
        ...families,
      ];
      payorNote = `"${best.label}" has NO ${payorBucket} history (robotic cohorts are Cash-only) — use "${baseLabel}" (${baseCases} ${payorBucket} cases) + robotic add-on`;
    } else if (withCases) {
      families = [withCases, ...families.filter((m) => m !== withCases)];
      payorNote = `"${best.label}" matched but has NO ${payorBucket} history — preferring "${withCases.label}" (${withCases.payor_cases} ${payorBucket} cases)`;
    } else {
      payorNote = `No matched family has ${payorBucket} history — falling back to the closest match across all payors`;
    }
  }
  return { matches: families, payor_note: payorNote };
}

/**
 * Alias search + AI clinical ranking for package candidates on one tariff.
 * Returns { candidates (best-first), ranking } — candidates is EMPTY when the
 * alias hits were noise (ranking.no_clinical_match = true).
 */
export async function rankPackageCandidates({ treatment, tariff_code, organization_cd, limit = 5 }) {
  let candidates = await aliasCandidates({ text: treatment, tariff_code, organization_cd, limit });
  let ranking = null;
  if (candidates.length > 1) {
    try {
      const pick = await geminiJson(
        `Raw treatment text: "${treatment}" (tariff ${tariff_code}).
Candidate hospital packages:
${candidates.map((c, i) => `${i}: [${c.package_code}] ${c.package_name}`).join('\n')}
Return JSON {"best_index": <int or null if none genuinely matches clinically>, "confidence": "high"|"medium"|"low", "reason": "..."}`,
        { system: 'You match raw treatment descriptions to hospital package catalog rows. Prefer exact clinical matches; return null when nothing genuinely fits. Never invent packages.' }
      );
      ranking = { method: 'ai', confidence: pick?.confidence ?? 'low', reason: pick?.reason ?? '' };
      if (pick?.best_index == null) {
        ranking.no_clinical_match = true;
        candidates = [];
      } else if (candidates[pick.best_index]) {
        const best = candidates[pick.best_index];
        candidates = [best, ...candidates.filter((c) => c !== best)];
      }
    } catch { ranking = { method: 'alias_score_only' }; }
  }
  return { candidates, ranking };
}
