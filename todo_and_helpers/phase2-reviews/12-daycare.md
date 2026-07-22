# Review — Handling daycare

**Input reviewed:** `newinps.docx` → "Handling Daycare" tab.
**What this tab decides:** keep the existing daycare foundation; daycare is a stay/billing modifier, not a generic estimate — the treatment/drug drives the cost.

## 1. ✅ Safe / keep as-is
- Keep: positive daycare-charge classification (`ROM0010`, rare `RNS0075` — **never both**), the short-stay non-daycare guard (904 sub-24h non-daycare cases correctly excluded), treatment-family defaults, the 15-case cohort gate, and separate package/open routing.
- One generic daycare average is wrong: chemo P50 ₹25.4k vs immunotherapy P50 ₹150.7k vs cystoscopy ₹39.5k — use **exact treatment/regimen cohorts at current tariff**, not a daycare median.

## 2. ⚠️ Could worsen currently-verified logic — the fixes
- **Classifier bug:** `same_day_daycare_style` wrongly includes 119 cases lasting >12h (checks calendar date, not the 12-hour threshold). Add a real `strict_daycare_upto_12h` flag and split statuses: `strict_daycare` / `extended_same_day_daycare` / `daycare_cross_midnight` / `converted_to_inpatient`. Model on the 1,769 strict cases; use the other 185 for extension/conversion evidence.
- **Auto-daycare = a recommendation to confirm**, not silent — don't infer from "infusion / endoscopy / chemoport / Cat 1".
- **DMO excluded** (only 3/1,954 cases), **nursing conditional** (33.9%), never mix package + open-bill daycare histories, don't treat admin `MSC10` as a procedure.
- Add a formal **inpatient-conversion contingency** (retain consumed daycare services + add ward/ICU from the conversion point + apply excess-LOS logic if packaged) rather than continuing daycare logic. Use the 66 cross-midnight cases to model this.
- Oncology previous-cycle history only when **regimen equivalence is confirmed** (median cycle change 10.3% but P75 44.5%) — never copy the previous amount just because the patient had prior chemo.

## 3. ⛔ Blocked / dependent
- Drug/regimen-specific pricing for infusion therapy depends on the Chemo tab's missing drug prices (see file 13).

## 4. Validation we'll run first
Reproduce the 1,954-daycare cohort split (1,769 strict / 119 extended / 66 cross-midnight) and the component-presence table on our data; confirm the classifier fix removes the 119 from strict.
