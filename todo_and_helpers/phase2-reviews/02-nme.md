# Review file T2 — NME (Non-Medical Expenses) estimator

**Input reviewed:** `NME_inp.pdf` (hospital NME list + Codex hybrid-estimator design) — checked against our current engine.

## 1. Headline agreement
The doc's core verdict matches our own 17-Jul findings: flat ₹5k/₹10k counsellor defaults are bad (11–24% open-insurance within ±25%; 0.3–2% for packages). The **hybrid estimator** (policy rules classify each item → historical profiles give the range → treatment-specific items adjust) is sound and we endorse it.

## 2. What we have today (so you know the delta)
Our insurance settlement already shows an NME line in the patient split, but it is **history-derived only** (cohort NME behaviour) with no item-level rule layer, no package-inclusion cross-check, and no zero-inflated display logic. The new design replaces this with: routine subtotal (per-day items × LOS) + planned treatment-specific NME (instruments/laser/splints by treatment) + conditional historical reserve (residual distribution), displayed by positive-probability bands, rounded to ₹500/₹1,000.

## 3. Additive pieces we propose to implement as spec'd
- Item-rule table (code, category, payer applicability, package-inclusion condition, patient-payable/DNB flags, unit, tariff source, effective dates) + aliases.
- Payer classification: every charge → covered / patient-NME / DNB / conditional — BEFORE amount estimation. GIPSA instrument = NME; Non-GIPSA instrument = billable-not-collected (DNB if denied); Cash = no separate NME concept (fold into estimate).
- Historical profiles with the 5-level specificity ladder (exact treatment+org+package+LOS+ICU → … → global payer route), min-sample 30/15 blend rules, 18–24-month recency.
- Zero-inflated display: ≥70% positive ⇒ "₹P25–P80"; 30–69% ⇒ "₹0–P80 (may apply…)"; <30% ⇒ "possible up to ₹P75"; mandatory items (laser, GIPSA instruments) added explicitly regardless.
- Multi-treatment NME de-dup (records once, per-day items once per stay day, union disposables, treatment-specific items separately).
- ICU-day-sensitive daily portion; fixed items never multiplied by LOS.
- Data-quality guards (drop 27 negative-NME records, cap at treatment P99, NME ≤ final bill, HIMS NME Amount as truth, never train Cash with insurance).

## 4. ⚠️ Risks / questions before we build

**Question 1 — replacement or augmentation?** The new NME range replaces our current history-only NME in the insurance split. During transition, do you want both shown (new range + old figure as reference) for a validation window, or a clean cut-over?
**Question 2 — schema location.** Same as T1: the doc's contracts live in `fc_curated`/`fc_clean`/`fc_estimate` (your project DB). Confirm where the rule/profile tables live for our runtime, and who seeds `nme_item_rules` initially (we can bootstrap from the doc's list + tariff codes, then you review — recommended).
**Question 3 — Cash display.** Confirmed no separate NME panel for Cash (items already inside the estimate)? Today our Cash preview shows no NME — matches — just confirming no new Cash-side requirement.
**Question 4 — conditional inputs.** The new FC inputs (`is_diabetic`, `diabetic_chart_available`, `cross_consultation_expected`, `package_includes_preoperative_screening`…) add form friction. We propose collapsing them into an optional "NME details" disclosure with smart defaults (conditional reserve covers the unknowns). OK?
**Phase plan** per the doc: Phase-1 (profiles by treatment/payer/package/LOS/ICU + family fallback) ships first and already beats the flat defaults; Phase-2 adds code-level rules, day-based reconstruction, package-inclusion overrides, residual modelling.

## 5. Validation we will run first
Rebuild the doc's headline tables on OUR (now 17k-admission) data — positive-NME rates and P25–P75 by payer/open-package/LOS-band — and diff against the doc's figures; differences flagged back to you before Phase-1 ships.
