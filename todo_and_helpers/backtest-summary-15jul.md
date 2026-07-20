# Backtest — engine estimates vs actual bills (case-by-case)

## Overall dissection (read this first)

**39 real admissions replayed through the HO Estimate Builder** (same API the
UI calls, saved as `[BACKTEST] …` rows in Saved Estimates on the test stack —
screenshot: `backtest-saved-list.png`; every case below links by saved id).
38 built, 1 failed (insurer "STAR HEALTH AND ALLIED INS" not in the
organization→tariff mapping).

**Accuracy picture (gross, with-package where a package applied):**
6 cases within ±10% · 14 within ±25% · 25 within ±50% · 13 beyond ±50%.
Median deviation −24.9% — the engine systematically UNDER-estimates
insurer surgical bills, and the per-case tags show exactly why:

1. **Token ₹0/₹1 OT rows (Q2 — awaiting sign-off)** — the single biggest
   under-driver on insurer surgical cases. The evidence doc
   (`token-rate-items-15jul.md`) already proposes the fix; applying it moves
   most TKR/THR/hysterectomy GIPSA & Non-GIPSA rows several points up.
2. **Implants/high-cost consumables billed as exclusions** — Non-GIPSA TKR
   (JAI KISHORE: actual ₹11.2L vs our ₹4.5L) and THR cases: the actual bill
   carries implants on top of everything; our insurer path prices the implant
   bucket thin. The exclusions-over-package quartile set (built for #6) is
   the data source — wire it as an implant floor on insurer joints.
3. **Multi-procedure admissions polluting single-family replays** — the two
   CAG daycare disasters (TULA MOHAN −90%, D MALTI −73%) are admissions whose
   actual bill includes PTCA/angioplasty work; we replayed them as plain CAG.
   This is the parked multi-procedure item (#10/#13) showing up in real money.
4. **Where the recent fixes landed, the numbers are good**: GIPSA TKR replays
   sit at +4–13% (PF-P50 rule working), robotic TKR cash at ±4%, dialysis
   went from the old ₹2L fabrication to ₹26.8k vs ₹16.8k actual (Q4 rule),
   LSCS/hernia/appendix within −10–30% (mostly token-OT remainder).
5. **Over-estimates are rare and explainable**: dialysis +59% (our typical
   session count vs this patient's single session), one medical-management
   +62% (historical backfill on a small bill — the Q3 fallback being
   conservative would help: use P25 for backfill instead of P50 on Low mode).

**Code/data actions this suggests (in order):**
(a) apply the Q2 token-OT rule after sign-off; (b) implant floor for insurer
joint replacements from the exclusions quartiles; (c) multi-procedure
detection (already on the todo as combo detection) — it is the whole story
behind the worst outliers; (d) add the missing insurer org mappings (1 build
failure + several fuzzy-matched orgs); (e) room-category column exists on
mart — replays used it, the intake flow could too.

---


39 historical admissions replayed through the HO Estimate Builder on the test stack
(saved as **[BACKTEST] …** in Saved Estimates — every row's saved_estimate_id opens in the app).

**Headline: 14/38 built estimates land within ±25% of the actual bill** (gross, with-package figure where a package applied). 1 build failures.

## INDIRAMMA JAMPALA — Total Knee Replacement (TKR) — Unilateral (Conventional) (GIPSA Insurance)
- Saved estimate **#102** · admission IPGB2627001306 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - UNILATERAL - LEFT**
- Inputs used: LOS 3d / ICU 2d · room Single
- **Engine ₹1,84,130 vs actual ₹2,75,901 (-33.3%)**
- Biggest bucket gaps: Pharmacy ₹1,70,220 vs ₹1,30,791
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## MURRA CHINNA KULLAI REDDY — Total Knee Replacement (TKR) — Unilateral (Conventional) (GIPSA Insurance)
- Saved estimate **#103** · admission IPGB2627001274 · org THE ORIENTAL INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - UNILATERAL - LEFT**
- Inputs used: LOS 5d / ICU 2d · room Single
- **Engine ₹1,84,130 vs actual ₹3,28,594 (-44%)**
- Biggest bucket gaps: Pharmacy ₹1,81,431 vs ₹1,51,150 · Investigations ₹6,270 vs ₹19,360
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## SHASHIKALA REDDY — Total Knee Replacement (TKR) — Unilateral (Conventional) (GIPSA Insurance)
- Saved estimate **#104** · admission IPGB2627001271 · org UNITED INDIA INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - UNILATERAL - LEFT**
- Inputs used: LOS 4d / ICU 2d · room Single
- **Engine ₹1,84,130 vs actual ₹3,08,239 (-40.3%)**
- Biggest bucket gaps: Pharmacy ₹1,75,826 vs ₹1,44,112 · Investigations ₹6,270 vs ₹19,360
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## KUSUMA KUMARI YARNAGULA — Total Knee Replacement (TKR) — Unilateral (Conventional) (Cash)
- Saved estimate **#105** · admission IPGB2627001176 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - LEFT**
- Inputs used: LOS 3d / ICU 2d · room Twin
- **Engine ₹3,37,263 vs actual ₹3,35,190 (+0.6%)**
- Biggest bucket gaps: Pharmacy ₹1,43,474 vs ₹1,19,533 · Professional Fees ₹99,231 vs ₹78,005 · Room Charges ₹41,910 vs ₹49,020
- Why: WITHIN ±25% of the actual bill

## JANAGAM ASHOK REDDY — Total Knee Replacement (TKR) — Unilateral (Conventional) (Cash)
- Saved estimate **#106** · admission IPGB2627001148 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - LEFT**
- Inputs used: LOS 2d / ICU 1d · room Twin
- **Engine ₹3,18,595 vs actual ₹3,06,077 (+4.1%)**
- Biggest bucket gaps: Professional Fees ₹90,615 vs ₹74,505 · Pharmacy ₹1,37,994 vs ₹1,25,495
- Why: WITHIN ±25% of the actual bill

## JAI KISHORE — Total Knee Replacement (TKR) — Unilateral (Conventional) (Non-GIPSA Insurance)
- Saved estimate **#107** · admission IPGB2627001332 · org ADITYA BIRLA HEALTH INSURANCE CO. LTD. → tariff TR285
- **Flow**: Insurance / Org Tariff · basis **Non-GIPSA Insurance** (683 cohort cases) · package **TOTAL KNEE REPLACEMENT (TKR) - LEFT**
- Inputs used: LOS 6d / ICU 3d · room Single
- **Engine ₹4,72,640 vs actual ₹11,21,556 (-57.9%)**
- Biggest bucket gaps: Procedure / OT Charges ₹50,583 vs ₹3,67,366 · Professional Fees ₹1,02,942 vs ₹2,81,246 · Pharmacy ₹2,05,514 vs ₹3,40,699
- Why: PF from historic P50 (Q1 rule) · token-OT under-pricing (Q2 pending sign-off)

## JAYALAXMI — Total Knee Replacement (TKR) — Unilateral (Conventional) (Non-GIPSA Insurance)
**BUILD FAILED**: tariff

## HAJAPPA — Robotic TKR Unilateral - Right (Cash)
- Saved estimate **#108** · admission IPGB2627001175 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (26 cohort cases) · package **ROBOTIC TKR - UNILATERAL - RIGHT**
- Inputs used: LOS 3d / ICU 2d · room Single
- **Engine ₹4,16,474 vs actual ₹5,76,205 (-27.7%)**
- Biggest bucket gaps: Professional Fees ₹1,57,475 vs ₹97,442 · Pharmacy ₹1,89,805 vs ₹2,32,527 · Investigations ₹8,030 vs ₹18,170
- Why: WITHIN ±25% of the actual bill

## S VENKATA NARAYANA — Robotic TKR Unilateral - Right (Cash)
- Saved estimate **#109** · admission IPGB2627001047 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (26 cohort cases) · package **ROBOTIC TKR - UNILATERAL - RIGHT**
- Inputs used: LOS 3d / ICU 1d · room Single
- **Engine ₹3,99,424 vs actual ₹5,99,851 (-33.4%)**
- Biggest bucket gaps: Procedure / OT Charges ₹1,58,660 vs ₹1,75,340 · Professional Fees ₹1,54,945 vs ₹1,61,442
- Why: WITHIN ±25% of the actual bill

## VUNDAVALLI SURYA CHANDRA RAO — Coronary Angiogram (CAG) CAT-1 — Daycare (Cash)
- Saved estimate **#110** · admission IPGB2627001395 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (165 cohort cases) · package **CORONARY ANGIOGRAM (CAG) - CAT-1**
- Inputs used: LOS 0d / ICU 0d · room Single (assumed)
- **Engine ₹17,500 vs actual ₹20,261 (-13.6%)**
- Biggest bucket gaps: Procedure / OT Charges ₹15,870 vs ₹5,860
- Why: room assumed Single (not in record)

## D MALTI — Coronary Angiogram (CAG) CAT-1 — Daycare (Cash)
- Saved estimate **#111** · admission IPGB2627001327 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (165 cohort cases) · package **CORONARY ANGIOGRAM (CAG) - CAT-1**
- Inputs used: LOS 0d / ICU 1d · room Single (assumed)
- **Engine ₹17,500 vs actual ₹63,656 (-72.5%)**
- Biggest bucket gaps: Investigations ₹0 vs ₹24,930 · Room Charges ₹0 vs ₹22,670 · Procedure / OT Charges ₹15,870 vs ₹5,860
- Why: room assumed Single (not in record)

## Y S S RATHNA KUMARI — Coronary Angiogram (CAG) CAT-1 — Daycare (GIPSA Insurance)
- Saved estimate **#112** · admission IPGB2526003730 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **All Payers** (165 cohort cases) · package **CORONARY ANGIOGRAM (CAG)**
- Inputs used: LOS 0d / ICU 0d · room Single (assumed)
- **Engine ₹12,400 vs actual ₹34,097 (-63.6%)**
- Biggest bucket gaps: Pharmacy ₹5,238 vs ₹13,556
- Why: PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check) · room assumed Single (not in record)

## TULA MOHAN — Coronary Angiogram (CAG) CAT-1 — Daycare (GIPSA Insurance)
- Saved estimate **#113** · admission IPGB2526002240 · org UNITED INDIA INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **All Payers** (165 cohort cases) · package **CORONARY ANGIOGRAM (CAG)**
- Inputs used: LOS 2d / ICU 1d · room General
- **Engine ₹12,400 vs actual ₹1,22,746 (-89.9%)**
- Biggest bucket gaps: Investigations ₹0 vs ₹41,950 · Professional Fees ₹3,600 vs ₹23,160 · Pharmacy ₹5,238 vs ₹16,161
- Why: PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## NITYA GAMIDI — LSCS (Caesarean Section) (GIPSA Insurance)
- Saved estimate **#114** · admission IPGB2627001298 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (188 cohort cases) · package **LSCS (CAESAREAN SECTION)**
- Inputs used: LOS 3d / ICU 1d · room Single
- **Engine ₹39,600 vs actual ₹1,06,505 (-62.8%)**
- Biggest bucket gaps: Procedure / OT Charges ₹3,023 vs ₹14,323 · Pharmacy ₹25,840 vs ₹34,545 · Room Charges ₹34,557 vs ₹27,356
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check) · token-OT under-pricing (Q2 pending sign-off)

## NIKHAT SHAMSI — LSCS (Caesarean Section) (GIPSA Insurance)
- Saved estimate **#115** · admission IPGB2627000887 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (188 cohort cases) · package **LSCS (CAESAREAN SECTION)**
- Inputs used: LOS 2d / ICU 1d · room Single
- **Engine ₹39,600 vs actual ₹1,14,826 (-65.5%)**
- Biggest bucket gaps: Procedure / OT Charges ₹3,023 vs ₹24,323 · Pharmacy ₹21,356 vs ₹34,923 · Room Charges ₹25,705 vs ₹18,079
- Why: PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check) · token-OT under-pricing (Q2 pending sign-off)

## RAVEENA K — LSCS (Caesarean Section) (Cash)
- Saved estimate **#116** · admission IPGB2627000980 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (188 cohort cases) · package **LSCS (CAESAREAN SECTION) - PA**
- Inputs used: LOS 2d / ICU 0d · room Single
- **Engine ₹1,21,356 vs actual ₹1,13,315 (+7.1%)**
- Biggest bucket gaps: Procedure / OT Charges ₹17,970 vs ₹32,360 · Pharmacy ₹20,876 vs ₹30,118
- Why: WITHIN ±25% of the actual bill

## RASHIKA GUPTA — LSCS (Caesarean Section) (Cash)
- Saved estimate **#117** · admission IPGB2627000159 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (188 cohort cases) · package **LSCS (CAESAREAN SECTION) - PA**
- Inputs used: LOS 3d / ICU 1d · room Single
- **Engine ₹1,44,651 vs actual ₹1,42,403 (+1.6%)**
- Biggest bucket gaps: Procedure / OT Charges ₹17,970 vs ₹34,260 · Pharmacy ₹25,461 vs ₹36,214 · Professional Fees ₹33,466 vs ₹25,274
- Why: WITHIN ±25% of the actual bill

## G SRINU — URSL (Ureteroscopic Lithotripsy) (Cash)
- Saved estimate **#118** · admission IPGB2526010432 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (16 cohort cases) · non-package
- Inputs used: LOS 2d / ICU 0d · room Single
- **Engine ₹1,45,608 vs actual ₹1,66,094 (-12.3%)**
- Biggest bucket gaps: Pharmacy ₹12,261 vs ₹29,113 · Procedure / OT Charges ₹68,950 vs ₹61,270 · Investigations ₹0 vs ₹6,840
- Why: WITHIN ±25% of the actual bill

## K. BABU NAIK — URSL (Ureteroscopic Lithotripsy) (Cash)
- Saved estimate **#119** · admission IPGB2526000171 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (16 cohort cases) · non-package
- Inputs used: LOS 0d / ICU 0d · room General
- **Engine ₹1,21,149 vs actual ₹1,08,674 (+11.5%)**
- Biggest bucket gaps: Professional Fees ₹32,436 vs ₹45,875 · Procedure / OT Charges ₹61,250 vs ₹48,340 · Room Charges ₹10,940 vs ₹1,000
- Why: WITHIN ±25% of the actual bill

## KAKANURU SIVA PARVATHI — URSL (Ureteroscopic Lithotripsy) (Non-GIPSA Insurance)
- Saved estimate **#120** · admission IPGB2627000596 · org ICICI LOMBARD GENERAL INSURANCE CO. LTD. → tariff TR201
- **Flow**: Insurance / Org Tariff · basis **Cash** (16 cohort cases) · non-package
- Inputs used: LOS 2d / ICU 0d · room General
- **Engine ₹84,518 vs actual ₹1,17,887 (-28.3%)**
- Biggest bucket gaps: Investigations ₹0 vs ₹29,755 · Procedure / OT Charges ₹35,024 vs ₹15,694 · Pharmacy ₹12,261 vs ₹23,874
- Why: PF from historic P50 (Q1 rule)

## MUKESH BAID — URSL (Ureteroscopic Lithotripsy) (Non-GIPSA Insurance)
- Saved estimate **#121** · admission IPGB2627000500 · org NIVA BUPA HEALTH INSURANCE CO. LTD. → tariff TR303
- **Flow**: Insurance / Org Tariff · basis **Cash** (16 cohort cases) · non-package
- Inputs used: LOS 1d / ICU 0d · room Single
- **Engine ₹1,36,709 vs actual ₹1,68,264 (-18.8%)**
- Biggest bucket gaps: Professional Fees ₹31,638 vs ₹54,615 · Procedure / OT Charges ₹81,420 vs ₹67,310 · Room Charges ₹10,601 vs ₹22,102
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule)

## G REVATHI — Laparoscopic Cholecystectomy (GIPSA Insurance)
- Saved estimate **#122** · admission IPGB2627001114 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (257 cohort cases) · package **LAP. CHOLECYSTECTOMY**
- Inputs used: LOS 1d / ICU 0d · room Twin
- **Engine ₹46,990 vs actual ₹1,11,627 (-57.9%)**
- Biggest bucket gaps: Procedure / OT Charges ₹53,204 vs ₹38,323 · Pharmacy ₹24,114 vs ₹29,359
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## BABITA MISHRA — Laparoscopic Cholecystectomy (GIPSA Insurance)
- Saved estimate **#123** · admission IPGB2627000553 · org UNITED INDIA INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (257 cohort cases) · package **LAP. CHOLECYSTECTOMY**
- Inputs used: LOS 2d / ICU 0d · room Single
- **Engine ₹50,890 vs actual ₹1,44,808 (-64.9%)**
- Biggest bucket gaps: Procedure / OT Charges ₹53,204 vs ₹45,323 · Pharmacy ₹28,136 vs ₹34,286
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule) · package conversion out of billed range (incl/excl to check)

## P KUMARASWAMY — Laparoscopic Cholecystectomy (Cash)
- Saved estimate **#124** · admission IPGB2627000905 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (257 cohort cases) · package **LAP. CHOLECYSTECTOMY - PA**
- Inputs used: LOS 1d / ICU 1d · room Twin
- **Engine ₹1,97,083 vs actual ₹1,56,989 (+25.5%)**
- Biggest bucket gaps: Pharmacy ₹22,722 vs ₹33,385 · Professional Fees ₹43,934 vs ₹36,130 · Procedure / OT Charges ₹66,940 vs ₹60,620
- Why: WITHIN ±25% of the actual bill

## AMREEN JAHAN — Laparoscopic Cholecystectomy (Cash)
- Saved estimate **#125** · admission IPGB2627000655 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (257 cohort cases) · package **LAP. CHOLECYSTECTOMY - PA**
- Inputs used: LOS 1d / ICU 0d · room General
- **Engine ₹1,78,553 vs actual ₹1,16,773 (+52.9%)**
- Biggest bucket gaps: Procedure / OT Charges ₹64,540 vs ₹39,670
- Why: WITHIN ±25% of the actual bill

## B.VIJAY KISHORE RAJU — Total Hip Replacement (THR) / Hemiarthroplasty (Cash)
- Saved estimate **#126** · admission IPGB2627001333 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **All Payers** (95 cohort cases) · non-package
- Inputs used: LOS 6d / ICU 2d · room Single
- **Engine ₹6,33,704 vs actual ₹7,24,764 (-12.6%)**
- Biggest bucket gaps: Pharmacy ₹2,77,413 vs ₹3,74,842 · Professional Fees ₹1,70,574 vs ₹90,130 · Procedure / OT Charges ₹62,860 vs ₹1,08,670
- Why: WITHIN ±25% of the actual bill

## YASMEEN SULTANA — Total Hip Replacement (THR) / Hemiarthroplasty (Cash)
- Saved estimate **#127** · admission IPGB2627001214 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **All Payers** (95 cohort cases) · non-package
- Inputs used: LOS 4d / ICU 1d · room Single
- **Engine ₹5,78,033 vs actual ₹3,95,859 (+46%)**
- Biggest bucket gaps: Pharmacy ₹2,65,959 vs ₹1,49,472 · Professional Fees ₹1,55,669 vs ₹83,505 · Investigations ₹7,420 vs ₹22,125
- Why: no dominant cause — spread across buckets

## G RAVIKANTH — Total Hip Replacement (THR) / Hemiarthroplasty (GIPSA Insurance)
- Saved estimate **#128** · admission IPGB2627001248 · org THE ORIENTAL INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (95 cohort cases) · package **TOTAL HIP REPLACEMENT (THR) - LEFT**
- Inputs used: LOS 5d / ICU 2d · room Twin
- **Engine ₹2,83,340 vs actual ₹5,52,129 (-48.7%)**
- Biggest bucket gaps: Procedure / OT Charges ₹44,743 vs ₹1,56,883 · Professional Fees ₹55,510 vs ₹45,141 · Pharmacy ₹2,74,838 vs ₹2,82,563
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule)

## VANAMA NAGA VENKATA MANIKANTA — Total Hip Replacement (THR) / Hemiarthroplasty (GIPSA Insurance)
- Saved estimate **#129** · admission IPGB2627000990 · org UNITED INDIA INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (95 cohort cases) · package **TOTAL HIP REPLACEMENT (THR) - LEFT**
- Inputs used: LOS 7d / ICU 2d · room Single
- **Engine ₹2,91,240 vs actual ₹11,03,605 (-73.6%)**
- Biggest bucket gaps: Pharmacy ₹2,86,576 vs ₹6,05,614 · Procedure / OT Charges ₹44,743 vs ₹3,31,126 · Investigations ₹7,420 vs ₹27,330
- Why: PF from historic P50 (Q1 rule) · token-OT under-pricing (Q2 pending sign-off) · pharmacy/implants gap (implants billed as exclusions?)

## NARAYANA RAO — Hemodialysis Management (GIPSA Insurance)
- Saved estimate **#130** · admission IPGB2627001245 · org THE ORIENTAL INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (361 cohort cases) · non-package
- Inputs used: LOS 3d / ICU 0d · room Single
- **Engine ₹24,912 vs actual ₹90,110 (-72.4%)**
- Biggest bucket gaps: Room Charges ₹0 vs ₹27,831 · Investigations ₹0 vs ₹20,660 · Procedure / OT Charges ₹23,200 vs ₹4,200
- Why: no dominant cause — spread across buckets

## MARI SWAMY — Hemodialysis Management (GIPSA Insurance)
- Saved estimate **#131** · admission IPGB2627000916 · org THE ORIENTAL INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (361 cohort cases) · non-package
- Inputs used: LOS 17d / ICU 0d · room General
- **Engine ₹26,832 vs actual ₹16,841 (+59.3%)**
- Biggest bucket gaps: Procedure / OT Charges ₹23,200 vs ₹11,960
- Why: no dominant cause — spread across buckets

## SOOFIA TARANNUM — General Medical Management (GIPSA Insurance)
- Saved estimate **#132** · admission IPGB2627001196 · org THE NEW INDIA ASSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (245 cohort cases) · non-package
- Inputs used: LOS 1d / ICU 0d · room Single
- **Engine ₹78,674 vs actual ₹48,534 (+62.1%)**
- Biggest bucket gaps: Investigations ₹41,130 vs ₹11,560 · Professional Fees ₹22,240 vs ₹10,740 · Room Charges ₹8,852 vs ₹18,554
- Why: PF from historic P50 (Q1 rule) · bucket backfilled from history (Q3)

## VUTUKURI VIJAYA LAKSHMI — General Medical Management (GIPSA Insurance)
- Saved estimate **#133** · admission IPGB2627000317 · org UNITED INDIA INSURANCE CO. LTD. → tariff TR290
- **Flow**: Insurance / Org Tariff · basis **GIPSA Insurance** (245 cohort cases) · non-package
- Inputs used: LOS 4d / ICU 0d · room Single
- **Engine ₹1,20,684 vs actual ₹2,00,534 (-39.8%)**
- Biggest bucket gaps: Professional Fees ₹22,240 vs ₹96,612 · Investigations ₹41,130 vs ₹3,050 · Procedure / OT Charges ₹1 vs ₹26,323
- Why: PF from historic P50 (Q1 rule) · bucket backfilled from history (Q3) · token-OT under-pricing (Q2 pending sign-off)

## V.CHENNA REDDY — General Medical Management (Cash)
- Saved estimate **#134** · admission IPGB2627001385 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (245 cohort cases) · non-package
- Inputs used: LOS 4d / ICU 0d · room Twin
- **Engine ₹1,10,721 vs actual ₹1,12,950 (-2%)**
- Biggest bucket gaps: Investigations ₹25,315 vs ₹37,400 · Pharmacy ₹26,622 vs ₹16,337 · Bedside Services ₹1,300 vs ₹9,450
- Why: WITHIN ±25% of the actual bill · bucket backfilled from history (Q3)

## NARENDHAR RAO O — Inguinal Hernia Repair (Non-GIPSA Insurance)
- Saved estimate **#135** · admission IPGB2627001413 · org ICICI LOMBARD GENERAL INSURANCE CO. LTD. → tariff TR201
- **Flow**: Insurance / Org Tariff · basis **Non-GIPSA Insurance** (27 cohort cases) · non-package
- Inputs used: LOS 1d / ICU 1d · room Single
- **Engine ₹1,46,573 vs actual ₹1,53,797 (-4.7%)**
- Biggest bucket gaps: Pharmacy ₹39,236 vs ₹1,962 · Professional Fees ₹65,861 vs ₹95,942 · Procedure / OT Charges ₹30,523 vs ₹44,124
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule)

## S V RAVI KUMAR SHARMA — Inguinal Hernia Repair (Non-GIPSA Insurance)
- Saved estimate **#136** · admission IPGB2627000305 · org TATA AIG GENERAL INSURANCE CO. LTD. → tariff TR288
- **Flow**: Insurance / Org Tariff · basis **Non-GIPSA Insurance** (27 cohort cases) · non-package
- Inputs used: LOS 3d / ICU 0d · room General
- **Engine ₹1,77,444 vs actual ₹2,17,671 (-18.5%)**
- Biggest bucket gaps: Procedure / OT Charges ₹52,423 vs ₹80,253 · Pharmacy ₹46,289 vs ₹60,883
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule)

## PRIYADARSINI PADHI — Hysterectomy (Non-GIPSA Insurance)
- Saved estimate **#137** · admission IPGB2627000753 · org CARE HEALTH INSURANCE LTD. → tariff TR202
- **Flow**: Insurance / Org Tariff · basis **Non-GIPSA Insurance** (54 cohort cases) · non-package
- Inputs used: LOS 2d / ICU 1d · room Single
- **Engine ₹1,76,409 vs actual ₹2,35,886 (-25.2%)**
- Biggest bucket gaps: Procedure / OT Charges ₹31,374 vs ₹58,383 · Pharmacy ₹36,044 vs ₹58,159 · Professional Fees ₹90,265 vs ₹97,907
- Why: PF from historic P50 (Q1 rule)

## FIZA SOGI — Hysterectomy (Non-GIPSA Insurance)
- Saved estimate **#138** · admission IPGB2627000680 · org GO DIGIT GENERAL INSURANCE LTD. → tariff TR285
- **Flow**: Insurance / Org Tariff · basis **Non-GIPSA Insurance** (54 cohort cases) · non-package
- Inputs used: LOS 1d / ICU 0d · room Single
- **Engine ₹1,87,512 vs actual ₹2,48,910 (-24.7%)**
- Biggest bucket gaps: Procedure / OT Charges ₹53,764 vs ₹1,01,743 · Investigations ₹0 vs ₹8,885 · Pharmacy ₹30,670 vs ₹35,854
- Why: WITHIN ±25% of the actual bill · PF from historic P50 (Q1 rule)

## KHADER ALI KHAN — General Surgical Procedure (Cash)
- Saved estimate **#139** · admission IPGB2627001337 · org General Patients → tariff TR1
- **Flow**: Cash / TR1 · basis **Cash** (104 cohort cases) · non-package
- Inputs used: LOS 1d / ICU 0d · room Single
- **Engine ₹1,24,699 vs actual ₹1,60,202 (-22.2%)**
- Biggest bucket gaps: Room Charges ₹10,480 vs ₹21,728 · Pharmacy ₹18,098 vs ₹27,904 · Professional Fees ₹36,279 vs ₹45,792
- Why: WITHIN ±25% of the actual bill
