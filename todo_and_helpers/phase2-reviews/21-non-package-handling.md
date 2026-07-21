# Review — Non-package handling

**Input reviewed:** `newinps_updated.docx` → "Non-Pkg Handling" tab (audit of all non-package IPs).
**What this tab decides:** how good our non-package data + mapping is, and how the Builder should use it. Verdict: the **financial** data is strong; the **exact treatment / multi-treatment mappings are over-confident** and must not be used unchanged.

## 1. ✅ Strong / production-ready
- **Cohort + payer + bill are solid:** 9,751 clearly-identifiable strict non-package admissions; payer→tariff routing is clean (no GIPSA outside TR290, no Non-GIPSA on TR290, none missing org/payer/tariff); LOS/ward/ICU/doctor/department ~100%; reconstructed bill positive for all, 96.2% reconcile to service+cleaned-pharmacy within 1%.
- Use `services_json` + `cleaned_pharmacy_net_jsonb` + `fc_actual_bucket_totals_jsonb` + `fc_actual_total_excluding_fnb_and_returns`; **do not** use legacy `service_net_amount` (zero across this cohort).
- Enough pooled history for most major concepts (medical 91.8%, procedure 82.8% at ≥15 cases).

## 2. ⚠️ Could worsen currently-verified logic — the real cautions
- **Surgery-master mapping is materially contaminated.** All 4,149 procedure admissions are labelled `CLEAR_SINGLE`/`CLEAR_MULTIPLE`, but 3,435 of 3,438 primary-code mappings have **no bill confirmation**; **~42% (1,754)** carry an obvious sentinel mis-map (e.g. "100 MCI THERAPY DOSE" across 32 departments; an ortho case mapped to 7 cross-specialty procedures). If our engine trusts these for treatment-level cohorts, estimates can be wrong → **downgrade confidence; rebuild OT-booking evidence selection before treatment-level production.**
- **Single-vs-multiple treatment is not production-ready.** 699 of 756 "multi" collapse to fewer concepts on curation; combos auto-set `clinically_valid = true` for any observed code combination (not real validation). All 756 need component confirmation before powering combination estimates. (Ties to our multi-treatment / combo work — don't publish combos off this flag.)
- **Insurance-procedure reconstructed totals run ~10% below reported final** (GIPSA procedure only 45% within 10%, Non-GIPSA 42.5%), correlating with PF. Use reconstruction for *composition*, reported final for *calibration*; **do not** apply a blanket 10% uplift.
- **Historical FC estimate amounts are evidence, not templates** (within ±20% only ~25–30% medical / 33–58% procedure) — never copy the old entered estimate.
- 420 `package_intended_but_open_billed` and 39 package-flag-no-bill conflicts must be kept **separate**, not blended into ordinary non-package cohorts.

## 3. ⛔ Blocked / new work (N8)
- Rebuild surgery-master evidence selection; revalidate the 756 multi-treatment admissions; replace automatic combo validity with component verification; promote the 167 curated medical concepts into a governed medical master (current master is mostly department-level labels); add a hierarchical cohort fallback (exact concept+payer+setting → concept across payers repriced → clinical family+payer → archetype+payer → broad, lower confidence) since exact concept+payer ≥15 covers only 77% medical / 49% procedure.
- Adopt the structured classification (separate `actual_billing_mode` / `clinical_treatment_mode` / `performed_status` / `mapping_confidence`); separate medical/surgical *billing* class from clinical *procedure* modality.

## 4. Validation we'll run first
Reproduce the contamination screen on our mart (the 5 sentinel mappings, the 1,754 count), the reconstruction-vs-final bands by payer, and the payer-specific ≥15 coverage — then gate treatment-level cohorts on cleaned mappings.
