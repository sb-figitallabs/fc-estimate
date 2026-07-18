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

/** Word tokens sans structural noise (laterality, articles) — used by the
 * P4 guard here and by flow2's similar-package-name ladder rung. */
const WORD_STOPWORDS = new Set(['AND', 'WITH', 'THE', 'FOR', 'OF', 'LEFT', 'RIGHT', 'UNILATERAL', 'BILATERAL', 'PA', 'PB']);
export const meaningfulWords = (text) => String(text || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ')
  .split(/\s+/).filter((w) => w.length >= 2 && !WORD_STOPWORDS.has(w));

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

// ——— P4: catch-all cohort guard (problems-register-16jul P4) ————————————————
// SPECIFIC wording resolving to a department-level CATCH-ALL family at
// medium/high confidence produced −74% (BANDANADAM, ₹450k reconstruction
// priced off the generic plastic cohort), +371% (KRISHNA, arch-bar wiring →
// same cohort) and −36% (G NAGAVENI, Achilles repair → ortho catch-all).
// The distinction that prevents collateral: GENERIC wording → generic family
// is CORRECT ("MEDICAL MANAGEMENT" → general_medical_management scored GOOD)
// and must not change. The guard fires only when the TOP match is a catch-all
// AND the wording either (a) carries specific clinical tokens with ZERO
// overlap against that family's label, or (b) is the hospital's own
// unnamed-procedure wording ("OTHER MAJOR SURGERY <specialty>" — the text
// itself declares the procedure unnamed, so the catch-all adds no
// information; verified no family label carries an OTHER/UNSPECIFIED token,
// so a family's own label as wording can never trigger this).
// Effect: confidence capped at 'low' + needs_confirmation — flow2 raises its
// existing pending-question machinery, the Simple flow shows a visible
// generic-match warning on its existing confirm card. Explicit confirmation
// (selections.family / the FC's confirm click) proceeds exactly as today.
// Kill switch (one flag per behavior change): P4_CATCHALL_GUARD=off.
/**
 * The registry's department-level catch-all cohorts, derived by inspecting
 * listFamilies() labels (2026-07-16): the "General …", "… Management /
 * Procedure" and "Departmental …" templates that absorb whatever the AI
 * matcher can't place. An explicit list, NOT a label heuristic, so a new
 * family never silently becomes a catch-all. Deliberately EXCLUDED:
 *  - general_medical_management_infusion — the daycare-infusion cohort;
 *    named-drug wording landing there is P3's fix (named_drug MRP pricing) —
 *    flagging it here would stack a question onto every "INJ <drug>" case;
 *  - procedure-class cohorts whose label IS the procedure (Hernia Repair
 *    (General), Spinal Fusion & Fixation (General), General Laparoscopic
 *    Gynecological Surgery, Ophthalmology/Minor Procedure — the wording that
 *    reaches them names their own class);
 *  - the departmental *_medical_management families (nephrology/neurology/…)
 *    — medical-management wording is the generic-wording majority the
 *    register says must keep auto-resolving.
 */
export const CATCH_ALL_FAMILIES = [
  'general_medical_management',
  'general_surgical_procedure',
  'general_plastic_surgery_procedure',
  'general_obg_medical_management_observation',
  'obg_medical_management_procedure',
  'ent_medical_management_procedure',
  'orthopaedic_management_procedure',
  'orthopaedic_medical_management',
  'departmental_management_procedure',
  'paediatric_surgical_procedure',
  'surgical_oncology_procedure',
];
const CATCH_ALL_SET = new Set(CATCH_ALL_FAMILIES);
export const isCatchAllFamily = (family) => CATCH_ALL_SET.has(family);

// Generic clinical vocabulary — words that describe THAT something is done,
// not WHAT is done. Removed from the wording before the specific-token check
// so "MEDICAL MANAGEMENT" / "SURGICAL REPAIR" read as zero specific tokens.
const GENERIC_WORDING_STOPWORDS = new Set([
  'SURGERY', 'SURGERIES', 'SURGICAL', 'OPERATION', 'OPERATIVE', 'PROCEDURE', 'PROCEDURES',
  'MANAGEMENT', 'TREATMENT', 'THERAPEUTIC', 'MEDICAL', 'CONSERVATIVE', 'OBSERVATION', 'CARE',
  'GENERAL', 'MAJOR', 'MINOR', 'OTHER', 'OTHERS', 'MISC', 'MISCELLANEOUS', 'UNSPECIFIED',
  'ELECTIVE', 'REPAIR', 'DOUBLE', 'RT', 'LT', 'BL',
]);
// The hospital's own "not on the named list" wording markers (prong b).
const UNNAMED_PROCEDURE_MARKERS = new Set(['OTHER', 'OTHERS', 'UNSPECIFIED', 'MISC', 'MISCELLANEOUS']);

/** Clinically specific tokens of a wording: meaningful words minus the generic
 * clinical vocabulary and bare numbers. */
export function specificTokensOf(text) {
  return meaningfulWords(text).filter((w) => !GENERIC_WORDING_STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * P4 guard — post-step over the (payor-reordered) matches. When it fires, the
 * TOP match is returned with `{ confidence: 'low', needs_confirmation: true,
 * guard_reason, guard_capped_from }` (additive; every other match untouched).
 * Only the top match is inspected: a catch-all sitting in the alternatives is
 * already just an alternative. Families have no alias table (fc.package_alias
 * is package-keyed), so the label — which IS the template name — is the
 * overlap surface.
 */
export function applyCatchAllGuard(matches, wordingText) {
  if (process.env.P4_CATCHALL_GUARD === 'off') return matches;
  const top = matches?.[0];
  if (!top || !CATCH_ALL_SET.has(top.family)) return matches;

  const words = meaningfulWords(wordingText);
  const specific = specificTokensOf(wordingText);
  const labelTokens = new Set(meaningfulWords(top.label ?? top.family.replace(/_/g, ' ')));

  let guardReason = null;
  if (specific.length >= 1 && specific.every((t) => !labelTokens.has(t))) {
    guardReason = 'specific wording matched only a generic family';
  } else if (words.some((w) => UNNAMED_PROCEDURE_MARKERS.has(w))) {
    guardReason = 'unnamed-procedure wording ("OTHER …") matched only a generic family';
  }
  if (!guardReason) return matches;

  return [
    {
      ...top,
      ...(top.confidence !== 'low' ? { guard_capped_from: top.confidence } : {}),
      confidence: 'low',
      needs_confirmation: true,
      guard_reason: guardReason,
    },
    ...matches.slice(1),
  ];
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

/** B1 (manager 17-Jul feedback p1): deterministic match/not-a-match verdict
 * per candidate, laterality- and robotic-aware. The AI ranking still orders
 * candidates; this labels each one so the FC sees WHY an option is offered —
 * "TKR right → bilateral is NOT a match", "robotic matches because you chose
 * robotic", "revision = same surgery, commercially different". */
export function candidateVerdict(treatment, candidateName, { robotic } = {}) {
  const t = ` ${String(treatment || '').toUpperCase()} `;
  const n = ` ${String(candidateName || '').toUpperCase()} `;
  const LEFT = /\bLEFT\b/, RIGHT = /\bRIGHT\b/, BILAT = /\bBILATERAL\b|\bBOTH\b|\bB\/L\b/, UNI = /\bUNILATERAL\b/, ROBO = /\bROBOTIC\b|\bROBO\b/, REV = /\bREVISION\b/;
  const askBilateral = BILAT.test(t);
  const askOneSide = !askBilateral && (UNI.test(t) || LEFT.test(t) || RIGHT.test(t));
  const candBilateral = BILAT.test(n);
  const candOneSide = UNI.test(n) || LEFT.test(n) || RIGHT.test(n);
  if (askOneSide && candBilateral) return { verdict: 'not_a_match', reason: 'you asked one side — this is a bilateral package' };
  if (askBilateral && candOneSide && !candBilateral) return { verdict: 'not_a_match', reason: 'you asked bilateral — this is a unilateral package' };
  if (RIGHT.test(t) && LEFT.test(n) && !RIGHT.test(n)) return { verdict: 'not_a_match', reason: 'you asked right — this package is for the left side' };
  if (LEFT.test(t) && RIGHT.test(n) && !LEFT.test(n)) return { verdict: 'not_a_match', reason: 'you asked left — this package is for the right side' };
  if (ROBO.test(n)) {
    if (robotic === 'no') return { verdict: 'not_a_match', reason: 'robotic package — robotic was declined' };
    if (robotic === 'yes' && !ROBO.test(t)) return { verdict: 'match', reason: 'robotic package — matches because you chose robotic' };
    if (ROBO.test(t)) return { verdict: 'match', reason: 'matches the robotic wording' };
    return { verdict: 'match', reason: 'robotic variant of the same surgery — pick if robotic is planned' };
  }
  if (ROBO.test(t) && !ROBO.test(n)) return { verdict: 'match', reason: 'conventional variant — robotic can ride as an add-on charge' };
  if (REV.test(n) && !REV.test(t)) return { verdict: 'match', reason: 'revision variant of the same surgery — commercially different package' };
  return { verdict: 'match', reason: 'same surgery family' };
}

export async function rankPackageCandidates({ treatment, tariff_code, organization_cd, limit = 5, robotic } = {}) {
  const rankKey = [String(treatment || '').trim().toLowerCase(), tariff_code || '', organization_cd || '', limit, robotic || ''].join('|');
  const cached = RANK_CACHE.get(rankKey);
  if (cached && Date.now() - cached.at < MATCH_CACHE_TTL_MS) return cached.result;

  let candidates = await aliasCandidates({ text: treatment, tariff_code, organization_cd, limit });
  // Alias coverage is uneven per tariff (16-Jul: TR287 had TKR packages in
  // the master but zero KNEE aliases — the gate said "no package" while the
  // build's cohort-dominant code lookup found one). Fall back to a
  // master-catalog name search so the gate sees everything the build can.
  if (!candidates.length) {
    const { masterNameCandidates } = await import('../packages/packages.service.js');
    candidates = await masterNameCandidates({ text: treatment, tariff_code, organization_cd, limit });
  }
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
  // B1: verdict + reason on every candidate (laterality/robotic aware)
  for (const c of candidates) {
    const v = candidateVerdict(treatment, c.package_name, { robotic });
    c.verdict = v.verdict;
    c.verdict_reason = v.reason;
  }
  // F1 (18-Jul feedback #1): never surface the master's ₹10 placeholder as a
  // candidate price. Candidates resolve through lookupPackage, so they carry
  // real per-room amounts (Service-All matrix, jsonb, or tariff-info rescue) —
  // promote the General-room amount into a placeholder scalar.
  for (const c of candidates) {
    if (!(Number(c.package_amount) > 1000) && c.room_amounts) {
      const amt = c.room_amounts.general ?? c.room_amounts.twin ?? c.room_amounts.single;
      if (Number(amt) > 1000) {
        c.package_amount = Number(amt);
        c.package_amount_source = c.room_amounts_source ?? 'room_amounts';
      }
    }
  }
  // B3 (manager 17-Jul): a "robotic: yes" answer re-biases the gate — the
  // first ROBOTIC candidate that is a match moves to the top so the robotic
  // package is offered instead of the conventional pick. not-a-match
  // candidates never lead regardless of AI order.
  if (robotic === 'yes') {
    const idx = candidates.findIndex((c) => c.verdict === 'match' && /\bROBOT?I?C?\b|\bROBO\b/i.test(c.package_name || ''));
    if (idx > 0) candidates = [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
  }
  if (candidates[0]?.verdict === 'not_a_match') {
    const firstMatch = candidates.findIndex((c) => c.verdict === 'match');
    if (firstMatch > 0) candidates = [candidates[firstMatch], ...candidates.slice(0, firstMatch), ...candidates.slice(firstMatch + 1)];
  }
  const result = { candidates, ranking };
  // don't cache the degraded no-AI path — let the next call retry the ranking
  if (!(candidates.length > 1 && ranking?.method === 'alias_score_only')) {
    if (RANK_CACHE.size >= MATCH_CACHE_MAX) RANK_CACHE.delete(RANK_CACHE.keys().next().value);
    RANK_CACHE.set(rankKey, { at: Date.now(), result });
  }
  return result;
}
