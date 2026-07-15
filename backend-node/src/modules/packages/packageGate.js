import { query } from '../../db/pool.js';
import { geminiJson } from '../ai/gemini.js';
import { resolveTariff } from '../resolve/payorTariff.js';
import { aliasCandidates, deriveRoomAmounts } from './packages.service.js';
import { listFamilies, familyPayorCounts, roboticBaseOf } from '../engine/cohort.js';

/**
 * Intake package-gate (manager, 14-Jul evening call): BEFORE any estimate,
 * classify what we actually have for "treatment + payor" and expose every
 * step of the decision so it can be audited even when data is missing.
 *
 * Chain: payor → tariff → package exists in the master? → details usable
 * (price above the ₹10 TR1 placeholders, inclusions present)? → FC history
 * (catalog mapping + actual billed package cases)? → route.
 */

/** TR1 carries ₹10/₹0 placeholder package prices — below this is not a price. */
const PLACEHOLDER_PRICE_MAX = 1000;

/** A package with at least this many billed cases counts as real history. */
const HISTORY_MIN_CASES = 3;

function step(key, title, status, summary, detail) {
  return { key, title, status, summary, ...(detail ? { detail } : null) };
}

/**
 * Room prices often live only in the tariff_information markdown table
 * ("| GENERAL WARD | 70,000 |") while room_rates_jsonb is empty and
 * package_amount is a ₹10 placeholder — parse them out as the real prices.
 */
function parseTariffInfoRooms(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([\d,]+)\s*\|/);
    if (!m) continue;
    const label = m[1].trim();
    const amount = Number(m[2].replace(/,/g, ''));
    if (/room|category|tariff|detail|---/i.test(label) && !/ward|twin|single|deluxe|suite|general/i.test(label)) continue; // header rows
    if (Number.isFinite(amount) && amount >= PLACEHOLDER_PRICE_MAX) out[label] = amount;
  }
  return Object.keys(out).length ? out : null;
}

/** Same family matcher as /lookup/resolve-treatment — the non-package route. */
async function familyMatches(text) {
  const families = listFamilies();
  const system = `You map a doctor's free-text treatment/surgery wording to a hospital's
known procedure families for cost estimation.

Known procedure families (use the exact key):
${families.map((f) => `- ${f.family}: ${f.label}`).join('\n')}

Return STRICT JSON: { "matches": [{ "family": "<exact key from the list>",
"confidence": "high"|"medium"|"low", "reason": "<one line why it matches>" }] }.
Return at most the top 3 matches ordered best-first; fewer if fewer plausibly fit,
and an empty array if nothing fits. Never invent family keys not in the list.`;
  const out = await geminiJson(`Doctor's wording: ${text}`, { system });
  const byKey = new Map(families.map((f) => [f.family, f]));
  const seen = new Set();
  return (Array.isArray(out?.matches) ? out.matches : [])
    .filter((m) => m && byKey.has(m.family) && !seen.has(m.family) && seen.add(m.family))
    .slice(0, 3)
    .map((m) => ({
      family: m.family,
      label: byKey.get(m.family).label,
      confidence: ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'low',
      reason: typeof m.reason === 'string' ? m.reason : '',
    }));
}

/**
 * ACTUAL billed package cases (converted actuals) — matched by PACKAGE CODE
 * first: the same code carries different names across tariffs ("name does not
 * define if they are separate packages — it is the package code"), so we
 * collect every master name that shares the code, plus the literal name.
 */
async function billedActuals(packageName, packageCode) {
  const { rows } = await query(
    `SELECT p_tariff_cd, payer_type, count(*)::int n,
            round(percentile_cont(0.25) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p25,
            round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p50,
            round(percentile_cont(0.75) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p75
     FROM fc.package_bill_admissions
     WHERE upper(btrim(package_name)) = upper(btrim($1))
        OR ($2 <> '' AND upper(btrim(package_name)) IN (
             SELECT DISTINCT upper(btrim(package_name)) FROM fc.package_master WHERE package_code = $2))
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [packageName, packageCode || '']
  );
  return rows;
}

/**
 * Related billed package history — the manager's "widen to related patterns"
 * view (URSL + DJ STENTING, CYSTOSCOPY URS…, PCNL…, DJ STENT REMOVAL for a
 * "dj stenting" intake): every billed package whose name shares meaningful
 * words with the treatment, with case counts and actual-bill percentiles.
 */
const RELATED_STOPWORDS = new Set(['AND', 'WITH', 'THE', 'FOR', 'OF', 'LEFT', 'RIGHT', 'UNILATERAL', 'BILATERAL', 'PA', 'PB']);
async function relatedBilledHistory(treatment) {
  // length >= 2: short clinical tokens ("DJ", "OT") are exactly the meaningful ones
  const words = (treatment || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 2 && !RELATED_STOPWORDS.has(w));
  if (!words.length) return { total_cases: 0, cash_like_cases: 0, groups: [] };
  const cond = words.map((_, i) => `upper(package_name) LIKE $${i + 1}`).join(' OR ');
  const params = words.map((w) => `%${w}%`);
  const { rows } = await query(
    `SELECT package_name, p_tariff_cd, payer_type, count(*)::int n,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY final_pkg_bill_excl_fnb)::numeric) p50
     FROM fc.package_bill_admissions
     WHERE package_name IS NOT NULL AND (${cond})
     GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 40`,
    params
  );
  const total = rows.reduce((t, r) => t + r.n, 0);
  const cashLike = rows
    .filter((r) => (r.p_tariff_cd || '').trim().toUpperCase() === 'TR1' || /GENERAL|PRIVATE/i.test(r.payer_type || ''))
    .reduce((t, r) => t + r.n, 0);
  return { total_cases: total, cash_like_cases: cashLike, groups: rows };
}

/** Does any tariff at all carry a package matching this text? (context when this tariff has none) */
async function existsOnOtherTariffs(text, excludeTariff) {
  const words = (text || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const score = words.map((_, i) => `(normalized_alias_text LIKE $${i + 2})::int`).join(' + ');
  const { rows } = await query(
    `SELECT DISTINCT tariff_code, package_name, MAX(${score}) AS score
     FROM fc.package_alias WHERE tariff_code <> $1
     GROUP BY 1, 2 HAVING MAX(${score}) >= ${Math.max(1, words.length - 1)}
     ORDER BY score DESC LIMIT 5`,
    [excludeTariff || '', ...words.map((w) => `%${w}%`)]
  );
  return rows.map((r) => ({ tariff_code: r.tariff_code, package_name: r.package_name }));
}

export async function packageGate({ treatment, payorBucket, organizationCd }) {
  const steps = [];
  const inputs = { treatment, payor_bucket: payorBucket, organization_cd: organizationCd ?? null };

  // family matching runs regardless — it is the non-package route AND the
  // cross-check the manager asked for; fire it early, in parallel with SQL.
  const familyPromise = familyMatches(treatment).catch(() => []);

  // ── 1. payor → tariff ────────────────────────────────────────────────────
  const tariff = await resolveTariff({ payorBucket, organizationCd });
  const tariffOk = !!tariff.tariff_cd;
  steps.push(step(
    'tariff', 'Payor → tariff', tariffOk ? 'ok' : 'blocked',
    tariffOk
      ? `${payorBucket} → ${tariff.tariff_cd} (${tariff.tariff_name})`
      : tariff.warnings?.[0] ?? 'Tariff could not be resolved',
    tariff
  ));

  // ── 2. package exists for this tariff? ──────────────────────────────────
  // Non-surgical admissions ("Medical Management for TBI") must not package-
  // match — the alias scorer would dredge up unrelated surgical packages.
  const isMedicalManagement = /\b(medical\s+management|conservative\s+(management|treatment)|observation|medical\s+care)\b/i.test(treatment);
  let candidates = [];
  let elsewhere = [];
  let ranking = null;
  if (!tariffOk) {
    steps.push(step('package_match', 'Package in master catalog', 'skipped', 'Skipped — no tariff resolved'));
  } else if (isMedicalManagement) {
    steps.push(step('package_match', 'Package in master catalog', 'skipped',
      'Skipped — medical-management admission (non-surgical): packages do not apply, use the cohort flow'));
  } else {
    candidates = await aliasCandidates({ text: treatment, tariff_code: tariff.tariff_cd, organization_cd: organizationCd, limit: 5 });
    // The word-overlap scorer has no clinical sense (appendicectomy→myomectomy
    // class of misses) — when several candidates surface, let the AI pick and
    // demote the rest; a null pick means nothing genuinely fits.
    if (candidates.length > 1) {
      try {
        const pick = await geminiJson(
          `Raw treatment text: "${treatment}" (tariff ${tariff.tariff_cd}).
Candidate hospital packages:
${candidates.map((c, i) => `${i}: [${c.package_code}] ${c.package_name}`).join('\n')}
Return JSON {"best_index": <int or null if none genuinely matches clinically>, "confidence": "high"|"medium"|"low", "reason": "..."}`,
          { system: 'You match raw treatment descriptions to hospital package catalog rows. Prefer exact clinical matches; return null when nothing genuinely fits. Never invent packages.' }
        );
        ranking = { method: 'ai', confidence: pick?.confidence ?? 'low', reason: pick?.reason ?? '' };
        if (pick?.best_index == null) {
          ranking.no_clinical_match = true;
          candidates = []; // alias hits were noise — treat as no package
        } else if (candidates[pick.best_index]) {
          const best = candidates[pick.best_index];
          candidates = [best, ...candidates.filter((c) => c !== best)];
        }
      } catch { ranking = { method: 'alias_score_only' }; }
    }
    if (!candidates.length) elsewhere = await existsOnOtherTariffs(treatment, tariff.tariff_cd);
    steps.push(step(
      'package_match', 'Package in master catalog', candidates.length ? 'ok' : (elsewhere.length ? 'warn' : 'missing'),
      candidates.length
        ? `${candidates.length} candidate package${candidates.length === 1 ? '' : 's'} on ${tariff.tariff_cd} — best: [${candidates[0].package_code}] ${candidates[0].package_name}${ranking?.method === 'ai' ? ` (AI-ranked, ${ranking.confidence})` : ''}`
        : ranking?.no_clinical_match
          ? `Alias search found packages but none genuinely matches "${treatment}" clinically — treated as no package`
          : elsewhere.length
            ? `No package on ${tariff.tariff_cd}, but similar packages exist on ${[...new Set(elsewhere.map((e) => e.tariff_code))].join(', ')}`
            : 'No matching package on any tariff',
      {
        candidates: candidates.map((c) => ({
          package_code: c.package_code, package_name: c.package_name,
          package_amount: c.package_amount, matched_alias: c.matched_alias,
          alias_confidence: c.alias_confidence, runtime_status: c.runtime_status,
          can_generate_estimate: c.can_generate_estimate, primary_blocker: c.primary_blocker,
          fc_template_package_code: c.fc_template_package_code,
          fc_case_count_total: c.fc_case_count_total,
        })),
        ...(ranking ? { ranking } : {}),
        exists_on_other_tariffs: elsewhere,
      }
    ));
  }

  // ── 3. package details usable? ───────────────────────────────────────────
  // The scalar package_amount can be a ₹10 TR1 placeholder while
  // room_rates_jsonb still carries the REAL per-room prices (URO5443: general
  // ₹70k … suite ₹1.01L) — so per-room rates rescue an unusable scalar price.
  const top = candidates[0] ?? null;
  let priceUsable = false;
  let inclusionsPresent = false;
  if (top) {
    const amount = Number(top.package_amount ?? 0);
    const scalarUsable = amount >= PLACEHOLDER_PRICE_MAX;
    // per-room prices: structured jsonb first, else the tariff_information markdown table
    const roomAmounts = deriveRoomAmounts(top.room_rates_jsonb) ?? parseTariffInfoRooms(top.tariff_information);
    const roomUsable = !!roomAmounts && Object.values(roomAmounts).some((v) => Number(v) >= PLACEHOLDER_PRICE_MAX);
    priceUsable = scalarUsable || roomUsable;
    inclusionsPresent = !!(top.inclusions_text_clean || top.inclusions_text);
    steps.push(step(
      'package_details', 'Package details usable', priceUsable && inclusionsPresent ? 'ok' : 'warn',
      [
        scalarUsable ? `Price ₹${amount.toLocaleString('en-IN')}`
          : roomUsable ? `Scalar price ₹${amount} is a placeholder — but per-room package rates exist`
            : `Price ₹${amount} is a placeholder — NOT usable`,
        inclusionsPresent ? 'inclusions documented' : 'inclusions missing',
      ].join(' · '),
      {
        package_amount: top.package_amount, price_usable: priceUsable,
        scalar_price_usable: scalarUsable,
        room_amounts: roomAmounts ?? null,
        inclusions_present: inclusionsPresent,
        inclusions_preview: (top.inclusions_text_clean || top.inclusions_text || '').slice(0, 600) || null,
        exclusions_preview: (top.exclusions_text_clean || top.exclusions_text || '').slice(0, 600) || null,
        documentation_status: top.documentation_status ?? null,
      }
    ));
  } else {
    steps.push(step('package_details', 'Package details usable', 'skipped', 'Skipped — no package matched'));
  }

  // ── 4. FC history — catalog mapping + actual billed package cases ───────
  let actualCasesThisTariff = 0;
  let actuals = [];
  if (top) {
    actuals = await billedActuals(top.package_name, top.package_code).catch(() => []);
    actualCasesThisTariff = actuals
      .filter((a) => (a.p_tariff_cd || '').trim().toUpperCase() === tariff.tariff_cd)
      .reduce((t, a) => t + a.n, 0);
    const totalCases = actuals.reduce((t, a) => t + a.n, 0);
    const mapped = !!top.fc_template_package_code;
    steps.push(step(
      'fc_history', 'FC history for this package',
      actualCasesThisTariff >= HISTORY_MIN_CASES ? 'ok' : totalCases > 0 || mapped ? 'warn' : 'missing',
      [
        `${actualCasesThisTariff} billed case${actualCasesThisTariff === 1 ? '' : 's'} on ${tariff.tariff_cd}`,
        `${totalCases} across all tariffs`,
        mapped ? `FC template mapped (${top.fc_template_package_code})` : 'no FC template mapping',
      ].join(' · '),
      {
        billed_actuals: actuals,
        fc_template_package_code: top.fc_template_package_code ?? null,
        fc_case_count_total: top.fc_case_count_total ?? null,
        primary_blocker: top.primary_blocker ?? null,
      }
    ));
  } else {
    steps.push(step('fc_history', 'FC history for this package', 'skipped', 'Skipped — no package matched'));
  }

  // ── 5. non-package cohort route (always computed — it is the fallback) ──
  // Payor-aware family selection (15-Jul flow doc): a match with NO cases for
  // this payor group must not win over one that has them — the robotic-TKR
  // example: robotic families are Cash-only, so GIPSA belongs on the plain
  // family (+ robotic add-on), never the robotic cohort.
  let families = await familyPromise;
  let payorNote = null;
  try {
    const counts = await familyPayorCounts();
    if (counts) {
      families = families.map((m) => ({ ...m, payor_cases: counts[m.family]?.[payorBucket] ?? 0 }));
      const best = families[0];
      if (best && best.payor_cases === 0) {
        const withCases = families.find((m) => m.payor_cases > 0);
        // Robotic family with no payor history ⇒ its BASE family + robotic
        // add-on is the correct cohort (robotic families are Cash-only).
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
    }
  } catch { /* counts unavailable — keep the AI order */ }
  steps.push(step(
    'family_flow', 'Procedure-family cohort (non-package route)',
    families.length ? (payorNote && !families[0].payor_cases ? 'warn' : 'ok') : 'missing',
    families.length
      ? payorNote ?? `Best family: ${families[0].label} (${families[0].confidence} confidence, ${families[0].payor_cases ?? '?'} ${payorBucket} cases)`
      : 'No onboarded procedure family matches this wording',
    { matches: families, ...(payorNote ? { payor_note: payorNote } : {}) }
  ));

  // related billed history (the manager's "widen to related patterns" block) —
  // computed for every gate run; the UI shows it behind a button.
  const related = await relatedBilledHistory(treatment).catch(() => ({ total_cases: 0, cash_like_cases: 0, groups: [] }));

  // ── route decision ────────────────────────────────────────────────────────
  let decision, reason;
  if (!tariffOk) {
    decision = 'blocked_no_tariff';
    reason = 'Cannot classify without a tariff — the payor needs an organization mapping first.';
  } else if (isMedicalManagement) {
    decision = 'non_package_cohort';
    reason = 'Medical-management admission — packages do not apply; price from the procedure-family cohort.';
  } else if (!top) {
    decision = 'non_package_cohort';
    reason = ranking?.no_clinical_match
      ? `Alias hits on ${tariff.tariff_cd} were not clinically genuine matches — non-package flow.`
      : elsewhere.length
        ? `No package on ${tariff.tariff_cd} (similar packages exist on ${[...new Set(elsewhere.map((e) => e.tariff_code))].join(', ')}) — treat as non-package for this payor.`
        : 'No matching package on any tariff — non-package flow.';
  } else if (priceUsable && actualCasesThisTariff >= HISTORY_MIN_CASES) {
    decision = 'exact_package';
    reason = `Package [${top.package_code}] has a usable price and ${actualCasesThisTariff} billed cases on ${tariff.tariff_cd}.`;
  } else {
    decision = 'package_with_review';
    reason = !priceUsable
      ? `Package exists but its ${tariff.tariff_cd} price (₹${top.package_amount}) is a placeholder — use billed actuals / related history, review before quoting.`
      : `Package exists with a usable price but only ${actualCasesThisTariff} billed case(s) on ${tariff.tariff_cd} — review against related history.`;
  }

  return { inputs, steps, route: { decision, reason }, related, generated_at: new Date().toISOString() };
}
