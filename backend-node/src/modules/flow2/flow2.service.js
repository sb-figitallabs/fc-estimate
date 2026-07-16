/**
 * Flow 2 — the manager's 16-Jul flow note executed as an auditable SOP
 * sequence (parallel surface; existing build/gate flow untouched).
 *
 * POST /api/flow2/evaluate is STATELESS: every call re-evaluates the whole
 * SOP with the caller's accumulated `selections`, returns the full step
 * trail, and stops (pending_question) at the first decision that needs a
 * human answer. Numbers are PURE HISTORY — quartiles over the decided
 * cohort's actual bills; no tariff / LOS / logic math anywhere — so the flow
 * and the history validate independently of the calculation logic.
 *
 * Step order (the 16-Jul flow doc):
 *   payor → family_match → characterization → billing_identification →
 *   historic_template → template_summary → numbers
 *
 * Reuses the shared brains, never reimplements them:
 *   - payor→tariff: resolve/payorTariff.js
 *   - treatment→family + package ranking: resolve/familyResolve.js
 *   - cohort registry + rows: engine/cohort.js + engine/artifacts.js
 *   - robotic classification: robotic/robotic.service.js (persisted tables)
 *   - package master + billed actuals: packages/packages.service.js
 */
import { query } from '../../db/pool.js';
import { resolveTariff } from '../resolve/payorTariff.js';
import { familyMatches, payorAwareFamilies, rankPackageCandidates } from '../resolve/familyResolve.js';
import { listFamilies, getCohort } from '../engine/cohort.js';
import { fetchCohortRows } from '../engine/artifacts.js';
import { quartilesInclusive } from '../engine/stats.js';
import { familyRobotic, familyRoboticFor } from '../robotic/robotic.service.js';
import {
  lookupPackage, billedActualsForPackage, bucketExtrasForPackage,
} from '../packages/packages.service.js';

// ——— thresholds ————————————————————————————————————————————————————————————
/** Below this a package price is a TR1-style ₹10/₹0 placeholder, not a price. */
const PLACEHOLDER_PRICE_MAX = 1000;
/** exact-payor case sets below this auto-widen (exact → insurance_all → all). */
const MIN_EXACT_CASES = 5;
/** robotic case-set filter is relaxed (add-on story) below this many cases. */
const MIN_ROBOTIC_FILTER_CASES = 5;
/** case_set row cap, newest first. */
const CASE_SET_CAP = 200;
/**
 * Manager's rule, verbatim: a side of an axis is "present" when the history
 * has ANY case on it — both present ⇒ mandatory pending_question (the option
 * labels carry the counts, so a 2-of-122 minority is visible to the FC).
 */
const sidePresent = (n) => n > 0;

const PAYOR_GROUPS = ['Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance'];

/** payor bucket (+ resolved tariff) → payor group. TR290 = GIPSA (manager). */
function payorGroupOf(payorBucket, tariffCd) {
  if (PAYOR_GROUPS.includes(payorBucket)) return payorBucket;
  if (/gipsa/i.test(payorBucket || '') && !/non/i.test(payorBucket || '')) return 'GIPSA Insurance';
  if (!tariffCd || tariffCd === 'TR1') return /cash|general/i.test(payorBucket || '') ? 'Cash' : 'Non-GIPSA Insurance';
  return tariffCd === 'TR290' ? 'GIPSA Insurance' : 'Non-GIPSA Insurance';
}

/** Obvious multi-treatment separators: "+", ",", " and ", "&". */
export function splitFragments(text) {
  return String(text || '')
    .split(/\s*(?:\+|,|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

const STOPWORDS = new Set(['AND', 'WITH', 'THE', 'FOR', 'OF', 'LEFT', 'RIGHT', 'UNILATERAL', 'BILATERAL', 'PA', 'PB']);
const meaningfulWords = (text) => String(text || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ')
  .split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));

const mkStep = (key, title, checked, extra = {}) => ({
  key, title, checked,
  evidence: {}, decision: null, alternatives: [], decided_by: 'auto', status: 'done',
  ...extra,
});
const pendingStep = (key, title, why) =>
  mkStep(key, title, `Not evaluated — ${why}`, { status: 'pending' });

const q3 = (values) => {
  const q = quartilesInclusive(values);
  return { p25: Math.round(q.p25), p50: Math.round(q.p50), p75: Math.round(q.p75) };
};
const q3f = (values) => { // 1-decimal quartiles for day/hour drivers
  const q = quartilesInclusive(values);
  const r = (v) => Math.round(v * 10) / 10;
  return { p25: r(q.p25), p50: r(q.p50), p75: r(q.p75) };
};

const isMedicalMgmtWording = (t) =>
  /\b(medical\s+management|conservative\s+(management|treatment)|observation|medical\s+care)\b/i.test(t || '');

async function martCount(whereSql, params) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM mart.main_table WHERE ${whereSql}`, params);
  return rows[0].n;
}

// ——— main ——————————————————————————————————————————————————————————————————
export async function evaluateFlow2({ treatment_text, payment, selections, mode }) {
  const sel = selections ?? {};
  const cf = sel.case_filters ?? {};
  const steps = [];
  let pending = null;

  const fragments = splitFragments(treatment_text);
  const primary = fragments[0] ?? treatment_text.trim();
  const organizationCd = payment.organization_cd || undefined;

  // ── 1. payor ──────────────────────────────────────────────────────────────
  const tariff = await resolveTariff({ payorBucket: payment.payor_bucket, organizationCd });
  const payorGroup = payorGroupOf(payment.payor_bucket, tariff.tariff_cd);
  steps.push(mkStep(
    'payor', 'Payor → payor group + tariff',
    tariff.source === 'cash_default'
      ? `Cash patient — the hospital's own TR1 (KIMS) tariff applies directly; no insurer mapping is involved.`
      : `Checked "${payment.payor_bucket}"${organizationCd ? ` / ${organizationCd}` : ''} against fc.organization_tariff_mapping for the billing tariff and payor group (TR290 = GIPSA, other insurer tariffs = Non-GIPSA).`,
    {
      evidence: { mapping: tariff },
      decision: { payor_group: payorGroup, tariff_cd: tariff.tariff_cd, tariff_name: tariff.tariff_name },
    }
  ));

  // ── 2. family_match — the shared gate brain, payor-aware ─────────────────
  // one retry: the AI matcher flakes transiently, and an empty result here
  // must mean "no historic match", never "the matcher was down".
  let aiMatches = [];
  let matcherError = null;
  try { aiMatches = await familyMatches(primary); }
  catch {
    try { aiMatches = await familyMatches(primary); }
    catch { matcherError = 'AI family matcher unavailable (transient) — re-call to retry'; }
  }
  const { matches, payor_note } = await payorAwareFamilies(aiMatches, payment.payor_bucket);
  const registry = new Map(listFamilies().map((f) => [f.family, f]));

  let familyKey = null;
  let familyBy = 'auto';
  let familyNote = null;
  if (sel.family) {
    if (registry.has(sel.family)) {
      familyKey = sel.family;
      // A pin equal to the top match is stability plumbing (the UI re-sends
      // the resolved family so an AI-matcher flip between calls can't change
      // the cohort mid-conversation) — only a DIFFERENT family is a user choice.
      familyBy = sel.family === matches[0]?.family ? 'auto' : 'user';
    } else familyNote = `selections.family "${sel.family}" is not an onboarded family — falling back to the top match`;
  }
  if (!familyKey) familyKey = matches[0]?.family ?? null;
  const familyLabel = familyKey ? (registry.get(familyKey)?.label ?? familyKey) : null;
  const decidedMatch = matches.find((m) => m.family === familyKey) ?? null;

  steps.push(mkStep(
    'family_match', 'Treatment → historic family',
    `Matched "${primary}" against the onboarded family registry (shared gate brain: AI ranking + per-payor case counts from mart.main_table).`,
    {
      evidence: {
        candidates: matches.map((m) => ({
          family: m.family, label: m.label, confidence: m.confidence,
          payor_cases: m.payor_cases ?? null, reason: m.reason ?? '',
          ...(m.robotic_addon ? { robotic_addon: true } : {}),
        })),
        ...(payor_note ? { payor_note } : {}),
        ...(familyNote ? { note: familyNote } : {}),
        ...(matcherError ? { error: matcherError } : {}),
      },
      decision: familyKey
        ? {
          family: familyKey, label: familyLabel,
          confidence: decidedMatch?.confidence ?? null,
          payor_cases: decidedMatch?.payor_cases ?? null,
          ...(decidedMatch?.robotic_addon ? { robotic_addon: true } : {}),
        }
        : { family: null },
      alternatives: matches.filter((m) => m.family !== familyKey).map((m) => ({
        family: m.family, label: m.label, confidence: m.confidence, payor_cases: m.payor_cases ?? null,
      })),
      decided_by: familyBy,
      status: familyKey ? 'done' : 'pending',
    }
  ));

  if (!familyKey) {
    // Nothing in the historic registry matches — the trail ends here.
    steps.push(pendingStep('characterization', 'Surgical/medical · daycare · robotic', 'no historic family matched this wording'));
    steps.push(pendingStep('billing_identification', 'Package vs non-package billing', 'no historic family matched this wording'));
    steps.push(pendingStep('historic_template', 'FC-historic template (fallback ladder)', 'no historic family matched this wording'));
    steps.push(pendingStep('template_summary', 'Template summary per payor group', 'no historic family matched this wording'));
    return { mode, steps, pending_question: null, numbers: null };
  }

  // ── 3. characterization — the three axes from THIS hospital's history ────
  const def = await getCohort(familyKey);
  const p = def.params ?? [];
  const gi = p.length + 1;
  const { rows: [agg] } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE surgical_medical = 'Surgical')::int AS surgical,
            count(*) FILTER (WHERE surgical_medical = 'Medical')::int AS medical,
            count(*) FILTER (WHERE is_daycare_broad IS TRUE)::int AS daycare,
            count(*) FILTER (WHERE is_daycare_broad IS NOT TRUE)::int AS inpatient,
            count(*) FILTER (WHERE payor_bucket = $${gi})::int AS grp_total,
            count(*) FILTER (WHERE payor_bucket = $${gi} AND surgical_medical = 'Surgical')::int AS grp_surgical,
            count(*) FILTER (WHERE payor_bucket = $${gi} AND surgical_medical = 'Medical')::int AS grp_medical,
            count(*) FILTER (WHERE payor_bucket = $${gi} AND is_daycare_broad IS TRUE)::int AS grp_daycare,
            count(*) FILTER (WHERE payor_bucket = $${gi} AND is_daycare_broad IS NOT TRUE)::int AS grp_inpatient
     FROM mart.main_table WHERE ${def.whereSql}`,
    [...p, payorGroup]
  );

  // robotic presence — persisted per-payor-group classification (15-Jul #9:
  // MUST be per payor group; insurer robotic cases live inside conventional
  // cohorts). Caveat: presence 0 with cohort_cases 0 = NO DATA, not non-robotic.
  let rob = await familyRoboticFor(familyKey, payment.payor_bucket);
  let robScope = rob?.payor_group ?? payorGroup;
  let robGroupNoData = !rob || Number(rob.cohort_cases ?? 0) === 0;
  if (robGroupNoData) {
    const all = await familyRobotic(familyKey);
    const alt = all.find((r) => r.payor_group === 'All Payers' && Number(r.cohort_cases) > 0)
      ?? all.find((r) => Number(r.cohort_cases) > 0);
    if (alt) { rob = alt; robScope = alt.payor_group; }
  }
  const robCohort = Number(rob?.cohort_cases ?? 0);
  // the manager's "% of cases had it" = admission rate (any robotic-billed
  // line on the admission); presence_rate (signal-item metric) is the fallback
  const robRate = rob?.robotic_admission_rate != null ? Number(rob.robotic_admission_rate)
    : rob?.robotic_presence_rate != null ? Number(rob.robotic_presence_rate) : null;
  const robCases = Number(rob?.robotic_admission_cases ?? rob?.robotic_signal_cases ?? 0);
  const robNoData = robCohort === 0; // even after the All-Payers fallback

  // label counts: payor-group-scoped when the group has real history, else family-wide
  const useGrp = agg.grp_total >= MIN_EXACT_CASES;
  const scopeLabel = useGrp ? `${payorGroup} cases` : 'cases in this family’s history';
  const cnt = (grpVal, allVal) => (useGrp ? grpVal : allVal);

  const axes = [];
  let firstQuestion = null;

  // axis: care_type
  {
    const s = cnt(agg.grp_surgical, agg.surgical);
    const m = cnt(agg.grp_medical, agg.medical);
    const tot = cnt(agg.grp_total, agg.total);
    const sOk = sidePresent(s);
    const mOk = sidePresent(m);
    let value = null, by = 'auto', reason = null;
    if (sel.care_type) { value = sel.care_type; by = 'user'; reason = 'user selection'; }
    else if (sOk && !mOk) { value = 'Surgical'; reason = `history is effectively all surgical (${s} of ${tot} ${scopeLabel})`; }
    else if (mOk && !sOk) { value = 'Medical'; reason = `history is effectively all medical management (${m} of ${tot} ${scopeLabel})`; }
    else if (!sOk && !mOk) { reason = 'no care-type data in history'; }
    else {
      firstQuestion ??= {
        step_key: 'characterization', selection_key: 'care_type',
        question: `Is "${primary}" surgical or medical management here? The ${familyLabel} history has both.`,
        options: [
          { value: 'Surgical', label: `Surgical — ${s} of ${tot} ${scopeLabel}`, cases: s },
          { value: 'Medical', label: `Medical management — ${m} of ${tot} ${scopeLabel}`, cases: m },
        ],
      };
    }
    axes.push({ axis: 'care_type', value, decided_by: by, reason, counts: { surgical: s, medical: m, total: tot } });
  }

  // axis: setting
  {
    const d = cnt(agg.grp_daycare, agg.daycare);
    const i = cnt(agg.grp_inpatient, agg.inpatient);
    const tot = cnt(agg.grp_total, agg.total);
    const dOk = sidePresent(d);
    const iOk = sidePresent(i);
    let value = null, by = 'auto', reason = null;
    if (sel.setting) { value = sel.setting; by = 'user'; reason = 'user selection'; }
    else if (dOk && !iOk) { value = 'Daycare'; reason = `history is effectively all daycare (${d} of ${tot} ${scopeLabel})`; }
    else if (iOk && !dOk) { value = 'Inpatient'; reason = `history is effectively all inpatient (${i} of ${tot} ${scopeLabel})`; }
    else if (!dOk && !iOk) { reason = 'no setting data in history'; }
    else {
      firstQuestion ??= {
        step_key: 'characterization', selection_key: 'setting',
        question: `Will "${primary}" be daycare or an inpatient stay? The ${familyLabel} history has both.`,
        options: [
          { value: 'Daycare', label: `Daycare — ${d} of ${tot} ${scopeLabel}`, cases: d },
          { value: 'Inpatient', label: `Inpatient — ${i} of ${tot} ${scopeLabel}`, cases: i },
        ],
      };
    }
    axes.push({ axis: 'setting', value, decided_by: by, reason, counts: { daycare: d, inpatient: i, total: tot } });
  }

  // axis: robotic
  {
    const wordingRobotic = /ROBOT/i.test(treatment_text);
    const pct = robRate != null ? Math.round(robRate) : (robCohort > 0 ? Math.round((robCases / robCohort) * 100) : null);
    const roboticOk = !robNoData && (robCases > 0 || (pct != null && pct > 0));
    const nonRoboticOk = !robNoData && (robCohort - robCases > 0 || (pct != null && pct < 100));
    let value = null, by = 'auto', reason = null;
    if (wordingRobotic && sel.robotic !== 'no') {
      value = 'yes';
      by = sel.robotic === 'yes' ? 'user' : 'auto';
      reason = sel.robotic === 'yes' ? 'user selection' : 'the treatment wording itself says robotic';
    } else if (sel.robotic) { value = sel.robotic; by = 'user'; reason = 'user selection'; }
    else if (robNoData) {
      value = 'no';
      reason = `no robotic classification data for this cohort (0 classified cases) — NO DATA, not evidence of non-robotic; defaulting to non-robotic`;
    } else if (roboticOk && !nonRoboticOk) { value = 'yes'; reason = `robotic in ${pct}% of ${robCohort} ${robScope} cases`; }
    else if (nonRoboticOk && !roboticOk) { value = 'no'; reason = `robotic absent in the ${robScope} history (${pct}% of ${robCohort} cases)`; }
    else {
      firstQuestion ??= {
        step_key: 'characterization', selection_key: 'robotic',
        question: `Will this be robotic? The ${familyLabel} history has both.`,
        options: [
          { value: 'yes', label: `Robotic — ${pct}% of ${robCohort} ${robScope} cases had it`, cases: robCases },
          { value: 'no', label: `Non-robotic — ${100 - pct}% of ${robCohort} ${robScope} cases`, cases: robCohort - robCases },
        ],
      };
    }
    axes.push({
      axis: 'robotic', value, decided_by: by, reason,
      presence: { payor_group: robScope, cohort_cases: robCohort, presence_pct: pct, robotic_cases: robCases, ...(robGroupNoData ? { group_no_data: `${payorGroup} has no classified robotic data for this family` } : {}) },
    });
  }

  pending = firstQuestion;
  const decided = Object.fromEntries(axes.map((a) => [a.axis, a.value]));
  steps.push(mkStep(
    'characterization', 'Surgical/medical · daycare · robotic',
    `Checked the surgical/medical and daycare/inpatient splits in the ${familyLabel} history (mart.main_table) and robotic presence per payor group (fc.robotic_family_classification) — never AI general knowledge.`,
    {
      evidence: {
        family: familyKey,
        source: 'mart.main_table cohort counts + fc.robotic_family_classification',
        counts: {
          total: agg.total, surgical: agg.surgical, medical: agg.medical,
          daycare: agg.daycare, inpatient: agg.inpatient,
          [payorGroup]: { total: agg.grp_total, surgical: agg.grp_surgical, medical: agg.grp_medical, daycare: agg.grp_daycare, inpatient: agg.grp_inpatient },
        },
        axes,
      },
      decision: { care_type: decided.care_type, setting: decided.setting, robotic: decided.robotic },
      decided_by: axes.some((a) => a.decided_by === 'user') ? 'user' : 'auto',
      status: pending ? 'pending' : 'done',
    }
  ));

  if (pending) {
    steps.push(pendingStep('billing_identification', 'Package vs non-package billing', 'waiting on the characterization answer'));
    steps.push(pendingStep('historic_template', 'FC-historic template (fallback ladder)', 'waiting on the characterization answer'));
    steps.push(pendingStep('template_summary', 'Template summary per payor group', 'waiting on the characterization answer'));
    return { mode, steps, pending_question: pending, numbers: null };
  }

  // ── 4. billing_identification — package master on the resolved tariff ────
  const medicalRoute = decided.care_type === 'Medical' || isMedicalMgmtWording(treatment_text);
  let candidates = [];
  let ranking = null;
  if (tariff.tariff_cd && !medicalRoute) {
    try {
      ({ candidates, ranking } = await rankPackageCandidates({
        treatment: primary, tariff_code: tariff.tariff_cd, organization_cd: organizationCd,
      }));
    } catch { candidates = []; ranking = { method: 'unavailable' }; }
  }

  let pkg = null;
  let pkgBy = 'auto';
  let pkgNote = null;
  if (sel.package_code) {
    pkg = candidates.find((c) => c.package_code === sel.package_code) ?? null;
    if (!pkg && tariff.tariff_cd) {
      pkg = await lookupPackage({ tariff_code: tariff.tariff_cd, package_code: sel.package_code, organization_cd: organizationCd }).catch(() => null);
    }
    if (pkg) pkgBy = 'user';
    else pkgNote = `selections.package_code "${sel.package_code}" not found on ${tariff.tariff_cd ?? 'the resolved tariff'} — falling back to the best candidate`;
  }
  if (!pkg) pkg = candidates[0] ?? null;
  const billingType = pkg ? 'package' : 'non_package';

  const candidateEvidence = (c) => ({
    package_code: c.package_code,
    package_name: c.package_name,
    package_amount: c.package_amount != null ? Number(c.package_amount) : null,
    placeholder_price: !(Number(c.package_amount) >= PLACEHOLDER_PRICE_MAX),
    room_amounts: c.room_amounts ?? null, // per-room package prices where recoverable
    matched_alias: c.matched_alias ?? null,
    // manager 16-Jul: inclusions/exclusions are DISPLAY-ONLY in this flow
    documentation: {
      review_only: true,
      inclusions: (c.inclusions_text_clean || c.inclusions_text || '').slice(0, 800) || null,
      exclusions: (c.exclusions_text_clean || c.exclusions_text || '').slice(0, 800) || null,
    },
  });

  steps.push(mkStep(
    'billing_identification', 'Package vs non-package billing',
    medicalRoute
      ? 'Medical-management admission — packages do not apply; classified non-package without a master search.'
      : `Searched the ${tariff.tariff_cd ?? 'unresolved'} package master (fc.package_alias word match + AI clinical ranking) to decide package vs non-package billing.`,
    {
      evidence: {
        candidates: (pkg && !candidates.some((c) => c.package_code === pkg.package_code)
          ? [pkg, ...candidates] : candidates).map(candidateEvidence),
        ...(ranking ? { ranking } : {}),
        ...(pkgNote ? { note: pkgNote } : {}),
        ...(fragments.length > 1 ? {
          possible_combo: {
            fragments,
            note: 'evaluate each separately — combo pricing is a later phase',
          },
        } : {}),
      },
      decision: {
        billing_type: billingType,
        package_code: pkg?.package_code ?? null,
        package_name: pkg?.package_name ?? null,
        ...(pkg ? { package_amount: pkg.package_amount != null ? Number(pkg.package_amount) : null } : {}),
      },
      alternatives: candidates.filter((c) => c !== pkg).map((c) => ({
        package_code: c.package_code, package_name: c.package_name,
        package_amount: c.package_amount != null ? Number(c.package_amount) : null,
      })),
      decided_by: pkgBy,
    }
  ));

  // ── 5. historic_template — the manager's exact fallback ladder ───────────
  // Evaluated sequentially; the first hit decides. Later rungs stay tried:false.
  const famWithPayor = (decidedMatch && (decidedMatch.payor_cases ?? 0) > 0)
    ? decidedMatch
    : matches.find((m) => (m.payor_cases ?? 0) > 0) ?? null;
  const rungs = [];
  let usedRung = null;
  const addRung = (rung, label, evalFn) => rungs.push({ rung, label, evalFn });

  if (billingType === 'package') {
    addRung(1, `Package code ${pkg.package_code} in the FC-historic ${payorGroup} cohorts`, async () => {
      const n = await martCount(`package_code = $1 AND payor_bucket = $2`, [pkg.package_code, payorGroup]);
      return { hit: n > 0, cases: n };
    });
    addRung(2, `Similar package NAME in the FC-historic ${payorGroup} cohorts`, async () => {
      const words = meaningfulWords(pkg.package_name);
      if (!words.length) return { hit: false, cases: 0 };
      const score = words.map((_, i) => `(upper(package_name) LIKE $${i + 2})::int`).join(' + ');
      const { rows } = await query(
        `SELECT package_name, count(*)::int AS n FROM mart.main_table
         WHERE payor_bucket = $1 AND (${score}) >= ${Math.max(1, words.length - 1)}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        [payorGroup, ...words.map((w) => `%${w}%`)]
      );
      const cases = rows.reduce((t, r) => t + r.n, 0);
      return { hit: cases > 0, cases, candidates: rows };
    });
    addRung(3, `Non-package family with ${payorGroup} history`, async () => ({
      hit: !!famWithPayor, cases: famWithPayor?.payor_cases ?? 0,
      ...(famWithPayor ? { candidates: [{ family: famWithPayor.family, label: famWithPayor.label, cases: famWithPayor.payor_cases }] } : {}),
    }));
    addRung(4, 'Remaining packages / non-packages regardless of payor group', async () => {
      const n = await martCount(`package_code = $1`, [pkg.package_code]);
      const hit = n > 0 || matches.length > 0 || agg.total > 0;
      return { hit, cases: n > 0 ? n : agg.total };
    });
  } else {
    addRung(1, `Non-package family with ${payorGroup} history`, async () => ({
      hit: !!famWithPayor, cases: famWithPayor?.payor_cases ?? 0,
      ...(famWithPayor ? { candidates: [{ family: famWithPayor.family, label: famWithPayor.label, cases: famWithPayor.payor_cases }] } : {}),
    }));
    addRung(2, `Non-package family without ${payorGroup} history`, async () => ({
      hit: matches.length > 0 || agg.total > 0, cases: agg.total,
    }));
    addRung(3, `Package with ${payorGroup} history`, async () => {
      if (!candidates.length) return { hit: false, cases: 0 };
      const n = await martCount(`package_code = $1 AND payor_bucket = $2`, [candidates[0].package_code, payorGroup]);
      return { hit: n > 0, cases: n };
    });
    addRung(4, `Package without ${payorGroup} history`, async () => ({
      hit: candidates.length > 0, cases: 0,
      ...(candidates.length ? { candidates: candidates.slice(0, 3).map((c) => ({ package_code: c.package_code, package_name: c.package_name })) } : {}),
    }));
  }
  addRung(rungs.length + 1, 'No match in the FC historic dataset', async () => ({ hit: true, cases: 0 }));

  const rungResults = [];
  for (const r of rungs) {
    if (usedRung) { rungResults.push({ rung: r.rung, label: r.label, tried: false, hit: false }); continue; }
    let out;
    try { out = await r.evalFn(); } catch { out = { hit: false, cases: 0, error: 'evaluation failed' }; }
    rungResults.push({ rung: r.rung, label: r.label, tried: true, ...out });
    if (out.hit) usedRung = { rung: r.rung, label: r.label, cases: out.cases ?? 0 };
  }
  const noMatch = usedRung?.rung === rungs.length; // only the terminal rung hit

  steps.push(mkStep(
    'historic_template', 'FC-historic template (fallback ladder)',
    `Walked the ${billingType} fallback ladder for ${payorGroup} over mart.main_table history (package code → similar name → family cohorts → any payor).`,
    {
      evidence: { classification: billingType, rungs: rungResults },
      decision: noMatch
        ? { template: null, note: 'no match exists in the FC historic dataset' }
        : {
          template: familyKey, label: familyLabel,
          decided_rung: usedRung?.rung ?? null, rung_label: usedRung?.label ?? null,
          rung_cases: usedRung?.cases ?? 0,
          ...(billingType === 'package' ? { package_code: pkg.package_code } : {}),
        },
    }
  ));

  // ── 6. template_summary — per payor group for the decided template ───────
  const { rows: grpRows } = await query(
    `SELECT payor_bucket, count(*)::int AS total,
            count(*) FILTER (WHERE surgical_medical = 'Surgical')::int AS surgical,
            count(*) FILTER (WHERE surgical_medical = 'Medical')::int AS medical,
            count(*) FILTER (WHERE is_daycare_broad IS TRUE)::int AS daycare,
            count(*) FILTER (WHERE is_daycare_broad IS NOT TRUE)::int AS inpatient
     FROM mart.main_table WHERE ${def.whereSql} GROUP BY 1`,
    p
  );
  const robRows = await familyRobotic(familyKey);
  const robByGroup = new Map(robRows.map((r) => [r.payor_group, r]));
  const groups = {};
  for (const g of PAYOR_GROUPS) {
    const row = grpRows.find((r) => r.payor_bucket === g);
    const rr = robByGroup.get(g);
    const rrCohort = Number(rr?.cohort_cases ?? 0);
    const rrPct = rr?.robotic_presence_rate != null ? Math.round(Number(rr.robotic_presence_rate)) : null;
    groups[g] = {
      total_cases: row?.total ?? 0,
      care_split: { surgical: row?.surgical ?? 0, medical: row?.medical ?? 0 },
      setting_split: { daycare: row?.daycare ?? 0, inpatient: row?.inpatient ?? 0 },
      robotic: rrCohort > 0 && rrPct != null
        ? {
          presence_pct: rrPct,
          cohort_cases: rrCohort,
          classification: rrPct > 90 ? 'default' : rrPct >= 30 ? 'add_on_prompt' : 'absent',
        }
        : { presence_pct: null, cohort_cases: rrCohort, classification: 'no_data' },
    };
  }
  steps.push(mkStep(
    'template_summary', 'Template summary per payor group',
    `Summarised the ${familyLabel} template per payor group (Cash / GIPSA / Non-GIPSA) from mart.main_table cohort counts + fc.robotic_family_classification.`,
    {
      evidence: {
        source: 'mart.main_table + fc.robotic_family_classification',
        payor_buckets_seen: grpRows.map((r) => ({ payor_bucket: r.payor_bucket, cases: r.total })),
      },
      decision: { template: familyKey, label: familyLabel, groups },
    }
  ));

  // ── numbers — PURE HISTORY over the decided cohort ────────────────────────
  const numbers = await buildNumbers({
    def, familyKey, familyLabel, payorGroup,
    decisions: decided, caseFilters: cf,
    pkg: billingType === 'package' ? pkg : null,
    tariffCd: tariff.tariff_cd,
  });
  if (mode !== 'historic') numbers.note = 'logic comparison lands in phase B';

  return { mode, steps, pending_question: null, numbers };
}

// ——— numbers builder ————————————————————————————————————————————————————————
const BUCKET_LABELS = [
  ['room_charges', 'Room Charges'],
  ['procedure_ot_charges', 'Procedure / OT Charges'],
  ['investigations', 'Investigations'],
  ['professional_fees', 'Professional Fees'],
  ['ip_drugs', 'IP Drugs'],
  ['ip_consumables', 'IP Consumables'],
  ['ot_drugs', 'OT Drugs'],
  ['ot_consumables', 'OT Consumables'],
  ['implants', 'Implants'],
  ['pharmacy_total', 'Pharmacy (total)'],
  ['bedside_services', 'Bedside Services'],
  ['other_services', 'Other Services'],
];

async function buildNumbers({ def, familyKey, familyLabel, payorGroup, decisions, caseFilters, pkg, tariffCd }) {
  const rows = await fetchCohortRows(def.whereSql, def.params);
  const notes = [];

  // per-row setting flag (fetchCohortRows doesn't carry is_daycare_broad)
  const dayMap = new Map();
  try {
    const { rows: d } = await query(
      `SELECT admission_no, is_daycare_broad FROM mart.main_table WHERE ${def.whereSql}`, def.params
    );
    for (const r of d) dayMap.set(r.admission_no, r.is_daycare_broad === true);
  } catch { /* setting stays derived-false */ }

  // per-row robotic flag from fc.robotic_admission_classification (fallback false)
  const roboticSet = new Set();
  if (rows.length) {
    try {
      const { rows: rr } = await query(
        `SELECT ip_no FROM fc.robotic_admission_classification
         WHERE robotic_billed AND ip_no = ANY($1)`,
        [rows.map((r) => r.admission_no)]
      );
      for (const r of rr) roboticSet.add(r.ip_no);
    } catch { /* table absent — all rows report robotic: false */ }
  }

  // effective filters: characterization decisions, overridden by case_filters
  const applied = { payor_scope: null, setting: null, robotic: null, care_type: null };
  const care = caseFilters.care_type ?? decisions.care_type ?? null;
  const setting = caseFilters.setting ?? decisions.setting ?? null;
  const robotic = caseFilters.robotic ?? decisions.robotic ?? null;

  let set = rows;
  if (care) {
    const f = set.filter((r) => r.surgical_medical === care);
    if (f.length) { set = f; applied.care_type = care; }
    else notes.push(`care_type='${care}' filter relaxed — no matching historic cases`);
  }
  if (setting) {
    const want = setting === 'Daycare';
    const f = set.filter((r) => dayMap.get(r.admission_no) === want);
    if (f.length) { set = f; applied.setting = setting; }
    else notes.push(`setting='${setting}' filter relaxed — no matching historic cases`);
  }
  if (robotic) {
    const want = robotic === 'yes';
    const f = set.filter((r) => roboticSet.has(r.admission_no) === want);
    if (f.length >= MIN_ROBOTIC_FILTER_CASES) { set = f; applied.robotic = robotic; }
    else {
      notes.push(`robotic='${robotic}' filter relaxed — only ${f.length} matching historic case(s)` +
        (want ? '; robotic priced as an add-on on top of the base history' : ''));
    }
  }

  // payor scope: exact → insurance_all → all (auto-widen below MIN_EXACT_CASES
  // unless the caller pinned payor_scope explicitly)
  const scopeSets = {
    exact: set.filter((r) => r.payor_bucket === payorGroup),
    insurance_all: set.filter((r) => r.payor_bucket === 'GIPSA Insurance' || r.payor_bucket === 'Non-GIPSA Insurance'),
    all: set,
  };
  let scope = caseFilters.payor_scope ?? null;
  if (!scope) {
    if (scopeSets.exact.length >= MIN_EXACT_CASES) scope = 'exact';
    else if (scopeSets.insurance_all.length >= MIN_EXACT_CASES) {
      scope = 'insurance_all';
      notes.push(`payor_scope auto-widened to insurance_all — only ${scopeSets.exact.length} ${payorGroup} case(s)`);
    } else {
      scope = 'all';
      notes.push(`payor_scope auto-widened to all payors — only ${scopeSets.exact.length} ${payorGroup} case(s)`);
    }
  }
  set = scopeSets[scope];
  applied.payor_scope = scope;

  const grossOf = (r) => (r.total_plus_drug_admin ?? r.services_total_ex_fnb);

  // buckets — quartiles per estimate bucket over the FILTERED case set
  const buckets = BUCKET_LABELS.map(([key, label]) => {
    const vals = set.map((r) => Number(r.buckets?.[key] ?? 0));
    const cases = vals.filter((v) => v > 0).length;
    return { bucket: label, ...q3(vals), cases };
  }).filter((b) => b.cases > 0);

  // package history (name-keyed billed actuals + code-keyed bucket extras)
  let billed = null;
  let bucketExtras = null;
  if (pkg) {
    billed = await billedActualsForPackage(pkg.package_name, tariffCd).catch(() => null);
    bucketExtras = await bucketExtrasForPackage(pkg.package_code, tariffCd).catch(() => null);
  }

  const caseSet = [...set]
    .sort((a, b) => String(b.admission_no).localeCompare(String(a.admission_no)))
    .slice(0, CASE_SET_CAP)
    .map((r) => ({
      ip_no: r.admission_no,
      payor_bucket: r.payor_bucket,
      setting: dayMap.get(r.admission_no) ? 'Daycare' : 'Inpatient',
      robotic: roboticSet.has(r.admission_no),
      care_type: r.surgical_medical ?? null,
      gross: Math.round(Number(grossOf(r) ?? 0)),
    }));

  return {
    basis: {
      family: familyKey,
      label: familyLabel,
      filters_applied: applied,
      case_count: set.length,
      ...(notes.length ? { notes } : {}),
    },
    typical_inputs: {
      los_days: q3f(set.map((r) => r.normalized_billable_stay_days ?? (r.los_days != null ? Math.ceil(r.los_days) : null))),
      icu_days: q3f(set.map((r) => r.icu_days)),
      ot_hours: q3f(set.map((r) => r.ot_hours).filter((v) => v != null)),
    },
    buckets,
    gross: {
      approximate_bill: q3(set.map(grossOf).filter((v) => v != null)),
      package_bill: billed?.this_tariff
        ? { p25: billed.this_tariff.p25, p50: billed.this_tariff.p50, p75: billed.this_tariff.p75, cases: billed.this_tariff.cases }
        : null,
    },
    package: pkg
      ? {
        package_code: pkg.package_code,
        package_name: pkg.package_name,
        package_amount: billed?.this_tariff?.package_amount ?? null,
        bucket_extras: bucketExtras,
      }
      : null,
    case_set: caseSet,
  };
}
