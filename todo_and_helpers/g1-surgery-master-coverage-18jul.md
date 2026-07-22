# Surgery Master ↔ past IP patients — coverage report (G1)

**Date:** 18 Jul 2026 · **Input:** `Surgery Master _SSG.xlsx` (14,885 rows → 7,938 distinct surgery codes across 38 tariffs), ingested as `fc.surgery_master` · **Tested against:** the surgical billing extract (12,648 IP admissions) and the full IP history mart (14,202 admissions).

## Verdict — yes, our IP patients map cleanly to this list

**~98% of billed surgical admissions carry a code or name from the master, and 95% of ALL surgical IP admissions map through their bills.** Medical-management admissions map almost never (1.6%) — exactly as you said: they have no proper surgery list, and the data confirms it.

## A. Surgical billing extract — "the codes should be present in their bill" ✅

Of the 12,648 admissions in the billing extract, 7,039 record a surgery (the rest are open-bill / medical rows). Of those 7,039:

| Payer | With surgery | Code in master | Name-only match | **Mappable** | Unmapped |
|---|---|---|---|---|---|
| Insurance | 4,346 | 3,690 (84.9%) | 553 | **4,243 (97.6%)** | 103 |
| Private (cash) | 2,374 | 2,089 (88.0%) | 238 | **2,327 (98.0%)** | 47 |
| International | 191 | 182 | 6 | **188 (98.4%)** | 3 |
| Corporate | 128 | 108 | 14 | **122 (95.3%)** | 6 |
| **Total** | **7,039** | **6,069 (86.2%)** | **811** | **6,880 (97.7%)** | **159 (2.3%)** |

## B. Full IP history (mart, 14,202 admissions) — mapped via any billed evidence

Evidence tested per admission: OT-booking surgery codes, the billed package code, and bill-line service codes vs the master.

| Class | Admissions | **Mapped to master** | via OT surgery code | via package code | via bill lines |
|---|---|---|---|---|---|
| Surgical | 7,781 | **7,406 (95.2%)** | 7,390 | 3,912 | 3,063 |
| Medical mgmt | 6,421 | 103 (1.6%) | 102 | 74 | 68 |

The OT-booking surgery code is the strongest single signal (95% of surgical admissions carry one that's in the master) — it is effectively the bill-side twin of the FC's dropdown pick.

## What the ~2–5% unmapped cases are (two clean classes)

1. **Codes billed but missing from the master (~159 admissions in the extract).** Real surgery codes in bills that the sheet doesn't contain — examples: `GAS5199` 24-hr pH Impedance (Package), `ORT5667` Ankle Ligament Repair, `URO5578` DJ Stent Removal Bilateral w/ Anesthesia (Daycare), `GYN5067` D&C - PB, `PDC0001` Paediatric ASD, `ORT5669` Complex Bipolar Hemiarthroplasty, `NES5121` Debridement, `SGA5177` Excision of Large Dermoid Cyst. **→ These look like additions the master needs — we can export the full list for the hospital to reconcile.**
2. **Legacy OT naming on older admissions (mostly 2024-series `IPGB2425…`).** OT bookings recorded under old free-text names ("KNEE REPLACEMENT (SINGLE TKR LEFT)", "LAMBAR SPINAL FUSION - EC" [sic]) whose codes predate the current master. These fade out naturally in newer data.

## What this means for flow selection (G2)

The master is a reliable canonical layer: doctor's wording → master `SURGERYNAME` (per tariff) → billed code — the same mapping the FC does by hand with the dropdown today. We'll wire `fc.surgery_master` into the stage-1 resolve/gate as a first-class matching corpus (expected to also fix the DJ-stenting "minor procedure vs cysto package" ranking case). Medical-management wording correctly stays outside it and rides our medical-family path.

## Artifacts

- `fc.surgery_master` — loaded and indexed (re-runnable: `scripts/g1-surgery-master-coverage.js`).
- Full unmapped-code export available on request (one query away).
