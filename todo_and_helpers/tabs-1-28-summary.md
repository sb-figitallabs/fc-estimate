# FC Estimate Builder — Tabs 1–28 Review Summary (2026-07-22)

Every tab of the estimate-builder review doc, processed against the manager's inline responses. All work is on the fc-estimate **`dev`** branch, **additive** (no verified-number change — sanity 24/0 + 12/0 on every one). Nothing on `main`.

**Legend:** 🟢 new engine module built · 🔵 validation/confirmation (engine already correct) · 🟡 held for manager decision/call.

| Tab | Title | Verdict | What we did | Key open item |
|----|-------|---------|-------------|---------------|
| 1 | PF | 🟢 (earlier) | Insurance final-bill PF cascade; package PF GIPSA 20% / Non-GIPSA 25% | — |
| 2 | NME | 🟢 | HIMS NME ingested (`fc_nme_source`, `nme_profile`); advisory `estimate.expected_nme` (P50 + probability) | Phase-2 needs open-bill lines (C1); Intl outlier (A4) |
| 3 | Emergency | 🟢 | `estimate.emergency` overlay — ER-physician/assessment/bed, explicit-input-only, OT-E `ACTIVE_POLICY` | ER-physician ₹1,000 (A3); holiday cal / OT data (C2) |
| 4 | Positive cases | 🟢 | `estimate.positive_case` — HBsAg/HCV/HIV/isolation + OT surcharge 50/100%, policy-first | ICU-iso code, MSC2816, RNS0116 (C3) |
| 5 | DNB | 🟢 | Four-value billing-disposition metadata on settlement rows; `fc_hidden` | GIPSA instruments amount-move (A1); ₹1-share needs open-bill (C1/C8) |
| 6 | New Born | 🟢 | `estimate.newborn` — 4 pathways (healthy/well-baby/phototherapy/NICU), explicit-select | Cradle code (C4) |
| 7 | New Born mother-linked | 🔵 | KB reference only (billing concern, not FC per manager) | — |
| 8 | Pkg Incl/Excl | 🔵 | Cash reconciles-to-₹0 (98.6%); coverage engine already §1; N2 skipped | Clarifications B1 |
| 9 | Cross Consultation | 🟢 | `estimate.cross_consultations` — placeholder-dept by TR code, one-visit/day | Governed consult tariff-code mapping |
| 10 | Outside Pkg LOS | 🟢 | `packageOffer.outside_package_los` — excess-day model, package PF never recomputed | Ward/ICU pkg breakdown; pharmacy (C1) |
| 11 | Medical Management | 🟢 | `estimate.medical_management` — family×setting, policy-first + semi-manual fallback | "28-admission template" (B2); family list |
| 12 | Daycare | 🟢 | `estimate.daycare` — 12h-threshold classifier fix (strict/extended/cross-midnight/converted) | Non-strict cases (B3) |
| 13 | Chemo | 🟢 | `estimate.chemo` — conservative shell; validated 1,624 chemo FC estimates exist | Drug master / price audit / prior-cycle (C7) held |
| 14 | Billing Training Guide | 🔵 | Confirms our OT-ladder/PF; final-insurance PF block IGNORED per manager | — |
| 15 | Labour Room | 🟢 | `estimate.labour_room` — <4h bed-only / ≥4h ROM0121 ₹9,900 or ROM5166 ₹15,000 | Slot→code mapping (C5) |
| 16 | Tax | 🟢 | `estimate.tax` — 5% GST on non-ICU room rent >₹5,000/day, separate line | GST in headline? (A2); attendant/HDU (C6) |
| 17 | Blood Bank | 🟢 | `estimate.blood_bank` — minimal transfusion add-on, no unit-states | 99.6% double-charge (C9, manager validating) |
| 18 | Equipment & Manual Add-ons | 🟢 | `estimate.manual_addons` — governed catalogue, four-column financial, mutex/location | Catalogue masters (C10) |
| 19 | Tariff Dataset Fallback | 🔵 | Engine already safe (cohort-history, PLACEHOLDER guard, TR1 cash-only); deliverable for hospital | TR1 fallback / service-primary (B7-B9); missing codes (C11) |
| 20 | Pharmacy Dataset | 🟢 | `estimate.pharmacy_selections` — source-mapped rate (sale→MRP→P50→user), UOM, replace-baseline | Curated selectable-item view |
| 21 | Non-package handling | 🔵/🟡 | Contamination REPRODUCED (RT0006 across 34 depts); engine partly insulated | N8 rebuild held for eval (C12) |
| 22 | Package handling | 🔵 | N7 under-pricing does NOT affect us (package_master full amounts); fixes are project-3 artifacts | — |
| 23 | Handling variants | 🔵 | Engine keeps uni/bi separate, robotic payer-specific; lap-specific packages confirmed | — |
| 24 | Flow / Doctor-input / AI | 🔵/🟡 | Architecture already ours (code-first, robotic user-select, AI-refusal); effective-period answered | >90% add-on preselect-confirm, N9 layer, doctor contract (D2) |
| 25 | Pharmacy classification | 🔵 | Engine uses `fc_estimate_bucket` (corrected, 3,252 implants), NOT the defective flag | N10 data corrections |
| 26 | Non-pharmacy grouping | 🔵 | Engine reads `service_item_mapping` (detailed), NOT the incomplete clean view | N11 regroupings (data) |
| 27 | Stage-2 estimate logic | 🔵/🟡 | ARCHITECTURE VALIDATED (Gross-P50 + bucket allocation); pharmacy P25-P75 agreed | ">₹1000-drop" surface-confirm held (D2/B10) |
| 28 | Treatment review | 🔵 | Engine enforces specific-over-broad (exact-first); package-price-from-code confirmed | N13 taxonomy (data) |

## Cross-cutting
- **Biggest unlock — open-bill service + pharmacy lines (C1):** moves NME Phase-2, the full positive-case cohort, the DNB ₹1-share, and outside-LOS pharmacy from policy-first to certified.
- **Manager review doc** (`manager-review-tabs1-28.md`): A1–A4 number-changing, B1–B11 interpretations, C1–C13 hospital/Finance data, D2 scoped-for-call.
- **Data deliverable:** `missing-tariff-codes-per-TR.md`.
- **Remaining build follow-up:** frontend rendering of all new `estimate.*` fields.
