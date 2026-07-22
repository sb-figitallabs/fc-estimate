# FC Estimate Engine — New vs. Old Comparison Report
**52 scenarios · run 2026-07-22 · direct API tests (`POST /api/estimate/build`)**

## What this is

The manager asked to test the new engine and see the results as saved estimates. This run fires **52 real estimate scenarios** through **two live engines side by side**:

- **NEW** (`localhost:4321`) — current `dev`, with all Tab 2–20 overlay modules.
- **OLD** (`localhost:4322`) — baseline commit `4183a1e` (last commit *before* the tab work; has T1 package-PF, none of the T2–T28 overlays).

Every scenario's **full new-engine estimate is saved as an openable JSON** under `saved-estimates/` (52 files) — the manager can open any one to see the complete line items, settlement, package offer, and every new `estimate.*` field.

## Headline result

| Metric | Result |
|--------|--------|
| Scenarios run | **52** |
| Base estimate compared new vs old | **52 / 52** |
| **Base estimate IDENTICAL (new == old, to the paisa)** | **52 / 52 ✅** |
| Base mismatches | **0** |
| Errors | **0** |
| Scenarios where new engine adds ≥1 overlay field | **50** |

**The core estimate never moved.** Across all 33 base cases and all 19 insurance/overlay/combined cases, the new engine returns the *exact same* `final_estimate` and line items as the old engine — down to the fraction of a rupee. Every new capability (NME, emergency, positive-case, newborn, cross-consult, outside-LOS, medical-management, daycare, chemo, labour-room, tax, blood-bank, manual add-ons, pharmacy) is attached as an **additive `estimate.*` overlay** that sits *alongside* the certified base numbers and never mutates them.

This is the guarantee the parity-pin was built to prove, now demonstrated on 52 cases.

---

## A. Base parity — 33 scenarios (8 procedures × payers × rooms)

Every row below: **new final == old final, exact match.** `items` = line-item count.

| Procedure | Payer / Room | Final (₹) | Items | new == old |
|-----------|--------------|----------:|------:|:---------:|
| TKR unilateral | Cash · General | 3,59,519 | 98 | ✅ |
| TKR unilateral | Cash · Single | 3,77,136 | 98 | ✅ |
| TKR unilateral | GIPSA · Single | 4,35,726 | 140 | ✅ |
| TKR unilateral | Non-GIPSA · Single | 4,12,402 | 156 | ✅ |
| THR hemiarthroplasty | Cash · General | 5,78,788 | 207 | ✅ |
| THR hemiarthroplasty | Cash · Single | 6,10,593 | 207 | ✅ |
| THR hemiarthroplasty | GIPSA · Single | 5,98,667 | 168 | ✅ |
| THR hemiarthroplasty | Non-GIPSA · Single | 5,35,226 | 152 | ✅ |
| Lap cholecystectomy | Cash · General | 1,54,182 | 127 | ✅ |
| Lap cholecystectomy | Cash · Single | 1,74,926 | 127 | ✅ |
| Lap cholecystectomy | GIPSA · Single | 1,90,032 | 135 | ✅ |
| Lap cholecystectomy | Non-GIPSA · Single | 1,32,049 | 187 | ✅ |
| LSCS caesarean | Cash · General | 73,300 | 106 | ✅ |
| LSCS caesarean | Cash · Single | 94,276 | 106 | ✅ |
| LSCS caesarean | GIPSA · Single | 73,031 | 97 | ✅ |
| LSCS caesarean | Non-GIPSA · Single | 61,575 | 93 | ✅ |
| PTCA single vessel | Cash · General | 1,96,141 | 194 | ✅ |
| PTCA single vessel | Cash · Single | 2,06,681 | 194 | ✅ |
| PTCA single vessel | GIPSA · Single | 2,01,655 | 167 | ✅ |
| PTCA single vessel | Non-GIPSA · Single | 1,69,212 | 143 | ✅ |
| General medical mgmt | Cash · General | 65,350 | 331 | ✅ |
| General medical mgmt | Cash · Single | 75,370 | 331 | ✅ |
| General medical mgmt | GIPSA · Single | 1,06,680 | 224 | ✅ |
| General medical mgmt | Non-GIPSA · Single | 56,737 | 260 | ✅ |
| Robotic TKR | Cash · General | 5,70,013 | 72 | ✅ |
| Robotic TKR | Cash · Single | 5,88,176 | 72 | ✅ |
| Robotic TKR | GIPSA · Single | 6,61,544 | 72 | ✅ |
| Robotic TKR | Non-GIPSA · Single | 5,57,977 | 72 | ✅ |
| TKR bilateral | Cash · General | 5,94,884 | 76 | ✅ |
| TKR bilateral | Cash · Single | 6,37,150 | 76 | ✅ |
| TKR bilateral | GIPSA · Single | 7,20,149 | 156 | ✅ |
| TKR bilateral | Non-GIPSA · Single | 6,11,187 | 92 | ✅ |
| General medical mgmt | Corporate · General | 71,455 | 414 | ✅ |

**All 33 identical.** Note the engine correctly keeps uni/bi separate, prices Robotic TKR payer-specifically, and applies package-PF by payer bucket (GIPSA vs Non-GIPSA) — all unchanged from baseline.

---

## B. Insurance settlement — 4 scenarios

Base estimate still identical to old; the settlement layer applies copay / room-cap / sub-limit correctly.

| # | Scenario | Base final (₹) | Settlement outcome | new == old base |
|---|----------|---------------:|--------------------|:---------------:|
| 34 | TKR GIPSA · SI 3L + 10% copay | 4,35,726 | Insurer pays **3,00,000** (SI cap); patient **1,35,726** incl. **₹43,018 copay** | ✅ |
| 35 | TKR Non-GIPSA · room cap 1% SI | 4,12,402 | Insurer pays **4,06,502**; patient **₹5,900** (room-rent excess only) | ✅ |
| 36 | THR GIPSA · implant sub-limit ₹1.5L | 5,98,667 | Sub-limit applied on settlement; base estimate untouched | ✅ |
| 37 | TKR GIPSA · low SI ₹1.5L (beyond cover) | 4,35,726 | Beyond-cover handled at settlement; base estimate untouched | ✅ |

---

## C. New overlay modules — 14 Tabs, each fires without touching the base

Each scenario triggers exactly the overlay(s) it should. Base `final_estimate` still == old engine in every row (proving additivity). Overlay amounts shown are the *new* numbers the old engine simply did not produce.

| # | Tab | Scenario | Base == old | New overlay field(s) → value |
|---|-----|----------|:-----------:|------------------------------|
| 38 | T3 | Emergency via ER + bed | ✅ | `emergency` = **₹5,310** (+ `expected_nme` ₹12,156 advisory) |
| 39 | T4 | Positive case · HBsAg non-heart | ✅ | `positive_case` = **₹27,280** (isolation + OT surcharge) |
| 40 | T4 | Positive case · HIV seropositive | ✅ | `positive_case` = **₹41,000** |
| 41 | T6 | Newborn · NICU 5d | ✅ | `newborn` = **₹58,835** (NICU pathway) |
| 42 | T9 | Cross-consult · Cardiology 2 visits | ✅ | `cross_consultations` = **₹10,000** |
| 43 | T10 | Outside-package LOS · 12-day stay | ✅ | `outside_package_los` = **₹88,008** excess-day charge |
| 44 | T11 | Medical management · respiratory ward | ✅ | `medical_management` overlay (family × setting) |
| 45 | T12 | Daycare · strict 8h | ✅ | `daycare` classifier overlay (strict) |
| 46 | T13 | Chemo · immunotherapy (Atezolizumab) | ✅ | `chemo` = **₹63,000** therapy total |
| 47 | T15 | Labour room · 6h | ✅ | `labour_room` = **₹9,900** (≥4h → ROM0121) |
| 48 | T16 | Tax · Single-room GST | ✅ | `tax` = **₹384** GST on room rent > ₹5k/day |
| 49 | T17 | Blood bank · 2u PRBC | ✅ | `blood_bank` = **₹5,302** |
| 50 | T18 | Manual add-ons · ambulance + instrument | ✅ | `manual_addons` = **₹101** (governed catalogue) |
| 51 | T20 | Pharmacy · high-value mesh + custom implant | ✅ | `pharmacy_selections` = **₹1,55,061** |

*(NME `expected_nme` is an advisory P50 estimate that rides along on most insurance cases; GST `tax` attaches on any qualifying single/deluxe room — that's why several rows show more than one overlay.)*

### Combined complex case — #52

**THR · Non-GIPSA · emergency + HBsAg-positive + nephrology cross-consult + blood + attendant room**

- Base estimate: **₹5,35,226** — *identical to old engine* ✅
- Overlays stacked cleanly, all additive:
  - `emergency` ₹4,000 · `positive_case` ₹27,280 · `cross_consultations` ₹2,000 · `blood_bank` ₹2,651 · `expected_nme` ₹12,156 (advisory)
- Proves multiple overlays compose on one estimate without interfering with each other or the base.

---

## How to review

- **Saved estimates:** `saved-estimates/NN-<slug>.json` — 52 files, one per scenario. Each contains the exact **input**, the **full new-engine output** (line items, grand-total band, settlement, package offer, and every `estimate.*` field), and the **old-engine final** for that input.
- **Raw comparison data:** `results.json` — all 52 rows with new/old summaries and the base-match verdict.
- **In the UI:** the same overlays now render live in the estimate screen under the *"Estimate add-ons & overlays"* panel (Non-GIPSA cases show the full stack of cards).

## Bottom line for the manager

> The new engine reproduces the old engine's certified estimate **exactly, on all 52 tests** — nothing in the base pricing changed. Everything the team built across Tabs 2–20 is layered on top as clearly-labelled, optional add-ons. You can open any of the 52 saved estimates to see both the unchanged core number and the new detail sitting next to it.
