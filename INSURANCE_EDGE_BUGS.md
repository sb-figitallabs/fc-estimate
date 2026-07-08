# Insurance edge-case suite — bugs found & fixed (2026-07-08)

Source: `backend-node/scripts/edge_insurance_suite.mjs` (32 cases) against `POST /api/estimate/build`.
Full numbers per case: `INSURANCE_EDGE_TESTS.pdf` · raw JSON: `backend-node/test_results/insurance_edge_results.json`.

**Verdict: settlement mathematics was sound from the start** — conservation invariant (insurer + patient = gross + upgrade-excess), cover ceilings, copay, sub-limit, top-up and proportionate-deduction math held on every settleable case. The 3 bugs found were all at the *edges around* the engine. **All 3 are now fixed** — final run: 32/32 pass, 0 warnings; regression: cash parity 1042/0, insurance sanity 24/24, family sanity 12/12.

---

## BUG-1 · HIGH — full room names silently zeroed the settlement ✅ FIXED

**Was:** `room_type` was used raw as the key into the per-room amount maps `selected{general,twin,single}`. `"Twin Sharing"` / `"General Ward"` / `"DELUXE"` (values the schema comment itself documented!) made the estimate silently price at **Single** rates and the settlement return **insurer ₹0 / patient ₹0** with no warning; coverage extras also read ₹0, faking a perfect package total. Failing cases T25/T31/T32.

**Fix (two layers):**
- `estimate.routes.js` — `room_type` is normalized in the zod schema (`/twin/→Twin`, `/general|ward/→General`, `/single|deluxe|suite/→Single`); anything unrecognizable is rejected with a 400.
- `settlement.js` — defense-in-depth guard: if the estimate total is > 0 but no line item resolves an amount for the room key, `settle()` returns an explicit error instead of an all-zero settlement.

## BUG-2 · HIGH — insurance package inclusion texts unparseable → inflated "with package" totals ✅ FIXED

**Was:** `parseCoverage()` only understood the curated `new2` bullet format. **100% of GIPSA (108) and non-GIPSA (199) inclusion texts** yielded zero coverage signal, so every line item stayed payable at full price and *with package* (₹5,30,293) exceeded *without package* (₹3,80,393) on GIPSA THR — 24 of 32 cases warned.

**Fix:** added a **category-clause mode** to `coverage.js`, used only when the itemized curated parse finds no signal:
- Extracts included categories (room / nursing / pf / ot / pharmacy / investigations / bedside) from clause texts — GIPSA `L1: Standard inclusions - …`, TR201 `A: Inclusions - …`, TR285 pipe-lists, TR287 prose. Requires ≥3 category keywords so a stray word can't flip everything to "included".
- Stay-based texts (`"3 days hospital stay | Four ECGs | Cardiology consultations"`) are treated as **comprehensive** end-to-end rates (all categories included) — standard TPA package semantics.
- **Implants are never category-included**: they ride the exclusion text (`L2: Implants…`, `Implants Extra`, …) or stay payable when the text is silent. Exclusion splitting now also handles pipe-separated lists.
- Optional add-ons stay payable; the parse block now reports `mode: 'category-clause' | 'itemized-curated'` + the matched categories.

**Result:** GIPSA THR now reads *with package* **₹3,46,140** = package ₹1,49,900 + implants ₹1,96,240 payable extra < without ₹3,80,393 ✓. Parse coverage: GIPSA **108/108**, non-GIPSA **199/199**, cash unchanged where curated docs exist (76 itemized; parity suite still 1042/0).

**Known-honest oddity, not a bug:** TR285 PTCA shows with-package ₹2.34L > itemized ₹1.35L because Aditya Birla's *negotiated package rate itself* (₹1,93,100) exceeds our cohort estimate — the comparison faithfully reports it.

## BUG-3 · MEDIUM — zod validation errors returned HTTP 500 ✅ FIXED

**Was:** `EstimateInput.parse()` failures fell through the generic error middleware as `500` with a raw zod issue dump (T29/T30).

**Fix:** `src/index.js` error middleware maps `ZodError → 400` with compact `field: message` details. T29/T30 now get `400 {"error":"Invalid input","details":["insurance.base_sum_insured: Too small…"]}`.

---

## Residual data gaps (manager to fix — not engine issues)

- **4 cash packages** have junk inclusion text (bare number lists): TR1 `ENT5103`, `ENT5145`, `ENT5147`, `PHY5137` — need curation.
- 38 placeholder package amounts (₹1/₹10) previously flagged in `PACKAGE_AMOUNT_FLAGS.csv` still stand.

## Observations (for awareness)

- **O-1 · Paise drift:** `check.insurer_plus_patient` vs `gross_plus_upgrade` can differ by ₹0.01–0.02 (row-level display rounding). Within tolerance.
- **O-2 · T12 copay 100%** behaves sanely (insurer ₹0, patient everything).
- **O-3 · T21 SI ₹0** yields insurer ₹0 / patient full bill labelled `beyond cover` — UI could add a "policy has no available cover" warning.
- **O-4 · Daycare + room cap (T27):** no ward days → no deduction, copay only. Confirm with manager that daycare claims should be cap-exempt (IRDAI daycare has no room-rent component).
- **O-5 · Top-up cases (T22/T23)** matched hand-computed IRDAI expectations exactly.
- **O-6 · Category-clause granularity:** clause packages don't encode stay-day limits, so beyond-package-days extras aren't computed for them (curated `new2`-style docs would enable that). Acceptable v1.
