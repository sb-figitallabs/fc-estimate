/**
 * Artifact computation — recomputes from the clean FC DB everything the
 * finalized builder read from pre-computed CSV/JSON artifacts
 * (spec/BUILD_SPEC.md §1b) and everything the Reference sheet holds
 * (spec/WORKBOOK_PARITY_SPEC.md §16).
 */
import { query } from '../../db/pool.js';
import { quartilesInclusive, summaryStats } from './stats.js';

export const BASIS_LABELS = [
  'Cash', 'GIPSA Insurance', 'Non-GIPSA Insurance', 'Corporate', 'Insurance All', 'All Payers',
];

const FNB_KEYWORDS = ['FOOD', 'BEVERAGE', 'FOOD AND BEVERAGES', 'TEA', 'COFFEE', 'JUICE', 'SOUP'];

/**
 * Parse an hour count out of a slot-style service name ("OT - 2 HOURS",
 * "OT-E - 1 1/2 HOURS", "CATH LAB - 1/2 HOUR"). Shared by the OT slot matrix
 * and the cath-lab billed-hours metric. Returns null when no hour token exists.
 */
export function parseSlotHours(name) {
  const s = String(name || '').toUpperCase();
  const frac = s.match(/(\d+)\s+(\d+)\s*\/\s*(\d+)\s*HOURS?/);
  if (frac) return +frac[1] + +frac[2] / +frac[3];
  const half = s.match(/(?:^|\s)(\d+)\s*\/\s*(\d+)\s*HOURS?/);
  if (half) return +half[1] / +half[2];
  const dec = s.match(/(\d+(?:\.\d+)?)\s*HOURS?/);
  return dec ? parseFloat(dec[1]) : null;
}

/** Fetch the cohort case rows (everything the artifact builder needs). */
export async function fetchCohortRows(whereSql, params) {
  const { rows } = await query(
    `SELECT admission_no, patient_name, payor_bucket, patient_type, organization_name,
            package_code, package_name,
            surgical_medical, los_days::float, icu_days::float, ward_days::float,
            derived_ot_hours::float AS ot_hours, service_line_count::int,
            normalized_billable_stay_days::float, room_category, icu_unit_name,
            curated_template_names_jsonb AS curated_templates,
            fc_actual_bucket_totals_jsonb AS buckets,
            fc_actual_total_excluding_fnb_and_returns::float AS services_total_ex_fnb,
            fc_actual_cash_drug_administration_charge::float AS drug_admin_charge,
            fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin::float AS total_plus_drug_admin,
            pharmacy_return_amount::float,
            (cleaned_pharmacy_returns_jsonb->'summary'->>'return_amount_total')::float AS cleaned_returns_total,
            cleaned_pharmacy_returns_jsonb AS cleaned_returns,
            cleaned_pharmacy_issue_jsonb AS cleaned_pharmacy,
            services_json, pharmacy_json
     FROM mart.main_table
     WHERE ${whereSql}
     ORDER BY admission_no`, params
  );
  return rows;
}

/** Partition cohort rows into the 6 basis cohorts. */
export function basisCohorts(rows) {
  const by = (f) => rows.filter(f);
  return {
    'Cash': by((r) => r.payor_bucket === 'Cash'),
    'GIPSA Insurance': by((r) => r.payor_bucket === 'GIPSA Insurance'),
    'Non-GIPSA Insurance': by((r) => r.payor_bucket === 'Non-GIPSA Insurance'),
    'Corporate': by((r) => r.payor_bucket === 'Corporate'),
    'Insurance All': by((r) => r.payor_bucket === 'GIPSA Insurance' || r.payor_bucket === 'Non-GIPSA Insurance'),
    'All Payers': rows,
  };
}

const bucketOf = (r, key) => Number(r.buckets?.[key] ?? 0);

/** Normalized billable stay (ceil-style) of one admission — the LOS basis every
 *  artifact uses (basis summary, actual metrics, P6 short-stay banding). */
export const stayOfRow = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);

/**
 * P6 trivial-stay floor (problems-register-16jul): quartiles of backfill bucket
 * fields over the SAME-stay-band sub-cohort (admissions with stay ≤ losCutoff,
 * normally the basis' LOS P25). The whole-cohort backfill medians are
 * stay-independent — a 1-day medical observation inherited the full cohort's
 * median diagnostics load (Investigations ₹20,790 on a ₹7.9k bill). Returns
 * { cases, fields: { [fieldKey]: { p25, p50, p75 } } }; the CALLER enforces the
 * minimum sub-cohort size (P6_SHORT_STAY_MIN_CASES) and falls back to the
 * whole-cohort metrics below it. Sub-cohort quartiles, never linear LOS scaling.
 */
export const P6_SHORT_STAY_MIN_CASES = 15;
export function shortStayBucketQuartiles(rows, losCutoff, fieldKeys) {
  const sub = (rows ?? []).filter((r) => stayOfRow(r) <= losCutoff);
  const fields = {};
  for (const f of fieldKeys) {
    const q = quartilesInclusive(sub.map((r) => bucketOf(r, f)));
    fields[f] = { p25: q.p25, p50: q.p50, p75: q.p75 };
  }
  return { cases: sub.length, fields };
}

/** Basis summary rows — Reference AZ:CP (one row per basis label). */
export function buildBasisSummary(cohorts) {
  return BASIS_LABELS.map((label) => {
    const rows = cohorts[label];
    const n = rows.length;
    const q = (vals) => quartilesInclusive(vals);
    // LOS artifact basis = normalized billable stay days (ceil-style), per reviewed builder
    const los = q(rows.map((r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days)));
    const icu = q(rows.map((r) => r.icu_days));
    const ward = q(rows.map((r) => r.ward_days));
    const ot = q(rows.map((r) => r.ot_hours).filter((v) => v != null));
    const slc = q(rows.map((r) => r.service_line_count));
    const bq = (key) => q(rows.map((r) => bucketOf(r, key)));
    const ipDrugs = bq('ip_drugs'), ipCons = bq('ip_consumables');
    const otDrugs = bq('ot_drugs'), otCons = bq('ot_consumables'), implants = bq('implants');
    const stayOf = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);
    const perDay = (key) => q(rows.map((r) => (stayOf(r) > 0 ? bucketOf(r, key) / stayOf(r) : 0)));
    const ipDrugsDay = perDay('ip_drugs'), ipConsDay = perDay('ip_consumables');
    // cath-lab family amounts: per-admission total of cath-lab service rows
    const cath = q(rows.map((r) => {
      let t = 0;
      for (const s of (Array.isArray(r.services_json) ? r.services_json : [])) {
        if (/CATH ?LAB/i.test(s.service_name || '')) t += Number(s.amount ?? 0);
      }
      return t;
    }));
    // cath-lab billed HOURS: parsed from the same slot-family row names the
    // amounts above come from ("CATH LAB ... N HOURS" wording), qty-weighted.
    // Admissions with no parseable cath-hour row are excluded (null), mirroring
    // the ot_hours null handling — so families whose cath rows carry no hour
    // token simply report 0/0/0 and the hours control stays inert.
    const cathHours = q(rows.map((r) => {
      let t = 0, seen = false;
      for (const s of (Array.isArray(r.services_json) ? r.services_json : [])) {
        if (!/CATH ?LAB/i.test(s.service_name || '')) continue;
        const h = parseSlotHours(s.service_name);
        if (h != null) { t += h * (Number(s.quantity ?? 1) || 1); seen = true; }
      }
      return seen ? t : null;
    }).filter((v) => v != null));
    return {
      basis_label: label,
      cohort_size: n,
      cash_count: rows.filter((r) => r.payor_bucket === 'Cash').length,
      gipsa_count: rows.filter((r) => r.payor_bucket === 'GIPSA Insurance').length,
      non_gipsa_count: rows.filter((r) => r.payor_bucket === 'Non-GIPSA Insurance').length,
      corporate_count: rows.filter((r) => r.payor_bucket === 'Corporate').length,
      los_p25: los.p25, los_p50: los.p50, los_p75: los.p75,
      icu_p25: icu.p25, icu_p50: icu.p50, icu_p75: icu.p75,
      ward_p25: ward.p25, ward_p50: ward.p50, ward_p75: ward.p75,
      ot_p25: ot.p25, ot_p50: ot.p50, ot_p75: ot.p75,
      service_line_p25: slc.p25, service_line_p50: slc.p50, service_line_p75: slc.p75,
      ip_drugs_p25: ipDrugs.p25, ip_drugs_p50: ipDrugs.p50, ip_drugs_p75: ipDrugs.p75,
      ip_consumables_p25: ipCons.p25, ip_consumables_p50: ipCons.p50, ip_consumables_p75: ipCons.p75,
      ot_drugs_p25: otDrugs.p25, ot_drugs_p50: otDrugs.p50, ot_drugs_p75: otDrugs.p75,
      ot_consumables_p25: otCons.p25, ot_consumables_p50: otCons.p50, ot_consumables_p75: otCons.p75,
      implants_p25: implants.p25, implants_p50: implants.p50, implants_p75: implants.p75,
      ip_drugs_day_p25: ipDrugsDay.p25, ip_drugs_day_p50: ipDrugsDay.p50, ip_drugs_day_p75: ipDrugsDay.p75,
      ip_consumables_day_p25: ipConsDay.p25, ip_consumables_day_p50: ipConsDay.p50, ip_consumables_day_p75: ipConsDay.p75,
      cath_lab_p25: cath.p25, cath_lab_p50: cath.p50, cath_lab_p75: cath.p75,
      cath_hours_p25: cathHours.p25, cath_hours_p50: cathHours.p50, cath_hours_p75: cathHours.p75,
    };
  });
}

const isFnb = (name) => {
  const s = (name || '').toUpperCase();
  return FNB_KEYWORDS.some((k) => s.includes(k));
};

/** Per-admission service lines (non-F&B). */
function serviceLines(row) {
  const arr = Array.isArray(row.services_json) ? row.services_json : [];
  return arr.filter((s) => !isFnb(s.service_name));
}

/**
 * Service item stats per basis — Reference CQ:DE.
 * Per item per basis: presence rate, per-admission qty quartiles, typical amount.
 */
export async function buildServiceStats(cohorts, tariffCd = 'TR1') {
  // service mapping + tariff rates for all codes seen
  const mapping = new Map();
  {
    const { rows } = await query(
      `SELECT canonical_item_key, item_code, item_name, fc_estimate_bucket, grouping,
              billing_head, sub_head, room_category_dependent
       FROM fc.service_item_mapping`
    );
    for (const m of rows) mapping.set(m.item_code, m);
  }
  const rates = await tariffRateLookup(tariffCd);

  const out = [];
  for (const basis of BASIS_LABELS) {
    const rows = cohorts[basis];
    const n = rows.length;
    // per item: admission -> {qty, amount}
    const perItem = new Map();
    for (const r of rows) {
      const seen = new Map();
      for (const s of serviceLines(r)) {
        const code = s.service_code;
        if (!code) continue;
        const cur = seen.get(code) || { qty: 0, amount: 0, name: s.service_name };
        cur.qty += Number(s.quantity ?? 0);
        cur.amount += Number(s.amount ?? 0);
        seen.set(code, cur);
      }
      for (const [code, agg] of seen) {
        if (!perItem.has(code)) perItem.set(code, []);
        perItem.get(code).push(agg);
      }
    }
    for (const [code, list] of perItem) {
      const m = mapping.get(code);
      const qq = quartilesInclusive(list.map((x) => x.qty));
      const aq = quartilesInclusive(list.map((x) => x.amount));
      const rate = rates.get(code) || {};
      out.push({
        key: `${basis}|${code}`,
        basis_label: basis,
        item_code: code,
        item_name: m?.item_name || list[0].name,
        fc_estimate_bucket: m?.fc_estimate_bucket || 'unmapped',
        grouping: m?.grouping || '',
        case_count: list.length,        // admissions (this basis) where the item appears
        basis_case_count: n,            // total admissions in this basis cohort
        case_presence_rate: n ? (list.length / n) * 100 : 0,
        quantity_p25: qq.p25, quantity_p50: qq.p50, quantity_p75: qq.p75,
        amount_cash_typical: aq.p50,
        tariff_general: rate.general ?? null, tariff_twin: rate.twin ?? null,
        tariff_single: rate.single ?? null, tariff_icu: rate.icu ?? null,
        mapped: !!m,
      });
    }
  }
  return out;
}

/** Catalog display names: canonical pharmacy item_name per code (matches finalized artifacts). */
export async function pharmacyCatalogNames() {
  const { rows } = await query(
    `SELECT item_code, item_name, mrp::float, sale_rate::float FROM fc.pharmacy_catalog_rate_reference`
  );
  return new Map(rows.map((r) => [r.item_code, r]));
}

/** Pharmacy item stats per basis — Reference DG:DR. Uses CLEANED (deduplicated) issue lines. */
export function buildPharmacyStats(cohorts, _unused = new Map()) {
  // display names = raw billed item_desc (matches finalized artifacts)
  const rawName = new Map();
  for (const r of cohorts['All Payers']) {
    for (const it of (r.pharmacy_json?.items || [])) {
      if (it.item_code && it.item_desc && !rawName.has(it.item_code)) rawName.set(it.item_code, it.item_desc);
    }
  }
  const out = [];
  for (const basis of BASIS_LABELS) {
    const rows = cohorts[basis];
    const n = rows.length;
    const perItem = new Map();
    for (const r of rows) {
      const items = r.cleaned_pharmacy?.items || [];
      const seen = new Map();
      for (const it of items) {
        const code = it.item_code;
        if (!code) continue;
        const cur = seen.get(code) || {
          name: rawName.get(code) || it.item_name,
          ot_qty: 0, ot_amount: 0, ip_qty: 0, ip_amount: 0, qty: 0, amount: 0,
        };
        const qty = Number(it.raw_quantity ?? 0);
        const amt = Number(it.reconstructed_gross_amount ?? (qty * Number(it.sale_rate ?? 0)));
        cur.qty += qty; cur.amount += amt;
        if ((it.pharmacy_section || '').toUpperCase() === 'OT') { cur.ot_qty += qty; cur.ot_amount += amt; }
        else { cur.ip_qty += qty; cur.ip_amount += amt; }
        seen.set(code, cur);
      }
      for (const [code, agg] of seen) {
        if (!perItem.has(code)) perItem.set(code, []);
        perItem.get(code).push(agg);
      }
    }
    for (const [code, list] of perItem) {
      const med = (f) => quartilesInclusive(list.map(f)).p50;
      const name = list[0].name;
      out.push({
        key: `${basis}|${code}|${name}`,
        name_key: `${basis}|${name}`,
        basis_label: basis,
        item_code: code,
        item_name: name,
        case_presence_rate: n ? (list.length / n) * 100 : 0,
        ot_quantity_typical: med((x) => x.ot_qty),
        ot_amount_typical: med((x) => x.ot_amount),
        ip_quantity_typical: med((x) => x.ip_qty),
        ip_amount_typical: med((x) => x.ip_amount),
        overall_quantity_typical: med((x) => x.qty),
        overall_amount_typical: med((x) => x.amount),
      });
    }
  }
  return out;
}

/** Room keys carried on each tariff-rate entry. */
const TARIFF_ROOM_KEYS = ['general', 'twin', 'single', 'icu', 'deluxe', 'daycare'];

/** Fold raw tariff matrix rows into a Map: service_cd -> {name, general, twin, ...}. */
function foldTariffRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.service_cd) || { name: r.service_name };
    const w = (r.ward_group_name || '').toUpperCase();
    if (w.includes('GENERAL')) cur.general = r.charge;
    else if (w.includes('TWIN')) cur.twin = r.charge;
    else if (w.includes('SINGLE')) cur.single = r.charge;
    else if (w.includes('ICCU') || w.includes('ICU')) cur.icu = r.charge;
    else if (w.includes('DELUXE')) cur.deluxe = r.charge;
    else if (w.includes('DAY')) cur.daycare = r.charge;
    map.set(r.service_cd, cur);
  }
  return map;
}

/**
 * TR-tariff rate lookup: item_code -> {general,twin,single,icu} (+ daycare/deluxe if present).
 *
 * Insurer tariffs (e.g. TR287 Star, TR286 HDFC, TR289 Bajaj) often carry empty or ₹0
 * service-rate matrices. For any tariff other than TR1 (cash), missing/zero room rates
 * are filled per-item from TR1 and flagged `tr1_fallback: true` on the entry.
 * Conservative rule: an org rate of exactly 1 (₹1 token, usually "inside package") is a
 * REAL value and is never overridden — only null/undefined or <= 0 rates are filled.
 * The returned Map additionally carries `tr1FallbackCount` and `tr1FallbackCodes`
 * (capped at 200) so callers can surface fallback usage.
 */
export async function tariffRateLookup(tariffCd) {
  if (tariffCd === 'TR1') {
    const { rows } = await query(
      `SELECT service_cd, service_name, ward_group_name, charge::float
       FROM fc.service_tariff_rate_matrix WHERE tariff_cd = $1`, [tariffCd]
    );
    return foldTariffRows(rows);
  }

  // One query for both the org tariff and the TR1 (cash) baseline, then partition.
  const { rows } = await query(
    `SELECT tariff_cd, service_cd, service_name, ward_group_name, charge::float
     FROM fc.service_tariff_rate_matrix WHERE tariff_cd IN ($1, 'TR1')`, [tariffCd]
  );
  const map = foldTariffRows(rows.filter((r) => r.tariff_cd === tariffCd));
  const tr1 = foldTariffRows(rows.filter((r) => r.tariff_cd === 'TR1'));

  const fallbackCodes = [];
  for (const [code, base] of tr1) {
    const cur = map.get(code);
    if (!cur) {
      // Service exists only in TR1 — whole-entry fallback.
      map.set(code, { ...base, tr1_fallback: true });
      fallbackCodes.push(code);
      continue;
    }
    let filled = false;
    for (const k of TARIFF_ROOM_KEYS) {
      const v = cur[k];
      // Fill only when the org tariff has no value or a non-positive value.
      // An org rate of exactly 1 (₹1 token) is > 0, hence kept as-is.
      if ((v == null || v <= 0) && base[k] != null && base[k] > 0) {
        cur[k] = base[k];
        filled = true;
      }
    }
    if (filled) {
      cur.tr1_fallback = true;
      fallbackCodes.push(code);
    }
  }
  map.tr1FallbackCount = fallbackCodes.length;
  map.tr1FallbackCodes = fallbackCodes.slice(0, 200);
  return map;
}

/** Actual-basis metric rows — Reference HA:HJ (basis|field_key -> min/max/avg/p25/p50/p75). */
export function buildActualBasisMetrics(cohorts) {
  const stayOf = (r) => r.normalized_billable_stay_days ?? Math.ceil(r.los_days);
  const fieldOf = {
    los_days: (r) => stayOf(r), // normalized billable stay, per reviewed builder
    icu_days: (r) => r.icu_days,
    ward_days: (r) => r.ward_days,
    ot_hours: (r) => r.ot_hours ?? 0,
    service_line_count: (r) => r.service_line_count,
    room_charges: (r) => bucketOf(r, 'room_charges'),
    room_charges_per_day: (r) => (stayOf(r) > 0 ? bucketOf(r, 'room_charges') / stayOf(r) : 0),
    investigations: (r) => bucketOf(r, 'investigations'),
    procedure_ot_charges: (r) => bucketOf(r, 'procedure_ot_charges'),
    bedside_services: (r) => bucketOf(r, 'bedside_services'),
    other_services: (r) => bucketOf(r, 'other_services'),
    ip_drugs: (r) => bucketOf(r, 'ip_drugs'),
    ip_drugs_per_day: (r) => (stayOf(r) > 0 ? bucketOf(r, 'ip_drugs') / stayOf(r) : 0),
    ip_consumables: (r) => bucketOf(r, 'ip_consumables'),
    ip_consumables_per_day: (r) => (stayOf(r) > 0 ? bucketOf(r, 'ip_consumables') / stayOf(r) : 0),
    ot_drugs: (r) => bucketOf(r, 'ot_drugs'),
    ot_consumables: (r) => bucketOf(r, 'ot_consumables'),
    implants: (r) => bucketOf(r, 'implants'),
    pharmacy_total: (r) => bucketOf(r, 'pharmacy_total'),
    drug_administration_charges: (r) => Number(r.drug_admin_charge ?? 0),
    professional_fees: (r) => bucketOf(r, 'professional_fees'),
    services_total_excluding_food_and_beverage: (r) => Number(r.services_total_ex_fnb ?? 0) - bucketOf(r, 'pharmacy_total'),
    food_and_beverage_excluded: (r) => bucketOf(r, 'food_and_beverage'),
    pharmacy_returns_excluded: (r) => Number(r.cleaned_returns_total ?? 0),
    total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin: (r) => Number(r.total_plus_drug_admin ?? 0),
  };
  const out = [];
  for (const basis of BASIS_LABELS) {
    const rows = cohorts[basis];
    for (const [field, fn] of Object.entries(fieldOf)) {
      const stats = summaryStats(rows.map(fn));
      out.push({ key: `${basis}|${field}`, basis_label: basis, field_key: field, ...stats });
    }
  }
  return out;
}

/**
 * PF payor summary — Reference FC:GC.
 * Role classification: explicit ASST SURGEON / ASSISTANT ANESTHETIST names first,
 * then doctor's specialty (service_group_name): ORTHOPAEDICS→surgeon,
 * ANAESTHESIOLOGY→anesthetist, other specialties→consultant_or_physician.
 * general_needed = collectible PF bucket − named professional rows (per admission).
 */
export function classifyPfRole(serviceName, groupName, surgicalGroup = 'ORTHOPAEDIC') {
  const name = (serviceName || '').toUpperCase();
  const grp = (groupName || '').toUpperCase();
  if (/\b(ASST|ASSISTANT)\b/.test(name) && /SURGEON/.test(name)) return 'assistant_surgeon';
  if (/\b(ASST|ASSISTANT)\b/.test(name) && /ANESTH|ANAESTH/.test(name)) return 'assistant_anesthetist';
  if (grp.includes(surgicalGroup)) return 'surgeon';
  if (grp.includes('ANAESTH') || grp.includes('ANESTH')) return 'anesthetist';
  return 'consultant_or_physician';
}

export const PF_ROLES = [
  'surgeon', 'assistant_surgeon', 'anesthetist', 'assistant_anesthetist', 'consultant_or_physician',
];

export function buildPfPayorSummary(cohorts, { surgicalGroup = 'ORTHOPAEDIC' } = {}) {
  return BASIS_LABELS.map((basis) => {
    const rows = cohorts[basis];
    const collect = rows.map((r) => bucketOf(r, 'professional_fees'));
    const q = quartilesInclusive(collect);
    // per-admission role totals
    const perAdm = rows.map((r) => {
      const roles = Object.fromEntries(PF_ROLES.map((x) => [x, 0]));
      let named = 0;
      for (const s of serviceLines(r)) {
        // PF lines = named professional fees + specialist consultation visits
        if (!['Professional', 'Consultations'].includes(s.service_type || '')) continue;
        const amt = Number(s.amount ?? 0);
        named += amt;
        roles[classifyPfRole(s.service_name, s.service_group_name, surgicalGroup)] += amt;
      }
      const collectible = bucketOf(r, 'professional_fees');
      return { roles, named, general_needed: collectible - named };
    });
    const roleQ = {};
    for (const role of PF_ROLES) {
      roleQ[role] = quartilesInclusive(perAdm.map((a) => a.roles[role]));
    }
    const namedQ = quartilesInclusive(perAdm.map((a) => a.named));
    const genQ = quartilesInclusive(perAdm.map((a) => a.general_needed));
    // dominant shape: cash-formula-like when surgeon dominates and general_needed small
    const dominant = roleQ.surgeon.p50 > 0 ? 'cash_formula_like' : 'mixed';
    return {
      payor_bucket: basis,
      case_count: rows.length,
      collectible_p25: q.p25, collectible_p50: q.p50, collectible_p75: q.p75,
      named_p25: namedQ.p25, named_p50: namedQ.p50, named_p75: namedQ.p75,
      general_needed_p25: genQ.p25, general_needed_p50: genQ.p50, general_needed_p75: genQ.p75,
      roles: roleQ,
      dominant_pf_shape: rows.length ? dominant : '',
    };
  });
}

/** Org tariff directory — Reference DT:DZ. */
export async function buildOrgDirectory() {
  const { rows } = await query(
    `SELECT organization_cd, organization_name, tariff_cd, tariff_name, priority_type
     FROM fc.organization_tariff_mapping ORDER BY organization_name`
  );
  return rows.map((r) => ({
    payor_bucket: 'Non-GIPSA Insurance', // directory rows; payor bucket resolved at runtime
    organization_cd: r.organization_cd,
    organization_name: r.organization_name,
    organization_label: `${r.organization_name} (${r.organization_cd})`,
    tariff_code: r.tariff_cd,
    tariff_name: r.tariff_name,
  }));
}

/** Tariff rate matrix rows (all tariffs referenced by orgs + TR1) — Reference EB:EJ. */
export async function buildTariffRateMatrix(itemCodes) {
  const { rows } = await query(
    `SELECT m.tariff_cd, t.tariff_name, m.service_cd, m.service_name, m.ward_group_name, m.charge::float
     FROM fc.service_tariff_rate_matrix m
     LEFT JOIN (SELECT DISTINCT tariff_cd, tariff_name FROM fc.organization_tariff_mapping) t USING (tariff_cd)
     WHERE m.service_cd = ANY($1)`, [itemCodes]
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.tariff_cd}|${r.service_cd}`;
    const cur = map.get(key) || {
      matrix_key: key, tariff_code: r.tariff_cd, tariff_name: r.tariff_name || (r.tariff_cd === 'TR1' ? 'KIMS' : ''),
      item_code: r.service_cd, item_name: r.service_name,
    };
    const w = (r.ward_group_name || '').toUpperCase();
    if (w.includes('GENERAL')) cur.general = r.charge;
    else if (w.includes('TWIN')) cur.twin = r.charge;
    else if (w.includes('SINGLE')) cur.single = r.charge;
    else if (w.includes('ICCU') || w.includes('ICU')) cur.icu = r.charge;
    map.set(key, cur);
  }
  return [...map.values()];
}

/** OT slot ladder + OT slot rate matrix — Reference J:R / EL:EV. Parses "OT - X HOURS" service names. */
export async function buildOtSlotMatrix(tariffCds = ['TR1']) {
  const { rows } = await query(
    `SELECT tariff_cd, service_cd, service_name, ward_group_name, charge::float
     FROM fc.service_tariff_rate_matrix
     WHERE tariff_cd = ANY($1) AND service_name ~* '^OT(-E)? - .*HOURS?'`, [tariffCds]
  );
  const map = new Map();
  for (const r of rows) {
    const hours = parseSlotHours(r.service_name);
    if (hours == null) continue;
    const mode = r.service_name.toUpperCase().startsWith('OT-E') ? 'emergency' : 'normal';
    const key = `${r.tariff_cd}|${mode}|${hours}`;
    const cur = map.get(key) || {
      matrix_key: key, tariff_code: r.tariff_cd, ot_slot_hours: hours, ot_mode: mode,
      item_code: r.service_cd, item_name: r.service_name,
    };
    const w = (r.ward_group_name || '').toUpperCase();
    if (w.includes('GENERAL')) cur.general = r.charge;
    else if (w.includes('TWIN')) cur.twin = r.charge;
    else if (w.includes('SINGLE')) cur.single = r.charge;
    else if (w.includes('ICCU') || w.includes('ICU')) cur.icu = r.charge;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => a.ot_mode.localeCompare(b.ot_mode) || a.ot_slot_hours - b.ot_slot_hours);
}
