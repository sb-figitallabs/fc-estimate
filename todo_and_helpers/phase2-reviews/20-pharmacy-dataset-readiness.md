# Review — Pharmacy dataset readiness

**Input reviewed:** `newinps_updated.docx` → "Pharmacy Dataset readiness" tab.
**What this tab decides:** how good the pharmacy data is for the FC Builder. Your framing is endorsed — we don't need a perfect universal formulary; we need strong historical bucket estimation + exact pricing for *expensive* items + a custom-item fallback.

## 1. ✅ Matches / your approach is correct
- **Two capabilities, not one formulary:** (a) routine pharmacy from historical patient-level distributions (already strong), (b) exact selection of implants/biologics/chemo/devices with a current price or a structured custom item. This is exactly the right split.
- Historical bucketing is strong and supports our FC buckets (implants 30.6%, IP drugs 24.4%, OT consumables 21.9%, IP consumables 18.3%, OT drugs 4.8%) — one flat "pharmacy per day" would be wrong.
- Generic/brand grouping is a good foundation (5,385 generics; up to 51 codes per generic) → estimate at the generic/family level, keep brand as a selectable variation to survive brand churn.

## 2. ⚠️ Could worsen currently-verified logic
- **Double-counting is the biggest risk.** If the historical baseline already includes an implant/expensive drug and staff then add a selected item on top, the bill is overestimated. The Builder must use two modes: *no item selected* → full historical distribution; *specific implant/drug selected* → baseline **excluding that item/family**, then add the selected item (e.g. "routine TKR pharmacy excluding implants" + ₹1.40L implant — never ₹1.40L on top of a total that already contains the median implant).
- **Don't silently present a historical unit rate as the current price** of a manually selected item. Current fallback (sale rate → MRP → historical) is fine for repricing cohorts, but for a *material selected item* it must be labelled and ideally require a source date + confirmation. Pharmacy fallback share should **block readiness** for material items (it currently doesn't).
- The static item map is weak (only 1,605 implants marked vs ~3,209 in history; 9,649 defaulted to `ip_drugs`) — use the stronger historical line classification, and remember IP-vs-OT is a *context*, not an item property.

## 3. ⛔ Blocked / data work
- **6,132 of 11,254 identities have no current catalog price** (implants only 32% priced by value). Prioritise current prices for implants/devices/chemo/high-value injectables (≥₹10k items ≈ 47% of pharmacy value but only ~41% priced). **(N3)**
- **No UOM field** — a price without a billing unit (vial/amp/tab/kit/stent) is unsafe for exact selection. Add UOM + specification.
- Build a **curated selectable-item contract** (`v_pharmacy_fc_selectable_items`) of only active, materially-priced items — staff must not search 11k items for tablets/syringes; and a governed **custom-item** workflow (structured fields, estimate-scoped, not auto-promoted to master; a custom item must not default to "excluded"/"patient-payable" just because it's missing).

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**We already have a double-count guard for named high-cost drugs.** The P3 named-drug path (`ai/namedDrug.js` + `buildEstimate.js`) prices a named high-cost drug (MRP × qty) and **replaces** the cohort pharmacy figure via a `max()` — the comment states "chemo/immunotherapy never double-count"; grouped add-ons are likewise taken "net of selected child add-ons". So the *replace-don't-add* mechanism exists — but it's currently gated to specific families (`P3_NAMED_DRUG_FAMILIES`). The manager's guidance **generalises** this to implants/devices across families — an extension of a mechanism we already have, not a new fix.
Still to do (per-topic): confirm the same exclude-then-add applies when an **implant** is selected (not just drugs); reconcile cleaned bucket total vs legacy `net_pharmacy_amount`.
