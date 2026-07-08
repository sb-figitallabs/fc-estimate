# Data concerns register — fc-builder-api dataset (2026-07-08)

Everything here is a **data** problem (source workbook / package master / tariff rates), not an engine bug.
Engine status at time of writing: cash parity 1042/0 · insurance edge suite 32/32 · normal suite 52/52.
Evidence: `backend-node/test_results/normal_suite_results.json`, `PACKAGE_TESTING_REFERENCE.xlsx`, `PACKAGE_AMOUNT_FLAGS.csv`.

---

## D-1 · Placeholder package amounts (₹1/₹10) — 38 packages

**7 are marked READY (`can_generate_estimate = true`) so they CAN surface in estimates:**

| Tariff | Code | Name | Amount |
|---|---|---|---|
| TR1 | ORT0034 | TOTAL HIP REPLACEMENT - UNILATERAL - COP | ₹10 |
| TR1 | ORT5010 | TOTAL HIP REPLACEMENT - UNILATERAL - MOP | ₹10 |
| TR1 | ORT5792 | THR - UNILATERAL - COP - ROBOTIC PKG | ₹10 |
| TR1 | ORT5793 | THR - UNILATERAL - MOP - ROBOTIC PKG | ₹10 |
| TR1 | URO5577 | DJ STENT REMOVAL (DAYCARE) | ₹10 |
| TR1 | VAS0240 | AV FISTULA | ₹10 |
| TR1 | VAS86 | AMPUTATION MAJOR | ₹10 |

All four cash THR packages are placeholders — a THR-cash side-by-side would show "package ₹10". (Auto-detect currently dodges them only because the cohort-dominant code resolves elsewhere.)
The remaining **31** (₹1: hepaticojejunostomy, ileostomy closure, varicose-glue; ₹10: hernias, hysteroscopy, LSCS-emergency, TURP-laser, nephrectomies, etc.) are blocked by `can_generate_estimate = false` so they can't leak into estimates. Full list: `PACKAGE_AMOUNT_FLAGS.csv`.

**Ask:** real amounts for the 7 ready ones first.

## D-2 · Duplicate inclusion-text variants with differing content — 11 cash packages

`inclusions_text` contains the inclusion list **twice** (two source versions concatenated), and the two variants are NOT identical — e.g. ORT5535 (Robotic TKR-R) carries two lists with differing rates; CAR5154 (PTCA) carries **4** variants:

`CAR5154` (×4) · `GYN5219` LSCS · `GYN5324` normal delivery · `NEP0015`/`NEP0055` KTU · `ORT5510` TKR-L · `ORT5535` robotic TKR-R · `SGA0128` sleeve gastrectomy · `SGA5886` femoral hernioplasty · `URO0018` cystoscopy · `URO5577` DJ stent removal — all TR1.

Engine currently uses variant 1 and exposes the rest behind the "view 2nd source" toggle. **Ask:** which variant is authoritative per package.

## D-3 · Junk / unusable inclusion texts — 4 cash packages

| Code | Problem |
|---|---|
| TR1 ENT5103 | text is bare numbers: `10823.925 / 12156.875 / 14800 / 18700` (looks like room-wise rates pasted into the inclusions column) |
| TR1 ENT5145 | same: `7748.6 / 8490.6 / 10200 / 12540` |
| TR1 ENT5147 | same: `6148` |
| TR1 PHY5137 | half-formed table (`QTY | QTY … MEDICAL RECORDS-` truncated) |

These fall back to "payable pending review" for every line item. **Ask:** re-curate.

## D-4 · Package naming inconsistent across tariffs → family mapping misses

Same `package_code` has different names per tariff; name-based family mapping fails where the qualifier is missing:

- `CAR5154` is "CORONARY ANGIOPLASTY (PTCA) - SINGLE VESSEL" on TR201/TR285/TR289 (maps to family ✓) but "PTCA (PERCUTANEOUS TRANSLUMINAL CORONARY ANGIOPLASTY)" on TR1/TR287/TR288/TR290 (**no family match by name**).
- TR288 truncates names mid-word ("…CORONARY ANGIOPLAS").

Runtime estimates are unaffected (family resolves via cohort-dominant package code), but **catalog listings undercount** — this is why the earlier testing sheet initially missed the GIPSA PTCA package. **Ask:** canonical names per package_code, or we key mapping on code only.

## D-5 · `package_organization_applicability` gaps

- **TR290 (GIPSA): ORG1063 (NATIONAL INSURANCE) missing from applicability for all 109 packages** — the other 4 PSU orgs are present. Engine works via tariff fallback, but the applicability table contradicts the tariff mapping.
- TR1: 15 insurer orgs are mapped to the KIMS tariff (no negotiated tariff of their own) but appear in no package applicability rows — probably intended (cash packages are org-blank), worth confirming.

## D-6 · Missing negotiated packages (confirm contract vs data gap)

- **Star Health (TR287) has zero LSCS/maternity packages** while every other major tariff (TR201/TR285/TR288/TR290) has them. Maternity exclusion in Star's contract, or missing rows?
- Robotic TKR has **no insurer package on any tariff** (cash TR1 only) — believed to be reality (insurers pay conventional TKR rates), noted for completeness.
- No corporate packages exist at all (16 corporate orgs settle itemized) — believed intended.

## D-7 · Package rate ABOVE cohort itemized estimate — 24 combinations (normal-suite flags)

The side-by-side shows "with package" costing MORE than the itemized estimate in these combos. The engine reports honestly; the question is whether the underlying amounts are right.

**Cash (package + implant extras vs cohort itemized, Typical/Single):**

| Family | Package | With pkg | Itemized |
|---|---|---|---|
| TKR bilateral | ₹4,90,000 | ₹5,79,534 (Twin) | ₹5,74,206 |
| Robotic TKR bilateral | ₹6,90,000 | ₹9,00,219 | ₹8,11,138 |
| PTCA | ₹1,50,000 | ₹1,90,880 | ₹1,82,027 |
| Lap chole | ₹96,000 | ₹1,88,734 | ₹1,74,926 |
| LSCS | ₹90,000 | ₹1,25,941 | ₹1,12,259 |

Plausible cause: list-price package + implants-at-actuals vs cohort average spend; or the curated inclusion parse is missing items that the package really covers (lap chole extras ₹92k look heavy). **Ask:** verify these package amounts & inclusion completeness.

**Insurance (negotiated package alone ≥ itemized insurance-tariff estimate):**

| Combo | Package | Itemized |
|---|---|---|
| PTCA · Aditya Birla (TR285) | ₹1,93,100 | ₹1,34,737 |
| PTCA · GIPSA (TR290) | ₹1,30,200 | ₹1,30,113 |
| Lap chole · Star (TR287) | ₹1,14,909 | **₹48,307** ← itemized suspiciously low; Star tariff line rates worth auditing |
| THR · Star | ₹1,68,698 | ₹2,70,323 itemized but with-pkg ₹3,64,939 (extras heavy) |
| LSCS · GIPSA / ICICI | ₹77,000 / ₹70,000 | ₹54,230 / ₹41,470 |
| CAG daycare · Star | ₹28,875 | ₹19,109 |

Likely semantics rather than error: **for package-bound insurers the negotiated package rate is authoritative and the cohort itemized underestimates** (insurance pricing mode zeroes PF/drug-admin; historical insurance bills were themselves package-priced). **Decision needed:** should the UI mark the package route as "insurer-binding" for these combos instead of presenting both as alternatives?

## D-8 · Organization / tariff mapping noise

- **15 of 68 orgs** have no admission history AND no packages (pure mapping-table rows) — already hidden from the UI dropdown.
- **5 orgs appear under two payor buckets** in history (ORG53/54/56 GIPSA+Corporate, ORG1199/1249 Non-GIPSA+Corporate) — small corporate admission counts under insurer orgs; believed real, worth a glance.
- 1 admission in `mart.main_table` has Corporate bucket but blank organization_cd.

## D-9 · Open semantics questions (need manager ruling)

1. **Daycare + room-rent cap:** engine applies no deduction (no ward days) — confirm daycare claims are cap-exempt under IRDAI rules.
2. **Category-clause packages have no stay-day limit encoded** ("beyond package days at actuals" can't be computed for insurance packages) — needs curated day counts if wanted.
3. Paise drift ₹0.01–0.02 between settlement check fields (display rounding; exact fields used internally).

---

### Priority suggestion for the cleanup session
1. D-1 ready placeholders (visible wrong numbers) → 2. D-7 amount verification (wrong economics) → 3. D-2 variant arbitration → 4. D-4 naming (catalog correctness) → 5. D-3/D-5/D-6 (hygiene) → 6. D-9 rulings.
