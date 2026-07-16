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

// ——— P5: newborn context detection (problems-register-16jul P5) —————————————
// "Baby of …" newborns with generic medical-management wording were resolving
// to ADULT general_medical_management (~2× overquote vs real ₹26–36k bills;
// the human FCs were equally wrong). Measured against the mart (16-Jul):
// the newborn admissions split into cohorts that bill VERY differently —
// routine newborn care P50 ~₹15k, jaundice/phototherapy ~₹25k, NICU ~₹37k
// for short Cash stays — and generic wording cannot tell them apart (the
// dedicated sick-newborn template 'Neonatal Medical Management' has only 5
// mart cases: not minable as a family tonight). So the guard DETECTS newborn
// context and the flow asks a mandatory pathway question instead of silently
// force-fitting any one cohort. Detection fires when: patient name is
// "Baby of / Baby Boy / Baby Girl …" (NOT plain "Baby <name>") OR age ≤ 30
// days when provided, AND the wording is generic medical management. It must
// NEVER fire on: age > 30 days when provided (a 10-year-old "Master …" must
// not hit the newborn path), specific/surgical wording, NICU-explicit
// wording (nicu_intensive_care_management is its own family), or a wording
// match that is already neonatal.
// Kill switch (one flag per behavior change): P5_NEWBORN_ROUTING=off.
/** Onboarded newborn cohorts, question-option order. */
export const NEONATAL_FAMILY_KEYS = [
  'routine_newborn_care_and_vaccination',
  'neonatal_jaundice_phototherapy_management',
  'nicu_intensive_care_management',
];
const NEONATAL_FAMILIES = new Set(NEONATAL_FAMILY_KEYS);
const NEWBORN_NAME_RE = /^\s*(?:baby\s+(?:of|boy|girl)\b|b\/o\b)/i; // NOT plain "Baby <name>" — "Baby MEENAKSHI" is a named child, not a newborn record
const NICU_WORDING_RE = /\bNICU\b|NEONATAL\s+INTENSIVE/i;
const GENERIC_MEDICAL_WORDING_RE = /\b(medical\s+management|conservative\s+(management|treatment)|observation|medical\s+care|unspecified)\b/i;
const NEWBORN_MAX_AGE_DAYS = 30;

/**
 * Patient age in days, or null when unknown. `age_days` wins; `age` accepts
 * 5, "5", "5 days", "2 weeks", "3 months", "10 years" — bare numbers are
 * YEARS (hospital convention), so age 10 can never read as 10 days.
 */
export function ageInDays(patient = {}) {
  if (patient.age_days != null && Number.isFinite(Number(patient.age_days))) {
    return Number(patient.age_days);
  }
  const age = patient.age;
  if (age == null || age === '') return null;
  if (typeof age === 'number') return Number.isFinite(age) ? age * 365.25 : null;
  const m = String(age).trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(d(?:ays?)?|w(?:ee)?ks?|m(?:on(?:th)?s?)?|y(?:ea)?rs?)?\.?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'y')[0];
  return unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30.44 : n * 365.25;
}

/**
 * Newborn context detection over the AI family matches. Pure context logic —
 * no AI, no DB. Returns { newborn, evidence }: newborn=true means the flow
 * should raise its mandatory newborn-pathway question (or honor an explicit
 * family answer) instead of pricing the adult medical cohort; evidence is the
 * human-readable trigger ("patient name …" / "age N day(s)") for the trail.
 */
export function detectNewbornContext(matches, { patient = {}, wordingText = '' } = {}) {
  const none = { newborn: false, evidence: null };
  if (process.env.P5_NEWBORN_ROUTING === 'off') return none;

  const ageDays = ageInDays(patient ?? {});
  if (ageDays != null && ageDays > NEWBORN_MAX_AGE_DAYS) return none; // hard age gate
  const nameHit = NEWBORN_NAME_RE.test(String(patient?.name ?? ''));
  const isNewborn = ageDays != null ? ageDays <= NEWBORN_MAX_AGE_DAYS : nameHit;
  if (!isNewborn) return none;

  const text = String(wordingText ?? '');
  if (!GENERIC_MEDICAL_WORDING_RE.test(text)) return none; // specific/surgical wording — never fire
  if (NICU_WORDING_RE.test(text)) return none;             // NICU-explicit — its own family
  if (matches[0] && NEONATAL_FAMILIES.has(matches[0].family)) return none;
  if (!listFamilies().some((f) => NEONATAL_FAMILIES.has(f.family))) return none; // no newborn cohorts onboarded

  const evidence = ageDays != null
    ? `age ${Math.round(ageDays)} day(s)`
    : `patient name "${String(patient.name).trim()}"`;
  return { newborn: true, evidence };
}

/**
 * Alias search + AI clinical ranking for package candidates on one tariff.
 * Returns { candidates (best-first), ranking } — candidates is EMPTY when the
 * alias hits were noise (ranking.no_clinical_match = true).
 */
// Same short-TTL cache treatment as the family matcher: the SAME
// treatment+tariff must rank to the SAME package within a session — an AI
// re-rank between calls flips package ↔ non_package on the billing decision.
const RANK_CACHE = new Map();

export async function rankPackageCandidates({ treatment, tariff_code, organization_cd, limit = 5 }) {
  const rankKey = [String(treatment || '').trim().toLowerCase(), tariff_code || '', organization_cd || '', limit].join('|');
  const cached = RANK_CACHE.get(rankKey);
  if (cached && Date.now() - cached.at < MATCH_CACHE_TTL_MS) return cached.result;

  let candidates = await aliasCandidates({ text: treatment, tariff_code, organization_cd, limit });
  let ranking = null;
  if (candidates.length > 1) {
    try {
      const pick = await geminiJsonRetry(
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
  const result = { candidates, ranking };
  // don't cache the degraded no-AI path — let the next call retry the ranking
  if (!(candidates.length > 1 && ranking?.method === 'alias_score_only')) {
    if (RANK_CACHE.size >= MATCH_CACHE_MAX) RANK_CACHE.delete(RANK_CACHE.keys().next().value);
    RANK_CACHE.set(rankKey, { at: Date.now(), result });
  }
  return result;
}
