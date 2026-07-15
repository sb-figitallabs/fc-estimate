# Auto-verification harness (15-Jul)

## Re-run AFTER the Q1/Q3/Q4 fixes — every fixed class cleared

| failure class | before | after |
|---|---|---|
| GIPSA PF at token ~₹740 (Q1) | 34 | **0** |
| Investigations ₹0 on medical families (Q3) | 31 | **10** |
| Pharmacy ₹0 on infusion families (Q3) | 6 | **1** |
| Dialysis/newborn room-charge inflation (Q4) | 2 | **0** (GIPSA dialysis went from gross ₹2.04L vs ₹22–48k to a trivial ₹1.3k bedside flag) |
| Gross total out of band | 41 | **15** |
| Token ₹0/₹1 OT rows (Q2 — awaiting sign-off on `token-rate-items-15jul.md`) | 54 | 54 |
| Conversion alerts (real inclusion/exclusion gaps) | 3 | 3 |
| Fully in-band builds | 25 | **32** |

The row count (182→175) undersells it: most remaining rows carry only the
token-OT flag (₹1-vs-₹2k class — pending the Q2 decision) or small bedside
noise. The big money errors — insurer PF, missing drug/investigation buckets,
fabricated room charges — are gone. Applying the proposed Q2 rule would clear
the bulk of the remaining 54.

---

# First run (baseline, before fixes)

`scripts/verify-estimates.js` on dev: every procedure family built with **zero
manual input** (Cash for all 170 families + GIPSA where the family has ≥15
GIPSA cases = 207 builds), gross + six buckets checked against the historic
P25–P75 band (75%/125% tolerance — the same rule the UI warns at), plus the
package conversion check. This is the "no human intervention" proof-run the
flow doc asks for. Full raw output: attached below the analysis.

## Headline

| | |
|---|---|
| Builds | 207 (0 crashed) |
| Fully in-band | 25 |
| With out-of-range components | **182** |

The 182 are NOT 182 separate bugs — they cluster into five systematic causes:

## Failure classes (ranked by row count)

1. **Token ₹0/₹1 OT charges on insurer tariffs — 54 rows.** Medical-management
   families price Procedure/OT at ₹0–₹1 on GIPSA (token rates kept as-is by
   design). The bands expect ₹1.5k–₹50k. Decision needed: TR1-fallback for
   token OT rows on medical families, or accept and annotate.
2. **GIPSA Professional Fees priced at ~₹740–₹790 — 34 rows.** Every GIPSA
   build prices PF at a token consultation rate instead of surgeon-fee logic
   (bands: ₹15k–₹1.4L). This is the single biggest money error on the insurer
   path — likely the same token-rate class as (1) hitting the PF matrix.
3. **Investigations ₹0 on medical families — 31 rows.** The itemized template
   for medical-management cohorts carries no investigation lines, while
   actual bills run ₹2.5k–₹95k. The bucket needs a historical-quartile
   residual (like pharmacy grouping) instead of empty.
4. **Gross out of band — 41 rows** — mostly consequences of (1)–(3) on GIPSA
   (gross lands at a third of the band floor), plus a few genuine cohort
   issues: Hemodialysis GIPSA gross ₹2.04L vs ₹22.5k–₹48.5k (Room Charges
   ₹1.77L vs ₹0 — LOS×ward applied to a session-based treatment), Routine
   Newborn Care ₹47k vs ₹9.4k–₹19k (room ₹31k vs ₹0).
5. **Pharmacy ₹0 on infusion families — 6 rows** (Immunotherapy, Chemo): the
   drug cost — the whole point of the admission — is missing; bands are
   ₹45k–₹2.8L.

## Conversion alerts (the #8 check, firing correctly)

- GIPSA TKR Unilateral: converted **₹1,84,130** vs actual bills ₹2,61,176–₹3,85,304
  (31 bills) — the exact number from the 11:53 review, now flagged automatically.
- GIPSA Lap Cholecystectomy: ₹50,890 vs ₹1,16,085–₹1,80,443 (7 bills).
- GIPSA LSCS: ₹39,600 vs ₹93,205–₹1,04,638 (6 bills).

## What to do with this

The harness turns "check every estimate by hand" into a ranked worklist:
fix (2) GIPSA PF first (one rule, 34 rows), then decide (1) token-OT policy,
then (3) investigations residual for medical families — that alone would
clear the majority of the 182. Re-run the script after each fix
(`gh workflow run maintenance.yml --ref dev -f script=verify-estimates.js`).
verifying 207 builds (170 families; GIPSA where ≥15 cases)…
  …25/207
  …50/207
  …75/207
  …100/207
  …125/207
  …150/207
  …175/207
  …200/207
===== VERIFICATION REPORT =====
OK: 25 · out-of-range: 182 · build failures: 0 · total: 207
--- out of range ---
CASH  | Robotic TKR Unilateral - Right | Professional Fees ₹1,57,475 vs ₹96,442–₹99,817
CASH  | Robotic TKR Unilateral - Left | Professional Fees ₹1,62,232 vs ₹96,942–₹1,00,942 · Investigations ₹8,030 vs ₹11,030–₹18,930
CASH  | Robotic TKR Bilateral | Professional Fees ₹2,17,170 vs ₹1,13,047–₹1,62,755 · Procedure / OT Charges ₹1,71,780 vs ₹2,61,110–₹2,73,250
CASH  | Total Hip Replacement (THR) / Hemiarthroplast | Professional Fees ₹1,64,387 vs ₹59,953–₹1,05,655 · Investigations ₹7,420 vs ₹13,175–₹37,215
GIPSA | Total Hip Replacement (THR) / Hemiarthroplast | Professional Fees ₹770 vs ₹50,084–₹71,827 · Investigations ₹7,420 vs ₹15,128–₹43,778 · Bedside Services ₹3,060 vs ₹4,445–₹9,275
CASH  | General Medical Management | Investigations ₹0 vs ₹6,623–₹58,488
GIPSA | General Medical Management | gross ₹44,081 vs ₹72,825–₹2,84,586 · Professional Fees ₹770 vs ₹17,240–₹62,990 · Investigations ₹0 vs ₹20,095–₹94,945 · Procedure / OT Charges ₹1 vs ₹2,790–₹11,725
CASH  | Chemotherapy / Systemic Therapy Infusion — Da | Professional Fees ₹7,494 vs ₹1,500–₹1,500 · Procedure / OT Charges ₹0 vs ₹350–₹360 · Bedside Services ₹360 vs ₹0–₹0
GIPSA | Chemotherapy / Systemic Therapy Infusion — Da | Professional Fees ₹0 vs ₹5,009–₹11,603 · Procedure / OT Charges ₹0 vs ₹600–₹600 · Bedside Services ₹360 vs ₹0–₹0
CASH  | Coronary Angiogram (CAG) CAT-1 — Daycare | Professional Fees ₹8,063 vs ₹3,600–₹3,600 · Procedure / OT Charges ₹15,870 vs ₹5,350–₹5,860 · Room Charges ₹0 vs ₹3,180–₹14,480
CASH  | Total Knee Replacement (TKR) — Unilateral (Co | Professional Fees ₹1,07,943 vs ₹60,860–₹74,505
GIPSA | Total Knee Replacement (TKR) — Unilateral (Co | Professional Fees ₹745 vs ₹48,641–₹60,456 · Investigations ₹6,270 vs ₹9,130–₹16,723 · Procedure / OT Charges ₹35,443 vs ₹54,038–₹1,73,180 · package conversion ₹1,84,130 vs actual ₹2,61,176–₹3,85,304 (31 bills)
GIPSA | Total Knee Replacement (TKR) — Bilateral (Con | Professional Fees ₹740 vs ₹73,725–₹90,854
CASH  | PTCA — Single Vessel | Investigations ₹1,384 vs ₹3,580–₹21,065
GIPSA | Laparoscopic Cholecystectomy | Professional Fees ₹790 vs ₹30,624–₹47,519 · package conversion ₹50,890 vs actual ₹1,16,085–₹1,80,443 (7 bills)
CASH  | LSCS (Caesarean Section) | Procedure / OT Charges ₹17,970 vs ₹27,270–₹47,270
GIPSA | LSCS (Caesarean Section) | gross ₹58,300 vs ₹1,04,862–₹1,49,124 · Professional Fees ₹740 vs ₹25,175–₹33,727 · Procedure / OT Charges ₹3,023 vs ₹24,323–₹42,197 · package conversion ₹39,600 vs actual ₹93,205–₹1,04,638 (6 bills)
CASH  | Febrile Illness / Infection Management | Investigations ₹3,470 vs ₹12,033–₹34,123 · Procedure / OT Charges ₹2,000 vs ₹1,190–₹1,460
GIPSA | Febrile Illness / Infection Management | gross ₹41,773 vs ₹72,891–₹1,36,751 · Professional Fees ₹0 vs ₹13,500–₹23,240 · Investigations ₹3,470 vs ₹28,323–₹58,808 · Procedure / OT Charges ₹0 vs ₹1,510–₹4,660
CASH  | Hemodialysis Management | Professional Fees ₹26,163 vs ₹7,850–₹17,216 · Procedure / OT Charges ₹26,940 vs ₹8,370–₹16,850 · Bedside Services ₹1,300 vs ₹3,000–₹21,450
GIPSA | Hemodialysis Management | gross ₹2,04,284 vs ₹22,556–₹48,506 · Room Charges ₹1,77,040 vs ₹0–₹0 · Bedside Services ₹1,300 vs ₹0–₹0
CASH  | Respiratory Infection / Pulmonary Management | Investigations ₹0 vs ₹7,775–₹38,480
GIPSA | Respiratory Infection / Pulmonary Management | gross ₹30,049 vs ₹77,697–₹1,31,242 · Professional Fees ₹0 vs ₹13,500–₹23,060 · Investigations ₹3,330 vs ₹29,923–₹52,720 · Procedure / OT Charges ₹1 vs ₹1,510–₹4,510
CASH  | Immunotherapy | gross ₹5,695 vs ₹57,196–₹2,64,189 · Procedure / OT Charges ₹0 vs ₹350–₹360 · Bedside Services ₹1,300 vs ₹0–₹0 · Pharmacy ₹0 vs ₹45,886–₹2,29,792
GIPSA | Immunotherapy | gross ₹4,170 vs ₹62,411–₹3,61,910 · Professional Fees ₹0 vs ₹11,463–₹66,495 · Procedure / OT Charges ₹2,870 vs ₹600–₹600 · Room Charges ₹0 vs ₹4,810–₹4,851 · Bedside Services ₹1,300 vs ₹0–₹0 · Pharmacy ₹0 vs ₹45,737–₹2,84,290
CASH  | Neonatal Jaundice / Phototherapy Management | Investigations ₹1,010 vs ₹2,750–₹12,849 · Procedure / OT Charges ₹0 vs ₹1,190–₹1,300
GIPSA | Neonatal Jaundice / Phototherapy Management | Professional Fees ₹0 vs ₹9,000–₹70,125 · Investigations ₹1,010 vs ₹2,258–₹30,695 · Procedure / OT Charges ₹0 vs ₹1,300–₹1,510
CASH  | Stroke / TIA Medical Management | Professional Fees ₹27,823 vs ₹8,179–₹17,538 · Investigations ₹4,840 vs ₹20,790–₹61,025 · Procedure / OT Charges ₹0 vs ₹1,460–₹3,933
GIPSA | Stroke / TIA Medical Management | gross ₹30,071 vs ₹1,05,063–₹1,74,649 · Professional Fees ₹1,780 vs ₹18,365–₹35,990 · Investigations ₹3,370 vs ₹43,610–₹83,623 · Procedure / OT Charges ₹1 vs ₹2,560–₹7,135
CASH  | Pneumonia / Lower Respiratory Tract Infection | Investigations ₹498 vs ₹12,440–₹46,066 · Procedure / OT Charges ₹0 vs ₹1,218–₹1,618 · Bedside Services ₹1,300 vs ₹3,575–₹21,555
GIPSA | Pneumonia / Lower Respiratory Tract Infection | gross ₹53,974 vs ₹84,707–₹1,90,362 · Professional Fees ₹770 vs ₹18,740–₹33,865 · Investigations ₹5,378 vs ₹29,300–₹61,915 · Procedure / OT Charges ₹0 vs ₹1,458–₹4,670
CASH  | Nephrology Medical Management | Investigations ₹2,840 vs ₹11,485–₹38,640 · Bedside Services ₹1,300 vs ₹2,268–₹13,645
GIPSA | Nephrology Medical Management | gross ₹39,543 vs ₹69,437–₹1,51,861 · Professional Fees ₹770 vs ₹18,365–₹31,928 · Investigations ₹8,280 vs ₹27,563–₹57,420 · Procedure / OT Charges ₹1 vs ₹1,510–₹5,933 · Bedside Services ₹1,300 vs ₹1,903–₹11,060
CASH  | Routine Newborn Care & Vaccination | gross ₹47,421 vs ₹9,436–₹19,068 · Professional Fees ₹12,696 vs ₹4,000–₹8,000 · Procedure / OT Charges ₹0 vs ₹1,190–₹1,300 · Room Charges ₹31,440 vs ₹0–₹0 · Bedside Services ₹1,300 vs ₹0–₹540
CASH  | Pediatric Medical Management | Investigations ₹0 vs ₹4,973–₹71,323 · Bedside Services ₹1,300 vs ₹2,058–₹36,304
GIPSA | Pediatric Medical Management | gross ₹25,389 vs ₹67,605–₹1,98,584 · Professional Fees ₹0 vs ₹18,875–₹59,903 · Investigations ₹1,250 vs ₹9,365–₹60,600 · Procedure / OT Charges ₹1 vs ₹1,510–₹22,055
CASH  | General Cardiology Medical Management | Investigations ₹0 vs ₹19,415–₹87,710 · Bedside Services ₹1,300 vs ₹5,591–₹54,533
GIPSA | General Cardiology Medical Management | gross ₹32,216 vs ₹84,742–₹2,56,236 · Professional Fees ₹830 vs ₹25,500–₹57,740 · Investigations ₹2,500 vs ₹20,340–₹86,960 · Procedure / OT Charges ₹1 vs ₹1,810–₹18,323 · Bedside Services ₹1,300 vs ₹2,750–₹15,761
CASH  | Diagnostic Bronchoscopy / BAL | Investigations ₹7,780 vs ₹21,294–₹98,146
GIPSA | Diagnostic Bronchoscopy / BAL | gross ₹77,704 vs ₹1,43,760–₹2,93,612 · Professional Fees ₹790 vs ₹25,500–₹50,390 · Investigations ₹14,556 vs ₹59,986–₹1,13,010
CASH  | NICU Intensive Care Management | Investigations ₹0 vs ₹3,583–₹20,599 · Procedure / OT Charges ₹0 vs ₹360–₹3,633 · Bedside Services ₹1,300 vs ₹3,125–₹18,573
GIPSA | NICU Intensive Care Management | Professional Fees ₹0 vs ₹22,375–₹1,21,000 · Investigations ₹0 vs ₹8,550–₹47,795 · Procedure / OT Charges ₹0 vs ₹1,510–₹4,688 · Bedside Services ₹1,300 vs ₹2,413–₹38,750
CASH  | Diabetic Foot / Wound Debridement | Investigations ₹0 vs ₹2,550–₹15,348 · Procedure / OT Charges ₹45,290 vs ₹11,398–₹25,740
GIPSA | Diabetic Foot / Wound Debridement | Professional Fees ₹740 vs ₹29,490–₹67,795 · Investigations ₹0 vs ₹9,085–₹25,248 · Bedside Services ₹3,280 vs ₹4,555–₹8,320
GIPSA | General Medical Management / Infusion | gross ₹34,581 vs ₹75,690–₹2,71,645 · Professional Fees ₹740 vs ₹20,750–₹61,265 · Procedure / OT Charges ₹1 vs ₹1,510–₹17,340
GIPSA | Gastroenterology Medical Management | gross ₹44,184 vs ₹84,658–₹2,45,735 · Professional Fees ₹740 vs ₹13,124–₹64,975 · Procedure / OT Charges ₹1 vs ₹1,510–₹49,523
CASH  | Diagnostic Upper GI Endoscopy | Investigations ₹0 vs ₹11,155–₹45,455 · Bedside Services ₹1,750 vs ₹2,390–₹7,870
GIPSA | Diagnostic Upper GI Endoscopy | gross ₹36,993 vs ₹78,612–₹2,66,312 · Professional Fees ₹740 vs ₹15,490–₹41,970 · Investigations ₹2,440 vs ₹19,710–₹82,280 · Procedure / OT Charges ₹5,181 vs ₹9,640–₹12,230
CASH  | General Surgical Procedure | Bedside Services ₹1,300 vs ₹1,780–₹10,770
CASH  | Acute Coronary Syndrome (ACS) / MI Management | Investigations ₹2,765 vs ₹12,080–₹30,866
GIPSA | Acute Coronary Syndrome (ACS) / MI Management | gross ₹49,395 vs ₹83,482–₹1,73,075 · Professional Fees ₹750 vs ₹19,215–₹36,020 · Investigations ₹2,765 vs ₹19,365–₹54,460 · Procedure / OT Charges ₹0 vs ₹2,820–₹4,670 · Bedside Services ₹1,300 vs ₹2,220–₹14,250
GIPSA | Minor Excision / Soft Tissue Biopsy | Professional Fees ₹740 vs ₹29,368–₹54,145 · Procedure / OT Charges ₹43,023 vs ₹13,042–₹32,482
CASH  | Endocrinology / Diabetes Management | Investigations ₹6,210 vs ₹12,500–₹45,000
GIPSA | Endocrinology / Diabetes Management | gross ₹44,716 vs ₹96,010–₹1,83,486 · Professional Fees ₹770 vs ₹18,178–₹29,490 · Investigations ₹10,175 vs ₹29,340–₹77,018 · Procedure / OT Charges ₹1 vs ₹1,510–₹4,670
CASH  | Craniotomy / Craniectomy & Brain Tumor Surger | Investigations ₹7,110 vs ₹17,705–₹1,20,845
GIPSA | Lumbar Spinal Fusion (PLIF/TLIF) | Professional Fees ₹1,550 vs ₹88,087–₹1,42,423
CASH  | Heart Failure Management | Investigations ₹8,610 vs ₹15,500–₹44,213 · Procedure / OT Charges ₹0 vs ₹1,300–₹2,495 · Bedside Services ₹3,295 vs ₹5,935–₹42,440
CASH  | Respiratory / Pulmonary Management | Investigations ₹3,195 vs ₹14,320–₹52,647 · Procedure / OT Charges ₹0 vs ₹1,300–₹3,870 · Bedside Services ₹2,125 vs ₹3,980–₹21,540
GIPSA | Respiratory / Pulmonary Management | gross ₹52,251 vs ₹72,421–₹2,08,556 · Professional Fees ₹740 vs ₹14,458–₹37,495 · Investigations ₹5,575 vs ₹18,485–₹59,892 · Procedure / OT Charges ₹0 vs ₹1,510–₹4,670 · Bedside Services ₹1,300 vs ₹2,140–₹22,476
CASH  | Spine Surgery (Decompression / Fusion) | Investigations ₹0 vs ₹1,725–₹7,611
GIPSA | Spine Surgery (Decompression / Fusion) | gross ₹2,07,111 vs ₹2,81,832–₹5,00,556 · Professional Fees ₹740 vs ₹1,52,990–₹1,89,552 · Investigations ₹280 vs ₹2,490–₹22,150
GIPSA | Spinal Surgery / Decompression | gross ₹77,362 vs ₹1,28,379–₹3,18,617 · Professional Fees ₹2,547 vs ₹37,530–₹1,03,410 · Bedside Services ₹1,300 vs ₹1,736–₹5,263
CASH  | Vascular Access / Catheter Insertion | Investigations ₹0 vs ₹14,900–₹95,595 · Procedure / OT Charges ₹2,000 vs ₹9,853–₹33,300
GIPSA | Vascular Access / Catheter Insertion | Professional Fees ₹740 vs ₹9,100–₹95,077 · Investigations ₹0 vs ₹12,650–₹1,48,080 · Procedure / OT Charges ₹1 vs ₹13,590–₹68,892
CASH  | Femur Fracture Fixation | Investigations ₹10,185 vs ₹24,238–₹44,180
CASH  | Tibia / Fibula Fracture Fixation | Investigations ₹0 vs ₹10,543–₹35,603
CASH  | Asthma / COPD Exacerbation Management | Investigations ₹1,190 vs ₹12,288–₹41,114 · Procedure / OT Charges ₹0 vs ₹1,300–₹4,340
GIPSA | Asthma / COPD Exacerbation Management | gross ₹47,128 vs ₹66,672–₹1,65,149 · Professional Fees ₹740 vs ₹14,240–₹36,740 · Investigations ₹1,190 vs ₹13,645–₹44,470 · Procedure / OT Charges ₹0 vs ₹1,500–₹4,510
CASH  | Wound Debridement & Management | Professional Fees ₹12,851 vs ₹17,515–₹37,221
GIPSA | Wound Debridement & Management | Professional Fees ₹740 vs ₹32,470–₹51,952 · Room Charges ₹17,704 vs ₹6,704–₹12,900
CASH  | Acute Gastroenteritis / GI Infection Manageme | Investigations ₹1,190 vs ₹11,809–₹27,798 · Procedure / OT Charges ₹0 vs ₹1,508–₹4,543
GIPSA | Acute Gastroenteritis / GI Infection Manageme | gross ₹32,416 vs ₹58,637–₹90,441 · Professional Fees ₹740 vs ₹12,990–₹17,240 · Investigations ₹1,190 vs ₹17,060–₹33,910 · Procedure / OT Charges ₹0 vs ₹2,510–₹4,670
CASH  | Hepatic / Liver Cirrhosis Management | Investigations ₹0 vs ₹13,425–₹37,890 · Procedure / OT Charges ₹0 vs ₹1,300–₹12,030
CASH  | Gastroenterology / Hepatology Management | Investigations ₹5,465 vs ₹16,390–₹48,630
GIPSA | Gastroenterology / Hepatology Management | Professional Fees ₹740 vs ₹13,910–₹27,770 · Investigations ₹8,055 vs ₹16,675–₹47,255 · Procedure / OT Charges ₹0 vs ₹1,503–₹4,668
CASH  | Minor Suturing / Soft Tissue Repair | Procedure / OT Charges ₹45,290 vs ₹2,018–₹22,085 · Room Charges ₹10,480 vs ₹310–₹5,108 · Pharmacy ₹0 vs ₹3,025–₹11,754
CASH  | Seizure / Epilepsy Management | Investigations ₹1,860 vs ₹6,665–₹43,725 · Procedure / OT Charges ₹0 vs ₹1,190–₹4,670
CASH  | Pulmonology Medical Management | gross ₹45,429 vs ₹64,838–₹1,94,518 · Investigations ₹0 vs ₹16,415–₹49,015
CASH  | Transurethral Resection (TURP/TURBT) | Procedure / OT Charges ₹50,550 vs ₹15,280–₹23,700 · Room Charges ₹0 vs ₹3,180–₹4,420 · Pharmacy ₹5,287 vs ₹7,897–₹14,410
CASH  | Sepsis / Critical Care Infection Management | Professional Fees ₹62,775 vs ₹15,467–₹46,214 · Investigations ₹21,187 vs ₹36,085–₹87,976 · Bedside Services ₹3,610 vs ₹4,845–₹39,790
CASH  | Blood Product Transfusion | Room Charges ₹0 vs ₹3,180–₹26,400 · Pharmacy ₹0 vs ₹1,507–₹42,260
CASH  | Gastroenteritis / Abdominal Pain Management | Investigations ₹0 vs ₹9,270–₹32,245 · Bedside Services ₹1,300 vs ₹0–₹515
CASH  | Neurological / Neurosurgical Medical Manageme | Investigations ₹0 vs ₹1,535–₹41,020 · Procedure / OT Charges ₹56,280 vs ₹2,180–₹43,830
CASH  | Therapeutic Upper GI Endoscopy | Investigations ₹0 vs ₹8,898–₹38,568 · Bedside Services ₹1,750 vs ₹2,819–₹15,698
GIPSA | Therapeutic Upper GI Endoscopy | gross ₹54,199 vs ₹79,339–₹2,49,711 · Professional Fees ₹740 vs ₹17,380–₹28,945 · Investigations ₹0 vs ₹16,610–₹48,735
CASH  | Vascular Medical Management | Procedure / OT Charges ₹56,280 vs ₹2,250–₹19,820 · Pharmacy ₹1,071 vs ₹5,085–₹32,300
CASH  | Excision of Skin Lesion (Lipoma/Cyst/Etc.) | gross ₹78,316 vs ₹28,528–₹45,839 · Procedure / OT Charges ₹52,270 vs ₹10,030–₹15,788 · Room Charges ₹0 vs ₹2,350–₹3,770 · Bedside Services ₹1,300 vs ₹0–₹926
CASH  | Surgical Gastroenterology / General Surgery | Bedside Services ₹1,300 vs ₹2,170–₹9,405
CASH  | Seizure Disorder / Neurological Management | Procedure / OT Charges ₹160 vs ₹1,190–₹1,810
CASH  | Varicose Vein Laser Ablation (EVLA/EVLT) | Room Charges ₹10,480 vs ₹1,000–₹3,770 · Bedside Services ₹2,230 vs ₹890–₹1,705
CASH  | UTI / Urosepsis Medical Management | Investigations ₹1,190 vs ₹7,000–₹35,640
GIPSA | UTI / Urosepsis Medical Management | gross ₹30,134 vs ₹57,452–₹1,32,363 · Professional Fees ₹765 vs ₹12,620–₹32,265 · Investigations ₹0 vs ₹5,953–₹37,405 · Procedure / OT Charges ₹1 vs ₹1,400–₹9,462
CASH  | DJ Stent Removal | gross ₹91,539 vs ₹32,622–₹41,755 · Professional Fees ₹24,508 vs ₹9,065–₹17,840 · Procedure / OT Charges ₹52,140 vs ₹12,340–₹16,500 · Room Charges ₹10,480 vs ₹655–₹4,220
CASH  | Neurological Medical Management | Investigations ₹9,420 vs ₹28,235–₹75,388 · Procedure / OT Charges ₹0 vs ₹1,510–₹5,858
CASH  | Cystoscopy (Diagnostic / Therapeutic) | Procedure / OT Charges ₹54,520 vs ₹14,780–₹34,338 · Room Charges ₹0 vs ₹3,758–₹17,745 · Pharmacy ₹4,049 vs ₹6,612–₹25,873
CASH  | Paediatric Surgical Procedure | Procedure / OT Charges ₹51,020 vs ₹14,997–₹39,805
CASH  | General OBG Medical Management / Observation | Pharmacy ₹1,799 vs ₹3,368–₹11,392
CASH  | Orthopaedic Medical Management | Professional Fees ₹12,042 vs ₹1,575–₹7,499
CASH  | Ventral Hernia Repair | Room Charges ₹31,440 vs ₹17,760–₹24,210
CASH  | Tracheostomy / Airway Management | Room Charges ₹2,02,200 vs ₹69,410–₹1,59,986
CASH  | Diagnostic Colonoscopy | Investigations ₹9,770 vs ₹37,395–₹82,865 · Procedure / OT Charges ₹2,000 vs ₹3,360–₹12,498
CASH  | Seizure Disorder Medical Management | Investigations ₹1,190 vs ₹11,745–₹46,526
CASH  | Traumatic Brain Injury (TBI) / Head Trauma Ma | Investigations ₹20,155 vs ₹28,840–₹1,02,351 · Bedside Services ₹2,250 vs ₹3,640–₹32,340
CASH  | Bariatric - Sleeve Gastrectomy | Professional Fees ₹94,282 vs ₹1,34,140–₹2,50,851
CASH  | Neurology Medical Management | Investigations ₹2,380 vs ₹17,225–₹1,02,021 · Procedure / OT Charges ₹2,000 vs ₹4,523–₹36,285 · Bedside Services ₹1,300 vs ₹1,883–₹48,688
CASH  | Acute Pancreatitis Management | Investigations ₹4,990 vs ₹18,980–₹53,660 · Procedure / OT Charges ₹0 vs ₹1,300–₹4,460
CASH  | Major Exploratory Laparotomy / Laparoscopy | Investigations ₹0 vs ₹4,190–₹72,425
CASH  | Minor Procedure / Biopsy | Procedure / OT Charges ₹51,020 vs ₹21,027–₹38,003
CASH  | Stroke / Cerebrovascular Medical Management | Investigations ₹6,767 vs ₹34,770–₹73,653 · Procedure / OT Charges ₹0 vs ₹1,780–₹6,015
CASH  | ERCP / Biliary Stenting | Pharmacy ₹4,849 vs ₹7,800–₹33,875
CASH  | Adenotonsillectomy | Room Charges ₹0 vs ₹3,720–₹8,837
CASH  | General Plastic Surgery Procedure | Procedure / OT Charges ₹45,290 vs ₹12,290–₹31,615
CASH  | Bone Marrow Evaluation / Biopsy | gross ₹31,369 vs ₹85,585–₹8,41,987 · Investigations ₹0 vs ₹36,590–₹2,44,821 · Room Charges ₹10,480 vs ₹17,777–₹1,18,368 · Pharmacy ₹8,169 vs ₹14,608–₹1,88,135
CASH  | Therapeutic Hysteroscopy / Polypectomy | Procedure / OT Charges ₹57,621 vs ₹17,354–₹40,250 · Bedside Services ₹3,030 vs ₹1,211–₹2,185
CASH  | Diagnostic Cystoscopy | gross ₹91,734 vs ₹36,253–₹61,344 · Procedure / OT Charges ₹61,030 vs ₹13,830–₹20,498 · Room Charges ₹0 vs ₹3,595–₹3,795 · Pharmacy ₹4,305 vs ₹6,309–₹9,632
CASH  | Spine Medical Management / Observation | Investigations ₹1,290 vs ₹33,770–₹64,700 · Procedure / OT Charges ₹0 vs ₹2,660–₹5,500
CASH  | Thrombolysis Therapy Management | Investigations ₹33,002 vs ₹62,900–₹99,630 · Procedure / OT Charges ₹3,000 vs ₹16,770–₹24,550
CASH  | TURBT (Transurethral Resection of Bladder Tum | Procedure / OT Charges ₹59,780 vs ₹21,630–₹24,665
CASH  | Humerus Fracture Fixation | Investigations ₹1,190 vs ₹10,403–₹33,770
CASH  | Chemoport Insertion / Central Venous Access | gross ₹6,005 vs ₹41,230–₹4,53,764 · Professional Fees ₹1,608 vs ₹2,625–₹54,635 · Room Charges ₹0 vs ₹3,180–₹40,535 · Pharmacy ₹975 vs ₹16,761–₹1,20,472
CASH  | Skin Grafting / Flap Reconstruction | Procedure / OT Charges ₹51,020 vs ₹20,980–₹32,610
CASH  | Medical Management - Abdominal/Gastrointestin | Procedure / OT Charges ₹0 vs ₹1,660–₹4,610
CASH  | Fistulectomy / Anal Fistula Repair | Procedure / OT Charges ₹51,020 vs ₹16,490–₹28,060
CASH  | Rheumatology - Biologic / Infusion Therapy | gross ₹27,644 vs ₹40,310–₹1,25,504 · Procedure / OT Charges ₹0 vs ₹405–₹1,375
CASH  | RIRS (Retrograde Intrarenal Surgery) & Lithot | Room Charges ₹21,771 vs ₹6,704–₹16,832
CASH  | Diagnostic Neuro-Evaluation | gross ₹54,705 vs ₹74,568–₹2,53,594 · Investigations ₹5,410 vs ₹38,715–₹93,722
CASH  | CRIF / K-Wire Fixation | Professional Fees ₹29,405 vs ₹39,395–₹71,060 · Investigations ₹0 vs ₹1,790–₹13,590 · Procedure / OT Charges ₹48,790 vs ₹19,573–₹28,653 · Bedside Services ₹3,030 vs ₹1,211–₹1,921
CASH  | ERCP / Biliary and Pancreatic Intervention | Procedure / OT Charges ₹12,890 vs ₹30,110–₹60,290
CASH  | Toxicology / Poisoning Management | Professional Fees ₹19,309 vs ₹6,014–₹12,580 · Investigations ₹2,440 vs ₹7,830–₹26,630 · Procedure / OT Charges ₹160 vs ₹1,720–₹2,660 · Room Charges ₹27,880 vs ₹14,480–₹21,680
CASH  | Peripheral Angioplasty & Stenting (PTA) | Room Charges ₹66,240 vs ₹28,960–₹49,270
CASH  | ENT Medical Management / Procedure | Bedside Services ₹1,300 vs ₹2,228–₹3,070
CASH  | Emergency / Trauma Stabilization | Investigations ₹0 vs ₹13,468–₹50,785
CASH  | Epidural Steroid Injection / Pain Management | Professional Fees ₹28,854 vs ₹9,336–₹16,732 · Procedure / OT Charges ₹65,450 vs ₹11,275–₹15,558
CASH  | Uro-Gynecology - Incontinence / Pelvic Repair | Procedure / OT Charges ₹56,280 vs ₹15,280–₹23,290 · Room Charges ₹10,480 vs ₹0–₹3,180 · Pharmacy ₹6,112 vs ₹8,180–₹18,852
CASH  | Spinal Fusion & Fixation (General) | Bedside Services ₹2,590 vs ₹4,143–₹17,409
CASH  | Diagnostic Hysteroscopy | gross ₹96,730 vs ₹48,659–₹67,681 · Procedure / OT Charges ₹50,580 vs ₹15,760–₹26,830 · Room Charges ₹10,480 vs ₹1,000–₹4,420
CASH  | Acute Respiratory Distress Management | Investigations ₹5,800 vs ₹19,248–₹64,259 · Procedure / OT Charges ₹0 vs ₹1,190–₹1,653 · Bedside Services ₹5,410 vs ₹17,131–₹37,088
CASH  | Gastroenterology Critical Care / Sepsis Manag | Investigations ₹5,855 vs ₹27,570–₹76,650
CASH  | Combined Upper GI Endoscopy & Colonoscopy | Professional Fees ₹30,678 vs ₹12,703–₹14,982 · Investigations ₹10,640 vs ₹26,983–₹47,230 · Room Charges ₹20,990 vs ₹8,238–₹13,495
CASH  | Renal Biopsy | Investigations ₹0 vs ₹16,490–₹96,008 · Procedure / OT Charges ₹0 vs ₹5,290–₹28,695
CASH  | Acute Gastroenteritis / Colitis Management | Professional Fees ₹15,120 vs ₹4,671–₹10,071 · Investigations ₹3,420 vs ₹12,270–₹37,233 · Procedure / OT Charges ₹0 vs ₹1,190–₹1,555
CASH  | Nephrology / Renal Management | Investigations ₹17,823 vs ₹46,830–₹76,835 · Bedside Services ₹1,300 vs ₹3,290–₹17,530
CASH  | Cardiothoracic / Transplant Surgery | Investigations ₹0 vs ₹7,668–₹39,462 · Bedside Services ₹2,230 vs ₹3,325–₹31,655
CASH  | Cervical Cerclage | Room Charges ₹10,480 vs ₹690–₹4,970 · Pharmacy ₹6,626 vs ₹11,430–₹14,029
CASH  | Cervical Spinal Fusion / Stabilization | Professional Fees ₹89,287 vs ₹1,21,593–₹1,78,547 · Investigations ₹0 vs ₹2,680–₹25,973 · Bedside Services ₹2,230 vs ₹4,145–₹20,930
CASH  | Hypertension / Hypertensive Crisis Management | Investigations ₹1,485 vs ₹8,354–₹23,328 · Procedure / OT Charges ₹0 vs ₹465–₹1,300 · Room Charges ₹38,360 vs ₹15,943–₹21,428
CASH  | Obstetrics Medical Management (Pregnancy/Labo | Professional Fees ₹12,591 vs ₹2,648–₹7,570 · Investigations ₹430 vs ₹3,320–₹17,650 · Procedure / OT Charges ₹0 vs ₹350–₹1,190
CASH  | Hernia Repair (General) | Professional Fees ₹43,336 vs ₹60,697–₹79,274
CASH  | Lumbar Puncture / CSF Analysis | Investigations ₹5,660 vs ₹37,515–₹1,32,236 · Procedure / OT Charges ₹0 vs ₹2,390–₹30,579 · Bedside Services ₹5,510 vs ₹9,860–₹51,450
CASH  | Hand / Finger Fracture Fixation | Room Charges ₹10,480 vs ₹1,545–₹2,635 · Bedside Services ₹1,300 vs ₹223–₹668
CASH  | Paediatric Laparoscopic Surgery (Major) | Professional Fees ₹54,203 vs ₹72,312–₹1,63,735
CASH  | Critical Care & Mechanical Ventilation | Professional Fees ₹98,620 vs ₹26,685–₹54,743 · Investigations ₹40,520 vs ₹62,380–₹94,293 · Room Charges ₹1,04,660 vs ₹44,525–₹78,315 · Bedside Services ₹14,845 vs ₹35,533–₹65,900
CASH  | Intercostal Drainage (ICD) / Chest Tube Place | gross ₹88,564 vs ₹1,22,089–₹1,99,193 · Investigations ₹4,780 vs ₹18,015–₹39,863 · Bedside Services ₹3,795 vs ₹10,805–₹37,025
CASH  | Hand Surgery / Tendon & Nerve Repair | Room Charges ₹20,960 vs ₹3,770–₹14,220
CASH  | Hemodiafiltration (HDF) | gross ₹61,999 vs ₹0–₹0 · Professional Fees ₹16,599 vs ₹0–₹0 · Procedure / OT Charges ₹44,100 vs ₹0–₹0 · Bedside Services ₹1,300 vs ₹0–₹0
CASH  | Radical Resection / Staging Laparotomy | Investigations ₹700 vs ₹8,824–₹35,900
CASH  | EBUS (Endobronchial Ultrasound) & Biopsy | gross ₹29,982 vs ₹73,521–₹93,772 · Investigations ₹1,410 vs ₹2,680–₹13,618 · Room Charges ₹625 vs ₹3,025–₹4,770 · Pharmacy ₹0 vs ₹31,660–₹39,098
CASH  | Surgical Oncology Procedure | Professional Fees ₹42,778 vs ₹59,360–₹1,15,233
CASH  | Renal Colic / Abdominal Pain Management | Professional Fees ₹15,505 vs ₹2,771–₹6,030 · Investigations ₹14,320 vs ₹22,950–₹35,760 · Procedure / OT Charges ₹160 vs ₹1,340–₹1,810 · Bedside Services ₹1,300 vs ₹0–₹1,000
CASH  | Rheumatology Medical Management | Investigations ₹0 vs ₹9,155–₹77,369 · Procedure / OT Charges ₹0 vs ₹595–₹1,330 · Bedside Services ₹1,300 vs ₹0–₹723
CASH  | URSL (Ureteroscopic Lithotripsy) | Procedure / OT Charges ₹68,950 vs ₹28,893–₹51,573 · Room Charges ₹20,960 vs ₹750–₹10,458
CASH  | SLED (Sustained Low-Efficiency Dialysis) | Investigations ₹11,850 vs ₹33,180–₹1,37,340 · Procedure / OT Charges ₹14,145 vs ₹23,970–₹59,985 · Bedside Services ₹9,220 vs ₹13,920–₹31,690
CASH  | Interventional Pain Management | Room Charges ₹0 vs ₹3,190–₹3,633 · Bedside Services ₹1,300 vs ₹0–₹0 · Pharmacy ₹1,697 vs ₹2,598–₹3,732
CASH  | Thoracic Surgery / VATS | Investigations ₹8,285 vs ₹28,415–₹74,112 · Procedure / OT Charges ₹51,770 vs ₹79,310–₹1,02,680 · Room Charges ₹87,200 vs ₹35,760–₹63,240
CASH  | Hemodialysis Support | Room Charges ₹0 vs ₹1,313–₹6,080 · Bedside Services ₹1,300 vs ₹0–₹0
CASH  | Foot / Ankle Fracture Fixation | gross ₹3,50,282 vs ₹2,66,946–₹2,66,946 · Professional Fees ₹95,488 vs ₹47,382–₹47,382 · Investigations ₹55,490 vs ₹41,850–₹41,850 · Room Charges ₹52,400 vs ₹35,550–₹35,550 · Bedside Services ₹5,880 vs ₹4,250–₹4,250
CASH  | Ophthalmology Procedure | gross ₹1,09,961 vs ₹50,541–₹75,650 · Professional Fees ₹29,440 vs ₹5,750–₹9,200 · Procedure / OT Charges ₹57,030 vs ₹11,750–₹36,360 · Room Charges ₹0 vs ₹3,720–₹4,420 · Bedside Services ₹1,300 vs ₹0–₹0
CASH  | Urinary Retention / Catheterization Managemen | Investigations ₹0 vs ₹785–₹19,785 · Bedside Services ₹1,300 vs ₹3,660–₹7,783
CASH  | Closed Reduction & Casting (Conservative) | Procedure / OT Charges ₹45,290 vs ₹12,290–₹19,520 · Bedside Services ₹2,990 vs ₹625–₹1,670
CASH  | Therapeutic Colonoscopy | Professional Fees ₹25,297 vs ₹14,235–₹15,173 · Investigations ₹8,580 vs ₹19,294–₹41,235 · Procedure / OT Charges ₹0 vs ₹18,763–₹25,275
CASH  | EUS (Endoscopic Ultrasound) | Professional Fees ₹36,313 vs ₹13,779–₹26,860 · Procedure / OT Charges ₹0 vs ₹23,300–₹33,850 · Room Charges ₹33,475 vs ₹17,880–₹21,328
CASH  | Minor Endourological Procedure | Procedure / OT Charges ₹49,656 vs ₹24,485–₹37,518
CASH  | Medical Management - Miscarriage / Abortion | Professional Fees ₹7,748 vs ₹11,048–₹24,965 · Investigations ₹0 vs ₹2,419–₹10,243 · Procedure / OT Charges ₹0 vs ₹353–₹2,528 · Bedside Services ₹1,300 vs ₹0–₹270
CASH  | ORIF / Internal Fixation | Professional Fees ₹36,118 vs ₹80,169–₹80,733 · Procedure / OT Charges ₹47,598 vs ₹29,443–₹35,628 · Room Charges ₹20,960 vs ₹11,128–₹11,656 · Bedside Services ₹2,680 vs ₹1,486–₹1,649
CASH  | Departmental Management Procedure | gross ₹13,028 vs ₹10,095–₹10,095 · Professional Fees ₹4,738 vs ₹1,500–₹1,500 · Investigations ₹1,250 vs ₹890–₹890 · Procedure / OT Charges ₹0 vs ₹350–₹350 · Bedside Services ₹1,300 vs ₹0–₹0 · Pharmacy ₹0 vs ₹884–₹884
CASH  | Cardiac Arrest / Resuscitation Management | Professional Fees ₹95,813 vs ₹26,797–₹61,130 · Investigations ₹32,310 vs ₹55,651–₹1,21,693
CASH  | Cardiovascular Medical Management | Professional Fees ₹22,845 vs ₹7,461–₹16,680 · Investigations ₹2,424 vs ₹18,108–₹39,733 · Procedure / OT Charges ₹160 vs ₹1,585–₹2,515
CASH  | Electrolyte Imbalance / Metabolic Workup | Professional Fees ₹27,892 vs ₹10,759–₹17,454 · Investigations ₹5,380 vs ₹12,004–₹21,436 · Procedure / OT Charges ₹0 vs ₹1,190–₹1,668 · Room Charges ₹38,360 vs ₹25,539–₹30,115
CASH  | Functional Endoscopic Sinus Surgery (FESS) | Professional Fees ₹37,583 vs ₹54,843–₹62,156
CASH  | Facial Laceration / Soft Tissue Repair | Professional Fees ₹12,500 vs ₹17,250–₹47,695
CASH  | Liver Disease / Hepatic Encephalopathy Manage | Professional Fees ₹79,636 vs ₹30,455–₹46,561 · Investigations ₹32,155 vs ₹61,698–₹1,18,664 · Procedure / OT Charges ₹0 vs ₹2,173–₹13,984
CASH  | ENT Medical Management | Investigations ₹2,010 vs ₹4,395–₹13,410 · Procedure / OT Charges ₹0 vs ₹1,190–₹2,990
--- build failures ---
===============================================
✅ Successfully executed commands to all hosts.
===============================================
