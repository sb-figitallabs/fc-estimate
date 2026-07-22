# Review — Equipment & manual add-ons

**Input reviewed:** `newinps.docx` → final tab (manual add-on catalogue / equipment, driven by the hospital general-billing DOCX).
**What this tab decides:** a governed manual add-on catalogue (OT/ward/ICU equipment, respiratory support, bedside procedures, transport) with billing basis, valid locations, mutual exclusions and payer admissibility — not a free tariff search.

## 1. ✅ Safe / good architecture — we endorse
- Each add-on defines: display name, service code, **billing basis** (flat / per-event / per-hour / 12h / 24h / per-day / per-shock / per-km / editable), required inputs, **valid locations** (OT/ward/ICU/ER/labour/NICU), mutually-exclusive codes, related-consumable prompts, package classification, payer admissibility, rate source + effective date, historical-use evidence, and whether staff confirmation is mandatory.
- **Four financial columns per line** (expected gross / included-in-package / separately-claimable / expected patient-payable) — the same model as the DNB tab (N1). Prevents "excluded from package", "not covered", and "collect from patient" from being conflated.
- Equipment history drives **staff-confirmed suggestions**, never silent charges. Prevents adding both a generic instrument charge and every procedure-specific instrument; checks package inclusion first.
- Payer nuance is correct: e.g. hospital equipment rental may be payable even when purchase isn't; oxygen masks may be non-payable though oxygen service is billable — so "consumable separately billed" ≠ "separately payable by insurance".

## 2. ⚠️ Could worsen currently-verified logic
- Suggestions must never auto-charge; incompatible half-day/full-day (and generic-vs-specific instrument) selections must be blocked.
- Non-GIPSA must not be one homogeneous rule — resolve organization/MOU → agreement → approved interpretation → historical fallback (labelled empirical).

## 3. ⛔ Blocked — missing masters
- Supply codes/rates before activation: **cradle charge** (baby-warmer must not substitute), arthroscopy major/minor, microscope >3h, NIV duration variants, retropositive charge amount, external PF, hospitality, and other editable/miscellaneous services. **(N3)**
- **MRD appears as a positive charge** in history, not a discount — reconcile before implementing it as a negative amount.

## 4. Recommended priorities (from the tab)
1. Build the add-on catalogue with duration/quantity controls + the four-column separation.
2. Obtain/correct the missing masters above.
3. Add treatment/department/room/LOS-conditioned suggestions (staff-confirmed) + audit warnings for incompatible combinations.
