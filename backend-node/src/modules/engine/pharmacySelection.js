import { query } from '../../db/pool.js';

/**
 * Pharmacy item selection — doc T20, manager 21-Jul.
 *
 * Two capabilities, not one formulary: routine pharmacy stays as the existing
 * historical distribution (the manager: "our current show-high-contributing-
 * items method works fine — don't overcomplicate"); THIS module handles the
 * second capability — EXACT selection of a specific high-value item (implant /
 * biologic / chemo / device) with a SOURCE-MAPPED price.
 *
 * Manager's rules:
 *   - When the FC selects a specific item, provide the rate WITH its source
 *     (catalog sale rate → MRP → historic P50), flagged; never silently present
 *     a historical unit rate as the current price.
 *   - If no rate exists, the user enters their own amount (source = user).
 *   - Historic P50 is a valid fallback WITH A FLAG.
 *   - UOM comes from the catalog (a dropdown for manual selection); a price
 *     without a billing unit is unsafe.
 *   - A custom item must NOT default to "excluded"/"patient-payable" just because
 *     it's missing.
 *   - Double-count: a selected item REPLACES its family's share of the baseline
 *     (never added on top). Our replace-don't-add guard already exists for named
 *     high-cost drugs (P3 named-drug path); this flags the same for implants/
 *     devices (`replace_family_baseline`).
 *
 * Additive: attached as estimate.pharmacy_selections; base estimate unchanged.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function resolveItem(sel) {
  const code = String(sel.item_code || '').toUpperCase();
  const qty = Math.max(1, Number(sel.quantity) || 1);

  // user-entered amount always wins (custom / no catalog price)
  if (sel.user_amount != null && Number(sel.user_amount) > 0) {
    return { code: code || null, name: sel.name || code || 'Custom item', qty, uom: sel.uom || null,
      unit_rate: round2(sel.user_amount), amount: round2(Number(sel.user_amount) * qty),
      rate_source: 'user_entered', source_date: sel.source_date || null, custom: !code, status: 'priced' };
  }

  let cat = null;
  if (code) {
    const { rows } = await query(
      `SELECT item_name, generic_name, uom, mrp::numeric mrp, sale_rate::numeric sale_rate,
              mrp_populated, sale_rate_populated, source_table, source_priority,
              (SELECT fc_estimate_bucket FROM fc.pharmacy_item_mapping m WHERE m.item_code = r.item_code LIMIT 1) AS bucket
         FROM fc.pharmacy_catalog_rate_reference r WHERE r.item_code = $1 LIMIT 1`, [code]);
    cat = rows[0] || null;
  }

  // catalog sale rate → MRP
  if (cat && cat.sale_rate_populated && Number(cat.sale_rate) > 0) {
    return mk(code, cat.item_name || sel.name, qty, cat.uom, cat.sale_rate, 'catalog_sale_rate', cat.source_table, cat.bucket);
  }
  if (cat && cat.mrp_populated && Number(cat.mrp) > 0) {
    return mk(code, cat.item_name || sel.name, qty, cat.uom, cat.mrp, 'catalog_mrp', cat.source_table, cat.bucket);
  }

  // historic P50 fallback (flagged) — what this item actually billed
  if (code) {
    const { rows } = await query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY billed_amount) AS p50, count(*)::int n
         FROM fc.package_bill_lines WHERE service_cd = $1 AND billed_amount > 1`, [code]);
    if (rows[0]?.p50 != null) {
      const r = mk(code, cat?.item_name || sel.name, qty, cat?.uom || sel.uom, rows[0].p50, 'historic_p50', null, cat?.bucket);
      r.flag = `No current catalog price — historic P50 (n=${rows[0].n}). Confirm before use.`;
      return r;
    }
  }

  // no rate anywhere → prompt the user (never a silent zero, never "excluded")
  return { code: code || null, name: cat?.item_name || sel.name || code || 'Custom item', qty,
    uom: cat?.uom || sel.uom || null, unit_rate: null, amount: null,
    rate_source: 'pending_user_entry', status: 'CONTEXT_REQUIRED', bucket: cat?.bucket || null,
    flag: 'No catalog or historic price — enter the amount + UOM (must not default to excluded/patient-payable).' };
}
function mk(code, name, qty, uom, rate, source, sourceTable, bucket) {
  return { code: code || null, name: name || code, qty, uom: uom || null,
    unit_rate: round2(rate), amount: round2(Number(rate) * qty),
    rate_source: source, source_table: sourceTable || null, bucket: bucket || null, status: 'priced' };
}

/**
 * @param {Array<{item_code?:string, name?:string, quantity?:number, user_amount?:number, uom?:string, source_date?:string}>} selections
 * @returns {Promise<null | object>}
 */
export async function buildPharmacySelections(selections) {
  if (!Array.isArray(selections) || !selections.length) return null;   // FC-selected only
  const items = [];
  for (const sel of selections) items.push(await resolveItem(sel));
  const total = round2(items.reduce((t, i) => t + (i.amount || 0), 0));
  return {
    active: true,
    capability: 'exact_high_value_selection',        // routine pharmacy stays the historical distribution
    double_count: 'replace_family_baseline',         // selected item replaces its family's baseline share, never added on top
    items,
    total,                                           // additive — the frontend nets it against the excluded family share
    notes: [
      'Exact selection of high-value items only — routine pharmacy stays the existing historical distribution.',
      'Every rate is source-mapped (catalog sale rate → MRP → historic P50 → user-entered); a historic rate is flagged, never shown as the current price.',
      'Missing items take a user-entered amount + UOM; a custom item is never defaulted to excluded / patient-payable.',
      'A selected item replaces its family share in the baseline (no double-count) — same replace-don’t-add rule as the named-drug path.',
    ],
  };
}
