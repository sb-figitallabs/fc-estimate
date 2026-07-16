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

/**
 * Map one room_rates_jsonb tier label to the engine's room key.
 * Observed room_category_code / source_field variants per tariff:
 *  - TR287 Star / TR290 GIPSA: multi_sharing_general_ward,
 *    twin_sharing_ac_single_room_non_ac, deluxe_single_room_ac_private
 *  - TR289 Bajaj: general, twin, single_deluxe
 *  - TR285 Medi Assist: general, twin, single (+ general_ward_add_on /
 *    twin_sharing_add_on / single_room_add_on per-day add-ons — skipped)
 *  - TR201 ICICI: general, triple, twin, single_ac (triple ignored)
 * ICCU / suite / standalone-deluxe tiers are ignored — the engine only
 * prices general/twin/single today. Order matters: TWIN before SINGLE
 * (twin_sharing_ac_single_room_non_ac), SEMI before PRIVATE (Semi Private).
 */
function roomKeyForTier(label) {
  const k = String(label || '').toUpperCase();
  if (!k) return null;
  if (/ADD[\s_-]?ON|PER[\s_-]?DAY/.test(k)) return null; // per-day room add-ons, not tier prices
  if (/ICCU|SUITE|TRIPLE/.test(k)) return null;          // tiers the engine doesn't price yet
  if (/TWIN|SEMI/.test(k)) return 'twin';
  if (/SINGLE|PRIVATE/.test(k)) return 'single';         // single_deluxe, single_ac, deluxe_single_room_ac_private
  if (/GENERAL|MULTI|WARD|\bGW\b/.test(k)) return 'general';
  return null;
}

/**
 * Additive per-room package amounts derived from room_rates_jsonb
 * (fc.package_master → fc.v_package_runtime_lookup). Only tiers that are
 * present and > 0 appear; returns null (field omitted) when the jsonb is
 * missing, empty, or unmappable — callers fall back to scalar package_amount.
 */
export function deriveRoomAmounts(raw) {
  let rates = raw;
  if (typeof rates === 'string') { try { rates = JSON.parse(rates); } catch { return null; } }
  if (!rates) return null;
  const out = {};
  const put = (roomKey, amount) => {
    const amt = Number(amount);
    if (roomKey && Number.isFinite(amt) && amt > 0 && out[roomKey] == null) out[roomKey] = amt;
  };
  if (Array.isArray(rates)) {
    for (const rr of rates) {
      if (!rr || typeof rr !== 'object') continue;
      const roomKey = [rr.room_category_code, rr.source_field, rr.room_category_label, rr.room_category, rr.category]
        .map(roomKeyForTier).find(Boolean);
      put(roomKey, rr.amount ?? rr.rate);
    }
  } else if (typeof rates === 'object') {
    // defensive: plain { "GENERAL WARD": 103084, ... } map form
    for (const [k, v] of Object.entries(rates)) {
      put(roomKeyForTier(k), (v && typeof v === 'object') ? (v.amount ?? v.rate) : v);
    }
  }
  return Object.keys(out).length ? out : null;
}

function shape(row) {
  if (!row) return null;
  const {
    runtime_status, can_generate_estimate, primary_blocker, warning_reason, ...pkg
  } = row;
  const room_amounts = deriveRoomAmounts(row.room_rates_jsonb);
  return {
    ...pkg,
    ...(room_amounts ? { room_amounts } : {}), // additive — absent when jsonb missing/empty
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
  // Widest column set first; fall back to the older set so lookups keep
  // working when inclusions_clean_variants has not been bootstrapped yet.
  const attempts = [
    'inclusions_text_clean, exclusions_text_clean, inclusions_clean_variants',
    'inclusions_text_clean, exclusions_text_clean',
  ];
  for (const cols of attempts) {
    try {
      const { rows } = await query(
        `SELECT ${cols}
         FROM fc.package_master WHERE tariff_code = $1 AND package_code = $2`,
        [pkg.tariff_code, pkg.package_code]);
      if (rows[0]) {
        pkg.inclusions_text_clean = rows[0].inclusions_text_clean;
        pkg.exclusions_text_clean = rows[0].exclusions_text_clean;
        // per-variant clean texts (JSONB array aligned with inclusions_variants)
        if (rows[0].inclusions_clean_variants != null) {
          pkg.inclusions_clean_variants = rows[0].inclusions_clean_variants;
        }
      }
      break;
    } catch { /* columns not bootstrapped yet — try narrower set / omit */ }
  }
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

/**
 * ACTUAL converted package bills for this package (13-Jul todo: "estimate
 * range from actual package-bill amounts, excl. F&B"). final_pkg_bill_excl_fnb
 * = package + billed exclusions minus F&B — what patients really ended up
 * paying. Fail-open: engines without fc.package_bill_admissions get null.
 */
export async function billedActualsForPackage(packageName, tariff_code) {
  try {
    // three quartile sets per the 15-Jul flow doc: the gross (final bill),
    // the package amount itself, and what rode on top as billed exclusions.
    const q3 = (col) => `
      round(percentile_cont(0.25) WITHIN GROUP (ORDER BY ${col})::numeric) ${col.replace(/[^a-z_]/g, '')}_p25,
      round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${col})::numeric) ${col.replace(/[^a-z_]/g, '')}_p50,
      round(percentile_cont(0.75) WITHIN GROUP (ORDER BY ${col})::numeric) ${col.replace(/[^a-z_]/g, '')}_p75`;
    const { rows } = await query(
      `SELECT (upper(btrim(p_tariff_cd)) = upper(btrim($2))) AS this_tariff,
              count(*)::int cases,
              ${q3('final_pkg_bill_excl_fnb')},
              ${q3('pkg_gross_amount')},
              round(percentile_cont(0.25) WITHIN GROUP (ORDER BY greatest(final_pkg_bill_excl_fnb - pkg_gross_amount, 0))::numeric) excl_p25,
              round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY greatest(final_pkg_bill_excl_fnb - pkg_gross_amount, 0))::numeric) excl_p50,
              round(percentile_cont(0.75) WITHIN GROUP (ORDER BY greatest(final_pkg_bill_excl_fnb - pkg_gross_amount, 0))::numeric) excl_p75
       FROM fc.package_bill_admissions
       WHERE upper(btrim(package_name)) = upper(btrim($1)) AND final_pkg_bill_excl_fnb IS NOT NULL
         AND package_name NOT LIKE '%,%' -- multi-package combo bills (e.g. "CAG - CAT - 1,PTCA…") would inflate a single package's band
       GROUP BY 1`,
      [packageName, tariff_code || '']
    );
    if (!rows.length) return null;
    const mine = rows.find((r) => r.this_tariff) ?? null;
    const all = rows.reduce((t, r) => t + r.cases, 0);
    const set = (r, prefix) => ({ p25: Number(r[`${prefix}_p25`]), p50: Number(r[`${prefix}_p50`]), p75: Number(r[`${prefix}_p75`]) });
    return {
      basis: 'converted package bills (excl. F&B)',
      this_tariff: mine ? {
        cases: mine.cases,
        // gross final bill (kept flat for existing consumers)
        ...set(mine, 'final_pkg_bill_excl_fnb'),
        package_amount: set(mine, 'pkg_gross_amount'),
        exclusions_over_package: set(mine, 'excl'),
      } : null,
      all_tariffs_cases: all,
    };
  } catch { return null; }
}

/**
 * Bucket-level Historic Metrics for the package bill (16-Jul manager note):
 * what rides ABOVE the package, classified into the estimate's buckets —
 * per-admission quartiles across bills WHERE the bucket is present, from
 * fc.package_bill_bucket_metrics (scripts/backfill-package-bill-buckets.js).
 * Falls back to the All-Payers rollup when this payor group has no bills;
 * fail-open null on engines without the table.
 */
export async function bucketExtrasForPackage(package_code, tariff_code) {
  try {
    const t = (tariff_code || '').trim().toUpperCase();
    const payorGroup = !t || t === 'TR1' ? 'Cash' : t === 'TR290' ? 'GIPSA Insurance' : 'Non-GIPSA Insurance';
    const fetch = async (group) => (await query(
      `SELECT bucket, admissions, presence_cases, p25, p50, p75
       FROM fc.package_bill_bucket_metrics
       WHERE package_code = $1 AND payor_group = $2
       ORDER BY p50 DESC NULLS LAST`, [package_code, group])).rows;
    let rows = await fetch(payorGroup);
    let basis = payorGroup;
    if (!rows.length) { rows = await fetch('All Payers'); basis = 'All Payers'; }
    if (!rows.length) return null;
    return {
      payor_group: basis,
      buckets: rows.map((r) => ({
        bucket: r.bucket,
        admissions: r.admissions,
        cases: r.presence_cases,
        presence_pct: r.admissions ? Math.round((r.presence_cases / r.admissions) * 100) : null,
        p25: Number(r.p25),
        p50: Number(r.p50),
        p75: Number(r.p75),
      })),
    };
  } catch { return null; }
}

/**
 * P1 (problems-register-16jul): the with-package headline quote. The engine
 * identifies the package and even computes the open→package conversion, but no
 * with_package figure ever reached the quote (SURLA read as +82% when the
 * engine's own package+excludes arithmetic reproduced the ₹406,505 bill).
 * ADDITIVE — `final_estimate` stays itemized; clients pick the headline.
 *
 * extras ladder: (a) coverage-engine payable_extras when coverage computed;
 * (b) payor-group bucket_extras history — per-bucket P50s, presence-weighted
 * (presence ≥ 50% at P50, below that at P50 × presence); (c) billed-actuals
 * exclusions_over_package P50 — skipped when the recorded package gross ≈ the
 * final bill (exclusions are then 0 by construction, not evidence).
 *
 * package component: room-tier amount where room_amounts exist, else scalar —
 * BUT band-validated: the tiers can lag the billed tariff (P7 drift; ORT5531
 * tiers 118k/131k/143k vs billed lines 202k/227k/253k), so when the tier-based
 * total falls outside the actual converted-bill band while the scalar-based
 * total falls inside, the scalar wins (`package_amount_source` says which).
 *
 * Gating (the G NAGAVENI trap): the quote carries `blocked: true` +
 * `blocked_reason` — and must never be treated as a headline — when the
 * package price is a placeholder (≤ ₹1000), readiness says not_ready, no
 * extras source exists, or the quoted total sits outside the billed band
 * (same ±25% band rule as the conversion check, ≥ 5 cases).
 */
export function computePackageQuote({ pkg, roomKey, coverageExtras = null, bucketExtras = null, billedActuals = null }) {
  if (!pkg) return null;
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

  // — predicted payable extras: source ladder —
  let extras = null; let basis = null; let cases = null; let confidence = null;
  if (coverageExtras != null && Number.isFinite(Number(coverageExtras))) {
    extras = round2(Number(coverageExtras)); basis = 'coverage'; confidence = 'high';
  } else if (bucketExtras?.buckets?.length) {
    let sum = 0; let admissions = 0;
    for (const b of bucketExtras.buckets) {
      const p50 = Number(b.p50);
      if (!(p50 > 0)) continue;
      const presence = b.presence_pct;
      sum += presence == null || presence >= 50 ? p50 : p50 * (presence / 100);
      admissions = Math.max(admissions, Number(b.admissions) || 0);
    }
    extras = round2(sum); basis = 'bucket_extras_history'; confidence = 'medium';
    cases = admissions || null;
  } else {
    const ba = billedActuals?.this_tariff;
    const exclP50 = ba?.exclusions_over_package?.p50 == null ? NaN : Number(ba.exclusions_over_package.p50);
    // artifact guard: when pkg_gross ≈ final bill the exclusions quartiles are
    // 0 by construction — not an all-inclusive package, just unusable data.
    const grossIsWholeBill = ba?.package_amount?.p50 > 0 && ba?.p50 > 0
      && Math.abs(ba.package_amount.p50 - ba.p50) / ba.p50 < 0.02;
    if (ba && Number.isFinite(exclP50) && !grossIsWholeBill) {
      extras = round2(exclP50); basis = 'billed_exclusions'; confidence = 'low';
      cases = ba.cases ?? null;
    }
  }

  // — package component: room tier preferred, band-validated (P7 drift) —
  const scalar = Number(pkg.package_amount) || 0;
  const tier = Number(pkg.room_amounts?.[roomKey]);
  const ba = billedActuals?.this_tariff;
  const band = ba && ba.cases >= 5 && ba.p25 > 0 && ba.p75 > 0
    ? { lo: ba.p25 * 0.75, hi: ba.p75 * 1.25, p25: ba.p25, p75: ba.p75, cases: ba.cases }
    : null;
  const inBand = (total) => !band || (total >= band.lo && total <= band.hi);
  let pkgAmt = Number.isFinite(tier) && tier > 0 ? tier : scalar;
  let pkgSource = Number.isFinite(tier) && tier > 0 ? 'room_tier' : 'scalar';
  if (pkgSource === 'room_tier' && extras != null && band
      && !inBand(pkgAmt + extras) && scalar > 0 && inBand(scalar + extras)) {
    pkgAmt = scalar; pkgSource = 'scalar_band_fallback';
  }

  const total = round2(pkgAmt + (extras ?? 0));

  // — gating —
  const blockedReasons = [];
  if (!(pkgAmt > 1000)) blockedReasons.push('placeholder_package_amount');
  if (pkg.readiness && pkg.readiness.can_generate_estimate !== true) blockedReasons.push('not_ready');
  if (basis == null) blockedReasons.push('no_extras_history');
  if (extras != null && band && !inBand(total)) blockedReasons.push('outside_billed_band');

  return {
    with_package_total: total,
    package_component: pkgAmt,
    package_amount_source: pkgSource,
    extras_component: extras,
    extras_basis: basis,
    ...(cases != null ? { extras_cases: cases } : {}),
    ...(band ? { billed_band: { p25: band.p25, p75: band.p75, cases: band.cases } } : {}),
    confidence,
    blocked: blockedReasons.length > 0,
    ...(blockedReasons.length ? { blocked_reason: blockedReasons.join(', ') } : {}),
  };
}

async function finishOffer(pkg, tariff_code, organization_cd, source, candidates) {
  if (!pkg) return { status: 'no_package_exists', source, package: null, ...(candidates ? { candidates } : {}) };
  const history = await packageHistory({ tariff_code, package_code: pkg.package_code, organization_cd });
  const billed_actuals = await billedActualsForPackage(pkg.package_name, tariff_code);
  const bucket_extras = await bucketExtrasForPackage(pkg.package_code, tariff_code);
  if (billed_actuals && bucket_extras) billed_actuals.bucket_extras = bucket_extras;
  return {
    status: pkg.readiness.can_generate_estimate ? 'resolved' : 'not_ready',
    source,
    package: pkg,
    history,
    // name-variant bills can miss the name-keyed actuals while the
    // code-keyed bucket metrics still exist — surface them regardless
    ...(billed_actuals ? { billed_actuals }
      : bucket_extras ? { billed_actuals: { basis: 'converted package bills (excl. F&B)', this_tariff: null, all_tariffs_cases: null, bucket_extras } } : {}),
    ...(candidates ? { candidates } : {}),
  };
}
