# Review — Non-pharmacy items grouping / classification

**Input reviewed:** `newinps_updated2.docx` → "Non-Pharmacy Items grouping review" tab (service-item bucketing).
**What this tab decides:** whether our service classification/grouping is right for the Builder. Verdict: the **historical** mapping is reliable; the **clean DB view is not yet safe to cut over to**.

## 1. ✅ Safe / keep for now
- Historical service bucketing is broadly reliable: **1,634/1,639 codes mapped** (5 missing = F&B, ₹1,315 total); **97.52%** broadly correct after stripping legacy labels. Retain the detailed mapping for historical calculations.

## 2. ⚠️ Could worsen currently-verified logic
- **Do NOT cut the Builder over to `fc_clean.v_item_fc_bucket_map`** — it's structurally incomplete: **304 historically-used codes absent (₹63.13 cr, mostly professional/provider), 1,017 likely bucket mismatches (₹68.67 cr), 95 conflicting buckets.** The historical totals stay right only if we keep the detailed map.
- **"Remove"/"Needed" workflow labels are embedded in 452 bucket names** — these are template-actions, not categories; must become a separate field or they corrupt classification.
- `rate_domain` (service vs investigation) must stay *evidence* only — 10,431/14,753 codes appear under both domains; it must not decide canonical identity.

## 3. ⛔ High-confidence regroupings + model (N11)
- **Blood Bank** out of Investigations (30 codes, ₹2.77 cr) — needs unit/reservation/issue/revoke logic (see Blood Bank tab, file 17).
- **Intensivist / assistant-intensivist** out of Room → **Professional Fees → Critical Care Consultant** (₹3.28 cr); collectibility is a separate payer overlay (ties DNB, file 05).
- **Split "Emergency"** into its real buckets (bed→Accommodation, transfusion→Blood Bank, OT→Procedure Facility, MLC→Administrative, physician→PF) + store emergency as a care-setting modifier.
- Physiotherapy sessions → Therapy & Rehab; physio **consultation** → PF. F&B → explicit-exclude from the core estimate.
- **Adopt the multi-dimension model** (primary bucket · clinical subgroup · charge basis · care setting · estimate behaviour · professional role · provider identity · package behaviour · payer behaviour) — not one flat category. Rebuild `v_item_fc_bucket_map` one row per code, recalc all 13,974 admissions, verify total value unchanged, then cut over.

## 4. Validation — to run
Confirm our engine reads service buckets from the **detailed historical mapping** (not the incomplete clean view); check our blood-bank / intensivist / emergency grouping matches the regroupings above.
