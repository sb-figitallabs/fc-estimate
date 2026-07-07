/**
 * Advanced controls: OT-consumables shortlist + applied value, implant hierarchy
 * (BUILD_SPEC §3e/§3g, docs 09/17).
 */
import { round2 } from './stats.js';

/** OT-consumables shortlist from pharmacy stats + classification (eligibility per §3e). */
export function buildOtConsumableShortlist(pharmacyStats, pharmMappingByCode, {
  maxCount = 10, cumulativeTarget = 0.80, presenceCeiling = 70,
} = {}) {
  const eligible = pharmacyStats.filter((r) => {
    const m = pharmMappingByCode.get(r.item_code);
    if (!m) return false;
    if (!/treatment supplies/i.test(m.classification || '')) return false;
    const inOt = m.present_in_ot_pharmacy === true || String(m.present_in_ot_pharmacy) === 'true' || m.present_in_ot_pharmacy === 't';
    if (!inOt) return false;
    return (r.case_presence_rate ?? 0) < presenceCeiling;
  });
  const contribution = (r) => {
    const qty = r.ot_quantity_typical ?? 0;
    const rate = qty > 0 ? (r.ot_amount_typical ?? 0) / qty : 0;
    return (round2(r.case_presence_rate ?? 0)) * qty * rate / 100;
  };
  const ranked = eligible
    .map((r) => ({ ...r, expected_contribution: contribution(r) }))
    .filter((r) => r.expected_contribution > 0)
    .sort((a, b) => b.expected_contribution - a.expected_contribution ||
      (b.case_presence_rate ?? 0) - (a.case_presence_rate ?? 0) ||
      (b.ot_amount_typical ?? 0) - (a.ot_amount_typical ?? 0) ||
      (a.item_name || '').localeCompare(b.item_name || ''));
  const total = ranked.reduce((t, r) => t + r.expected_contribution, 0);
  const shortlist = [];
  let running = 0;
  for (const r of ranked) {
    if (shortlist.length >= maxCount || (total > 0 && running / total >= cumulativeTarget)) break;
    running += r.expected_contribution;
    shortlist.push({ ...r, cumulative_share: total > 0 ? running / total : 0, selected: 'Exclude' });
  }
  return shortlist;
}

/** Applied OT-consumables value from shortlist selection (piecewise thresholds). */
export function otConsumablesApplied(shortlist, basisRow) {
  const included = shortlist.filter((r) => r.selected === 'Include');
  if (!included.length) return basisRow.ot_consumables_p50 ?? 0;
  const total = shortlist.reduce((t, r) => t + r.expected_contribution, 0);
  const share = total > 0 ? included.reduce((t, r) => t + r.expected_contribution, 0) / total : 0;
  if (share <= 0.30) return basisRow.ot_consumables_p25 ?? 0;
  if (share <= 0.50) return basisRow.ot_consumables_p50 ?? 0;
  return basisRow.ot_consumables_p75 ?? 0;
}

export const IMPLANT_PROFILES = {
  knee: {
    order: [
      'Femoral Component', 'Tibial Insert / Bearing', 'Bone Cement', 'Tibial Baseplate',
      'Stem / Extension', 'Screw', 'Pin',
    ],
    brands: ['ATTUNE', 'TRIATHLON', 'RESTORIS MCK', 'SIMPLEX', 'SMARTSET'],
    classify(s) {
      if (/BONE CEMENT|SIMPLEX|SMARTSET|CEMENT\b(?!ED)/.test(s) && !/FEMORAL|TIBIA|STEM|SCREW|PIN|INSERT/.test(s)) return 'Bone Cement';
      if (/FEMORAL|FEM CEMENT|FEMORAL COMPONENT/.test(s)) return 'Femoral Component';
      if (/TIBIAL INSERT|TIBIAL BEARING|BEARING INSERT|ONLAY TIBIAL INSERT/.test(s)) return 'Tibial Insert / Bearing';
      if (/TIBIAL BASE|BASEPLATE|TIBIA BP|BEARING TIBIAL BASE|TIB BASE/.test(s)) return 'Tibial Baseplate';
      if (/STEM/.test(s)) return 'Stem / Extension';
      if (/SCREW/.test(s)) return 'Screw';
      if (/\bPIN\b|DRILL PIN|BONE PIN/.test(s)) return 'Pin';
      return null;
    },
  },
  hip: {
    order: [
      'Femoral Stem', 'Acetabular Shell / Cup', 'Acetabular Insert / Liner', 'Femoral Head',
      'Bone Cement', 'Screw', 'Pin',
    ],
    brands: ['TRIDENT', 'PINNACLE', 'V40', 'EXETER', 'ACCOLADE', 'CORAIL', 'SUMMIT', 'SIMPLEX', 'SMARTSET'],
    classify(s) {
      if (/CEMENT RESTRICTOR/.test(s)) return 'Bone Cement';
      if (/BONE CEMENT|SIMPLEX|SMARTSET|CEMENT\b(?!ED)/.test(s) && !/FEMORAL|STEM|SCREW|PIN|INSERT|SHELL|CUP|HEAD/.test(s)) return 'Bone Cement';
      if (/FEM(ORAL)? HEAD|\bHEAD\b.*(MM|\+)/.test(s)) return 'Femoral Head';
      if (/SHELL|CUP\b|HEMI HA|BIPOLAR/.test(s)) return 'Acetabular Shell / Cup';
      if (/INSERT|LINER/.test(s)) return 'Acetabular Insert / Liner';
      if (/STEM|EXETER|ACCOLADE|CORAIL|SUMMIT/.test(s)) return 'Femoral Stem';
      if (/SCREW/.test(s)) return 'Screw';
      if (/\bPIN\b|DRILL PIN|BONE PIN/.test(s)) return 'Pin';
      return null;
    },
  },
};

export const IMPLANT_FAMILY_ORDER = IMPLANT_PROFILES.knee.order; // back-compat

/** Classify an implant item name into family (profile-specific keyword heuristic). */
export function implantFamilyOf(name, profile = 'knee') {
  const p = IMPLANT_PROFILES[profile] || IMPLANT_PROFILES.knee;
  return p.classify((name || '').toUpperCase());
}

/** Extract brand family from an implant item name. */
export function implantBrandOf(name, family, profile = 'knee') {
  const s = (name || '').toUpperCase();
  const p = IMPLANT_PROFILES[profile] || IMPLANT_PROFILES.knee;
  for (const b of p.brands) {
    if (s.includes(b)) return b;
  }
  if (family === 'Screw' || family === 'Pin') return 'Accessory Hardware';
  return 'Other';
}

/**
 * Implant hierarchy (family → brand → item) from cohort pharmacy lines.
 * Quartiles across admissions where the level is present.
 */
export function buildImplantHierarchy(cohortRows, pharmMappingByCode, profile = 'knee') {
  const { quartilesInclusive } = statsRef;
  const famAdm = new Map(); // family -> Map(admission -> {qty, amounts:[rate...]})
  const brandAdm = new Map(); // family|brand
  const itemAdm = new Map(); // code -> per-admission
  const itemMeta = new Map();
  const n = cohortRows.length;

  for (const adm of cohortRows) {
    const items = adm.cleaned_pharmacy?.items || [];
    for (const it of items) {
      const m = pharmMappingByCode.get(it.item_code);
      if (!m || !/implant/i.test(m.fc_estimate_bucket || '')) continue;
      const name = it.item_name || m.item_name;
      const family = implantFamilyOf(name, profile);
      if (!family) continue;
      const brand = implantBrandOf(name, family, profile);
      const qty = Number(it.raw_quantity ?? 0), rate = Number(it.sale_rate ?? 0);
      const upd = (map, key) => {
        if (!map.has(key)) map.set(key, new Map());
        const per = map.get(key);
        const cur = per.get(adm.admission_no) || { qty: 0, rates: [] };
        cur.qty += qty;
        cur.rates.push(rate);
        per.set(adm.admission_no, cur);
      };
      upd(famAdm, family);
      upd(brandAdm, `${family}|${brand}`);
      upd(itemAdm, it.item_code);
      if (!itemMeta.has(it.item_code)) {
        itemMeta.set(it.item_code, { name, family, brand });
      }
    }
  }

  const level = (map) => [...map.entries()].map(([key, per]) => {
    const qtys = [...per.values()].map((x) => x.qty);
    const rates = [...per.values()].flatMap((x) => x.rates);
    const qq = quartilesInclusive(qtys), rq = quartilesInclusive(rates);
    return {
      key, presence_rate: n ? round2((per.size / n) * 100) : 0,
      distinct_ip_count: per.size,
      quantity_p25: qq.p25, quantity_p50: qq.p50, quantity_p75: qq.p75,
      rate_p25: rq.p25, rate_p50: rq.p50, rate_p75: rq.p75,
      amount_p50: qq.p50 * rq.p50,
    };
  });

  const order = (IMPLANT_PROFILES[profile] || IMPLANT_PROFILES.knee).order;
  const familySort = (a, b) => {
    const ia = order.indexOf(a.key.split('|')[0]);
    const ib = order.indexOf(b.key.split('|')[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.key.localeCompare(b.key);
  };
  return {
    families: level(famAdm).sort(familySort),
    brands: level(brandAdm).sort(familySort).map((b) => ({
      ...b, family: b.key.split('|')[0], brand: b.key.split('|')[1],
    })),
    items: level(itemAdm).map((i) => ({ ...i, ...itemMeta.get(i.key), code: i.key }))
      .sort((a, b) => familySort({ key: a.family }, { key: b.family }) || a.code.localeCompare(b.code)),
  };
}

/** Resolve implant estimate per Implant Selection controls. */
export function resolveImplantEstimate(controls, hierarchy, basisRow) {
  const dflt = basisRow.implants_p50 ?? 0;
  const { mode = 'Default P50', family = 'All', brand = 'All', itemCode = 'None' } = controls || {};
  const famVal = () => hierarchy.families.find((f) => f.key === family)?.amount_p50 ?? dflt;
  const brandVal = () => hierarchy.brands.find((b) => b.key === `${family}|${brand}`)?.amount_p50 ?? famVal();
  if (mode === 'Family Override') return famVal();
  if (mode === 'Brand Override') return brandVal();
  if (mode === 'Exact Item Override') {
    return hierarchy.items.find((i) => i.code === itemCode)?.amount_p50 ?? brandVal();
  }
  return dflt;
}

// deferred import to avoid circular
import * as statsRef from './stats.js';
