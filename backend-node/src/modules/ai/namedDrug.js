/**
 * P3 (problems-register-16jul): named high-cost drugs invisible to daycare
 * infusion pricing (SHOURYA "DAY CARE INJ STELMA 90 MG IV" — engine ₹17,821
 * vs bill ₹136,548). Deterministic, conservative matcher from the treatment
 * wording to fc.pharmacy_catalog_rate_reference — the ONLY pharmacy table
 * that carries prices (mrp / sale_rate; fc.pharmacy_item_mapping has names
 * and buckets, no price columns).
 *
 * Match ladder (DB proposes, nothing is ever invented):
 *   1. EXACT — whole-word match of a candidate token against item_name /
 *      generic_name / molecule_name. "PROGLOB" → PROGLOB 10GM 100ML IV INJ.
 *   2. FUZZY (only when NO exact hit anywhere) — brand-word prefix(4) +
 *      Levenshtein ≤ 2 + the dose stated next to the token must appear in
 *      the item name ("STELMA 90 MG" → STELARA 90MG/1ML INJ). The dose
 *      corroboration is mandatory: without it the tier never fires, so a
 *      random word can never buy a drug line.
 * A weak or ambiguous match (≥ 2 distinct brands) returns NOTHING — the
 * caller warns the FC to confirm from the pharmacy list instead of pricing
 * a guess. Consumers: buildEstimate step 13d + flow2's logic-numbers note.
 * Kill switch: P3_NAMED_DRUG=off.
 */
import { query } from '../../db/pool.js';

/**
 * The daycare-infusion-class family whitelist — the ONLY families the
 * named-drug pricing may run for. Every other family stays byte-identical
 * (a stray brand name in a surgical remark must never bolt a drug line onto
 * a surgical estimate). general_medical_management_infusion was deliberately
 * excluded from P4's catch-all guard so that "INJ <drug>" wording lands here
 * without a stacked confirmation question.
 */
export const P3_NAMED_DRUG_FAMILIES = new Set([
  'chemotherapy_systemic_therapy_infusion_daycare',
  'immunotherapy',
  'general_medical_management_infusion',
  'rheumatology_biologic_infusion_therapy',
]);

export const p3NamedDrugEnabled = () => process.env.P3_NAMED_DRUG !== 'off';

/** Below this ₹ value a matched drug is cohort noise, not a "named high-cost
 * drug" — no line is added (the cohort P50 already carries routine drugs). */
export const P3_MIN_DRUG_AMOUNT = 5000;

// Words that can never BE the drug name: dosing/route/form vocabulary, cheap
// carrier fluids, units, and care-setting words. Everything ≤ 3 chars is
// dropped by the length gate (IV, NS, MG, ...).
const STOPWORDS = new Set([
  'INJS', 'INJECTION', 'INJECTIONS', 'INFUSION', 'INFUSIONS', 'TABS', 'TABLET', 'TABLETS',
  'CAPS', 'CAPSULE', 'CAPSULES', 'SYRUP', 'VIAL', 'VIALS', 'AMPULE', 'AMPOULE', 'DOSE', 'DOSES',
  'DRIP', 'DRIPS', 'BOLUS', 'STAT', 'SESSION', 'SESSIONS', 'CYCLE', 'CYCLES',
  'SALINE', 'NORMAL', 'DEXTROSE', 'GLUCOSE', 'WATER', 'RINGER', 'LACTATE', 'SODIUM', 'CHLORIDE', 'POTASSIUM',
  'MGS', 'GMS', 'GRAM', 'GRAMS', 'MCG', 'UNITS', 'UNIT',
  'DAYCARE', 'CARE', 'WARD', 'ROOM', 'CASE', 'PATIENT', 'ADMISSION', 'ADMIT', 'DISCHARGE',
  'MEDICAL', 'SURGICAL', 'MANAGEMENT', 'PROCEDURE', 'PROCEDURES', 'TREATMENT', 'THERAPY', 'OBSERVATION',
  'CHEMOTHERAPY', 'CHEMO', 'IMMUNOTHERAPY', 'SYSTEMIC', 'BIOLOGIC', 'BIOLOGICAL', 'RHEUMATOLOGY',
  'PLAN', 'PLANNED', 'GIVEN', 'GIVE', 'UNDER', 'OVER', 'WITH', 'WITHOUT', 'POST', 'LEFT', 'RIGHT',
  'BOTH', 'SIDE', 'ONCE', 'TWICE', 'DAILY', 'WEEKLY', 'MONTHLY', 'HOUR', 'HOURS', 'HOURLY',
  'WEEK', 'WEEKS', 'DAYS', 'FIRST', 'SECOND', 'EACH', 'ONLY', 'ALSO', 'NEED', 'NEEDS', 'NEEDED',
  'TOTAL', 'APPROX', 'APPROXIMATE', 'ESTIMATE', 'ESTIMATED', 'ESTIMATION',
  'DOCTOR', 'CONSULT', 'CONSULTATION', 'FOLLOW', 'REVIEW', 'GENERAL', 'SINGLE', 'TWIN', 'SHARING',
]);

const UNIT_RE = /^(MG|MGS|GM|GMS|G|MCG|ML|IU|UNITS?)$/;

const tokensOf = (text) => String(text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
const isCandidate = (t) => /^[A-Z][A-Z0-9]*$/.test(t) && t.length >= 4 && !STOPWORDS.has(t);

/** Dose stated within 3 tokens after the candidate: "90 MG" / "10GM" → "90MG"/"10GM". */
function doseNear(tokens, idx) {
  for (let j = idx + 1; j <= Math.min(idx + 3, tokens.length - 1); j++) {
    const m = tokens[j].match(/^(\d+(?:\.\d+)?)(MG|GM|MCG|ML|IU|G)$/);
    if (m) return m[1] + m[2];
    if (/^\d+(?:\.\d+)?$/.test(tokens[j]) && tokens[j + 1] && UNIT_RE.test(tokens[j + 1])) {
      return tokens[j] + tokens[j + 1].replace(/S$/, '');
    }
  }
  return null;
}

/** Explicit unit count near the candidate ("X 2", "2 VIALS"); a dose alone means qty 1. */
function qtyNear(tokens, idx) {
  for (let j = idx + 1; j <= Math.min(idx + 5, tokens.length - 1); j++) {
    const t = tokens[j];
    const n = tokens[j + 1];
    let m = t.match(/^X(\d{1,2})$/);
    if (m) return { qty: Math.min(+m[1], 10), source: 'explicit_in_text' };
    if (t === 'X' && n && /^\d{1,2}$/.test(n)) return { qty: Math.min(+n, 10), source: 'explicit_in_text' };
    if (/^\d{1,2}$/.test(t) && n && /^(VIALS?|DOSES?|UNITS?|NOS?)$/.test(n)) {
      return { qty: Math.min(+t, 10), source: 'explicit_in_text' };
    }
  }
  return { qty: 1, source: 'default_1_no_explicit_units' };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Only DRUGS-classified rows may price; hims_only rows carry empty categories
// (STELARA), so an injectable-form word in the name stands in for the class.
const isDrugRow = (r) => r.category_level_1 === 'DRUGS'
  || (!r.category_level_1 && !r.category && /\b(INJ|INJECTION|INFUSION|VIAL)\b/i.test(r.item_name || ''));

const priceOf = (r) => (r.mrp != null && r.mrp > 0
  ? { price: r.mrp, price_source: 'mrp' }
  : (r.sale_rate != null && r.sale_rate > 0 ? { price: r.sale_rate, price_source: 'sale_rate' } : null));

const brandOf = (r) => (r.item_name || '').trim().split(/\s+/)[0]?.toUpperCase() ?? '';
const doseInRow = (r, dose) => dose != null
  && `${r.item_name || ''} ${r.generic_name || ''} ${r.molecule_name || ''}`.toUpperCase().replace(/\s+/g, '').includes(dose);

const CATALOG_COLS = `item_code, item_name, generic_name, molecule_name, category, category_level_1,
       current_status, mrp::float AS mrp, sale_rate::float AS sale_rate, mrp_populated`;

/** Pick one variant of a single brand: stated dose beats mrp_populated beats highest price. */
function pickVariant(rows, dose) {
  const score = (r) => (doseInRow(r, dose) ? 2e12 : 0) + (r.mrp_populated ? 1e12 : 0) + (priceOf(r)?.price ?? 0);
  return [...rows].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Conservative named-drug detection over free-text treatment wording.
 * Returns { matches, ambiguous, candidates, injection_context } — matches is
 * EMPTY unless the evidence is high-confidence (see the ladder above).
 */
export async function matchNamedDrugs(text) {
  const tokens = tokensOf(text);
  const candidates = [];
  for (let i = 0; i < tokens.length && candidates.length < 8; i++) {
    if (isCandidate(tokens[i]) && !candidates.some((c) => c.token === tokens[i])) {
      candidates.push({ token: tokens[i], idx: i, dose: doseNear(tokens, i) });
    }
  }
  // Explicit injection-order wording only (INJ <drug> ...). Deliberately NOT
  // "INFUSION"/"IV"/"DRIP": those are these families' own class words — a
  // plain "CHEMOTHERAPY / SYSTEMIC THERAPY INFUSION" build must stay silent,
  // not nag a confirm-warning onto every routine infusion estimate.
  const injection_context = /\b(INJ|INJS|INJECTION|INJECTIONS|IVIG)\b/.test(tokens.join(' '));
  const matches = [];
  const ambiguous = [];

  // tier 1 — exact whole-word matches
  for (const c of candidates) {
    if (matches.length >= 3) break;
    const re = `\\m${c.token}\\M`;
    const { rows } = await query(
      `SELECT ${CATALOG_COLS}
       FROM fc.pharmacy_catalog_rate_reference
       WHERE item_name ~* $1 OR generic_name ~* $1 OR molecule_name ~* $1
       LIMIT 25`, [re]
    );
    let hits = rows.filter((r) => isDrugRow(r) && priceOf(r));
    if (!hits.length) continue;
    let brands = new Set(hits.map(brandOf));
    if (brands.size > 1) {
      // prefer rows where the token IS the brand word (the FC named the brand)
      const own = hits.filter((r) => brandOf(r) === c.token);
      if (own.length) { hits = own; brands = new Set([c.token]); }
    }
    if (brands.size > 1) {
      ambiguous.push({ token: c.token, brands: [...brands].slice(0, 6) });
      continue;
    }
    const row = pickVariant(hits, c.dose);
    const p = priceOf(row);
    const q = qtyNear(tokens, c.idx);
    matches.push({
      token: c.token, match_kind: 'exact',
      item_code: row.item_code, item_name: row.item_name,
      generic_name: row.generic_name || row.molecule_name || null,
      price: p.price, price_source: p.price_source,
      qty: q.qty, qty_source: q.source,
      dose_in_text: c.dose, dose_matched: doseInRow(row, c.dose),
    });
  }

  // tier 2 — spelling-drift fuzzy, ONLY when nothing matched exactly, and
  // ONLY for tokens corroborated by an adjacent dose that the catalog row
  // must also carry. A single surviving brand is required.
  if (!matches.length) {
    for (const c of candidates) {
      if (matches.length >= 1) break; // one fuzzy match max — stay conservative
      if (c.token.length < 5 || !c.dose) continue;
      const { rows } = await query(
        `SELECT ${CATALOG_COLS}
         FROM fc.pharmacy_catalog_rate_reference
         WHERE upper(split_part(item_name, ' ', 1)) LIKE $1
         LIMIT 50`, [`${c.token.slice(0, 4)}%`]
      );
      const hits = rows.filter((r) => isDrugRow(r) && priceOf(r)
        && levenshtein(c.token, brandOf(r)) <= 2 && doseInRow(r, c.dose));
      if (!hits.length) continue;
      const brands = new Set(hits.map(brandOf));
      if (brands.size > 1) {
        ambiguous.push({ token: c.token, brands: [...brands].slice(0, 6) });
        continue;
      }
      const row = pickVariant(hits, c.dose);
      const p = priceOf(row);
      const q = qtyNear(tokens, c.idx);
      matches.push({
        token: c.token, match_kind: 'fuzzy',
        distance: levenshtein(c.token, brandOf(row)),
        item_code: row.item_code, item_name: row.item_name,
        generic_name: row.generic_name || row.molecule_name || null,
        price: p.price, price_source: p.price_source,
        qty: q.qty, qty_source: q.source,
        dose_in_text: c.dose, dose_matched: true,
      });
    }
  }

  return { matches, ambiguous, candidates: candidates.map((c) => c.token), injection_context };
}
