# Inclusion / Exclusion Text — AI Rewrite: Approval Samples

**Purpose:** Before we run an AI rewrite over ALL package inclusion/exclusion texts, this doc shows the own reference rewrite (Sample 0) plus 5 real before/after samples (pulled live from the fc-estimate engine, tariff TR1) redone in that exact style, for sign-off.
**Rule set the bulk run will follow (extracted from the reference rewrite, Sample 0):** content must stay faithful — every substantive item and rupee figure preserved, nothing added; wording is a flat, compact bullet list of "Label: value" lines (no bold-heavy nesting, no sub-bullet per service item); IP and OT pharmacy are combined into one "Pharmacy:" line; caps are phrased "Up to ₹X"; room-wise figures use compact notation "₹7,260 (Twin) / ₹7,920 (Single)" and collapse to a single number when identical across room types; the comma-run of OT/ward service items is grouped into thematic lines (OT & Procedure Charges, Routine Consumables & Nursing, Catheter Care, Pre-operative Care, Medical Records, Consultations, Monitoring); a procedure row becomes its own labeled line; trivial "×1" counts are omitted while meaningful quantities (days, hours, "1 each", session counts) are kept; internal codes like OP-10 are omitted from the patient-facing text (always preserved in the original/audit column); OCR junk, stray pipes and `0 - 0,` fragments are cleaned up.
**Grouping:** each rewrite is structured as "What the package covers" and "What is NOT covered (billed extra)", each rendered as a flat bullet list.
**Storage:** two columns — the clean patient-facing text shown on the estimate, plus the original text preserved unchanged for audit (internal codes such as OP-10 live only in the original/audit column).
**Data flags:** where the stored text contains duplicated/conflicting blocks (two tariff versions pasted together), the rewrite keeps both and flags them for data-team reconciliation — the AI never silently picks one.
**Action requested:** please approve these samples as-is, or annotate directly on this doc with corrections to the tone/structure/rules before we start the bulk run.

---

## Sample 0 — reference (Robotic TKR Unilateral)

### ORIGINAL (as stored)

```
- | Hospital Stay | 2 day-ward , 1 day-ICU |
- | Pharmacy Charges : IP | 15000 |
- | Pharmacy Charges : OT | 50000 |
- | Implants | 90000 |
- | Investigations : | TWIN-7260,SINGLE-7920, |
- | Surgeon Charges : | TWIN - 65000,SINGLE - 65000, |
- | Anaesthesia charges : | TWIN - 16250,SINGLE - 16250, |
- | Assistants Surgeon & Anaesthesia: | As per the policy |
- OT - 3 HOURS - 1,INSTRUMENT CHARGES (MAJOR) - 1,OP-10 - 3,SYRINGE PUMP PER DAY - 3,DRESSING-MINOR - 1
- MONITOR PER DAY - 2,FOLEY'S CATHETERIZATION - 1,MEDICAL RECORDS- > 1 DAY - 1,OT DISINFECTION CHARGES - 1
- PRE ANAESTHETIST CHECK - 1,WARMER - 1,FOLEYS CATHETER REMOVAL - 1,CSSD CHARGES FOR GA - 1
- ENDOCRINOLOGY CONSULTANT - 1,WARD CONSUMABLES - 3,POST SURGERY RECOVERY CHARGES - 1,PHYCISIAN CONSULTATION - 1
- NEPHROLOGIST - 1,CARDIOLOGY CONSULTATION - 1,PULMONOLOGY CONSULTATION - 1,ROBO (TKR) - UNILATERAL - 1
```

```
- Cross Consultation.
- Virology Disposable Kit.
- Ventilator Charges.
- Patient attender Food & Beverages, additional orders.
- All medications and investigations other than Procedure.
- Diabetic Management.
- Beyond the package days, all services and investigations are charged based on actual costs.
```

### REWRITE (canonical style)

```
- Hospital Stay: 2 days Ward + 1 day ICU
- Pharmacy: IP medicines up to ₹15,000 + OT medicines up to ₹50,000
- Implants: Up to ₹90,000
- Investigations: ₹7,260 (Twin) / ₹7,920 (Single)
- Surgeon Charges: ₹65,000
- Anaesthesia Charges: ₹16,250
- Assistant Surgeon & Anaesthesia: As per hospital policy
- Robotic Surgery: Unilateral Robotic TKR
- OT & Procedure Charges: 3 OT hours, major instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, dressing (minor), syringe pump (3 days), monitor (2 days), warmer
- Catheter Care: Foley’s catheter insertion & removal
- Pre-operative Care: Pre-anaesthetist check
- Medical Records
- Consultations (1 each): Physician, Endocrinology, Nephrology, Cardiology, Pulmonology
```

```
- Cross-specialty consultations beyond those listed
- Virology disposable kit
- Ventilator charges
- Attender food & beverages and additional patient orders
- Any medications or investigations not related to the procedure
- Diabetic management
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)
```

---

## Sample 1 — TOTAL KNEE REPLACEMENT (TKR) - LEFT (`ORT5510`)

Package amount: ₹2,55,000 (Twin) / ₹2,80,000 (Single) · Package duration: 3 days

### ORIGINAL (as stored)

```
- Hospital Stay | 2 day-ward , 1 day-ICU
- Pharmacy Charges : IP | 15000
- Pharmacy Charges : OT | 35000
- Implants | 75000
- Investigations : | TWIN-7260,SINGLE-7920,
- Surgeon Charges : | TWIN - 50000,SINGLE - 50000,
- Anaesthesia charges : | TWIN - 12500,SINGLE - 12500,
- Assistants Surgeon & Anaesthesia: | As per the policy
- OT - 3 HOURS - 1,INSTRUMENT CHARGES (MAJOR) - 1,OP-10 - 10,SYRINGE PUMP PER DAY - 3,DRESSING-MINOR - 2,MONITOR PER DAY - 2,FOLEY'S CATHETERIZATION - 1,MEDICAL RECORDS- > 1 DAY - 1,OT DISINFECTION CHARGES - 1,PRE ANAESTHETIST CHECK - 1,WARMER - 1,FOLEYS CATHETER REMOVAL - 1,0 - 0,CSSD CHARGES FOR GA - 1,ENDOCRINOLOGY CONSULTANT - 1,WARD CONSUMABLES - 3,POST SURGERY RECOVERY CHARGES - 1,PHYCISIAN CONSULTATION - 1,NEPHROLOGIST - 1,CARDIOLOGY CONSULTATION - 1,PULMONOLOGY CONSULTATION - 1,

- Hospital Stay | 2 day-ward , 1 day-ICU
- Pharmacy Charges : IP | 15000
- Pharmacy Charges : OT | 35000
- Implants | 75000
- Investigations : | TWIN-8000,SINGLE-8000,
- Surgeon Charges : | TWIN - 50000,SINGLE - 50000,
- Anaesthesia charges : | TWIN - 12500,SINGLE - 12500,
- Assistants Surgeon & Anaesthesia: | As per the policy
- OT - 3 HOURS - 1,INSTRUMENT CHARGES (MAJOR) - 1,OP-10 - 10,SYRINGE PUMP PER DAY - 3,DRESSING-MINOR - 2,MONITOR PER DAY - 2,FOLEY'S CATHETERIZATION - 1,MEDICAL RECORDS- > 1 DAY - 1,OT DISINFECTION CHARGES - 1,PRE ANAESTHETIST CHECK - 1,WARMER - 1,FOLEYS CATHETER REMOVAL - 1,0 - 0,CSSD CHARGES FOR GA - 1,ENDOCRINOLOGY CONSULTANT - 1,WARD CONSUMABLES - 3,POST SURGERY RECOVERY CHARGES - 1,PHYCISIAN CONSULTATION - 2,NEPHROLOGIST - 2,CARDIOLOGY CONSULTATION - 2,PULMONOLOGY CONSULTATION - 2,
```

```
- Cross Consultation.
- Virology Disposable Kit.
- Ventilator Charges.
- Patient attender Food & Beverages, additional orders.
- All medications and investigations other than Procedure.
- Diabetic Management.
- Beyond the package days, all services and investigations are charged based on actual costs.
```

> DATA FLAG: the stored inclusions contain two near-identical blocks with conflicting figures — Investigations ₹7,260/₹7,920 (Twin/Single) vs ₹8,000/₹8,000, and specialist consultations 1 each vs 2 each. Both versions are preserved below; needs reconciliation before publishing.

### PROPOSED PATIENT-FACING REWRITE

**What the package covers**

- Hospital Stay: 2 days Ward + 1 day ICU
- Pharmacy: IP medicines up to ₹15,000 + OT medicines up to ₹35,000
- Implants: Up to ₹75,000
- Investigations: ₹7,260 (Twin) / ₹7,920 (Single) *(a second stored version says ₹8,000 for both room types — under reconciliation)*
- Surgeon Charges: ₹50,000
- Anaesthesia Charges: ₹12,500
- Assistant Surgeon & Anaesthesia: As per hospital policy
- OT & Procedure Charges: 3 OT hours, major instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, dressing (minor ×2), syringe pump (3 days), monitor (2 days), warmer
- Catheter Care: Foley’s catheter insertion & removal
- Pre-operative Care: Pre-anaesthetist check
- Medical Records
- Consultations (1 each): Physician, Endocrinology, Nephrology, Cardiology, Pulmonology *(a second stored version lists Physician, Nephrology, Cardiology and Pulmonology at 2 each — under reconciliation)*

**What is NOT covered (billed extra)**

- Cross-specialty consultations beyond those listed
- Virology disposable kit
- Ventilator charges
- Attender food & beverages and additional patient orders
- Any medications or investigations not related to the procedure
- Diabetic management
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)

---

## Sample 2 — TOTAL KNEE REPLACEMENT (TKR) - RIGHT (`ORT5511`)

Package amount: ₹2,55,000 (Twin) / ₹2,80,000 (Single) · Package duration: 3 days

### ORIGINAL (as stored)

```
- Hospital Stay | 2 day-ward , 1 day-ICU
- Pharmacy Charges : IP | 15000
- Pharmacy Charges : OT | 35000
- Implants | 75000
- Investigations : | TWIN-7260,SINGLE-7920,
- Surgeon Charges : | TWIN - 50000,SINGLE - 50000,
- Anaesthesia charges : | TWIN - 12500,SINGLE - 12500,
- Assistants Surgeon & Anaesthesia: | As per the policy
- OT - 3 HOURS - 1,INSTRUMENT CHARGES (MAJOR) - 1,OP-10 - 10,SYRINGE PUMP PER DAY - 3,DRESSING-MINOR - 2,MONITOR PER DAY - 2,FOLEY'S CATHETERIZATION - 1,MEDICAL RECORDS- > 1 DAY - 1,OT DISINFECTION CHARGES - 1,PRE ANAESTHETIST CHECK - 1,WARMER - 1,FOLEYS CATHETER REMOVAL - 1,0 - 0,CSSD CHARGES FOR GA - 1,ENDOCRINOLOGY CONSULTANT - 1,WARD CONSUMABLES - 3,POST SURGERY RECOVERY CHARGES - 1,PHYCISIAN CONSULTATION - 1,NEPHROLOGIST - 1,CARDIOLOGY CONSULTATION - 1,PULMONOLOGY CONSULTATION - 1,
```

```
- Cross Consultation.
- Virology Disposable Kit.
- Ventilator Charges.
- Patient attender Food & Beverages, additional orders.
- All medications and investigations other than Procedure.
- Diabetic Management.
- Beyond the package days, all services and investigations are charged based on actual costs.

---
```

### PROPOSED PATIENT-FACING REWRITE

**What the package covers**

- Hospital Stay: 2 days Ward + 1 day ICU
- Pharmacy: IP medicines up to ₹15,000 + OT medicines up to ₹35,000
- Implants: Up to ₹75,000
- Investigations: ₹7,260 (Twin) / ₹7,920 (Single)
- Surgeon Charges: ₹50,000
- Anaesthesia Charges: ₹12,500
- Assistant Surgeon & Anaesthesia: As per hospital policy
- OT & Procedure Charges: 3 OT hours, major instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, dressing (minor ×2), syringe pump (3 days), monitor (2 days), warmer
- Catheter Care: Foley’s catheter insertion & removal
- Pre-operative Care: Pre-anaesthetist check
- Medical Records
- Consultations (1 each): Physician, Endocrinology, Nephrology, Cardiology, Pulmonology

**What is NOT covered (billed extra)**

- Cross-specialty consultations beyond those listed
- Virology disposable kit
- Ventilator charges
- Attender food & beverages and additional patient orders
- Any medications or investigations not related to the procedure
- Diabetic management
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)

---

## Sample 3 — LAP. CHOLECYSTECTOMY - PA (`SGA5166`)

Package amount: ₹96,000 · Package duration: 2 days

### ORIGINAL (as stored)

```
- Hospital Stay | 2 day-ward , 0 day-ICU
- Pharmacy Charges up to Rs. | 23000
- Investigations | BIOPSY SMALL
- Surgeon Charges: | GENERAL WARD - 23140,TWIN - 24550,SINGLE - 31000,DELUXE - 38570,SUITE - 41720,
- Anaesthetist Charges | GENERAL WARD-5780,TWIN-6140,SINGLE-7750,DELUXE-9640,SUITE-10430,
- Assistant surgeon and anesthesia charges | As per policy
- Drug Administration Charges for ( pharmacy)OT - 1 1/2 HOUR - 1,CSSD CHARGES FOR GA - 1,OT DISINFECTION CHARGES - 1,WARD CONSUMABLES - 2,POST SURGERY RECOVERY CHARGES - 1,DIET CONSULTATION - 1,MONITOR PER DAY - 1,CAMERA - 1,MEDICAL RECORDS- > 1 DAY - 1,LAPROSCOPY INSTRUMENTS - MINOR - 1,OXYGEN PER HOUR - 1,HARMONIC SCALPEL (30-60 MINS) - 1,
```

```
- DMO CHARGES -2
- Cross Consultation.
- HIV, HBSAG, HCV Disposable Kit.
- All medications and investigations other than Procedure.
- Diabetic Managements
- Special Equipment Charges.
- Beyond the package days, all services and investigations are charged based on actual costs.
```

### PROPOSED PATIENT-FACING REWRITE

**What the package covers**

- Hospital Stay: 2 days Ward (no ICU)
- Pharmacy: Up to ₹23,000
- Investigations: Small biopsy
- Surgeon Charges: ₹23,140 (General Ward) / ₹24,550 (Twin) / ₹31,000 (Single) / ₹38,570 (Deluxe) / ₹41,720 (Suite)
- Anaesthetist Charges: ₹5,780 (General Ward) / ₹6,140 (Twin) / ₹7,750 (Single) / ₹9,640 (Deluxe) / ₹10,430 (Suite)
- Assistant Surgeon & Anaesthesia: As per hospital policy
- OT & Procedure Charges: 1.5 OT hours, laparoscopy camera, laparoscopy instruments (minor), harmonic scalpel (30–60 mins), OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, monitor (1 day), oxygen (1 hour)
- Medical Records
- Consultations: Diet consultation

**What is NOT covered (billed extra)**

- Duty medical officer (DMO) charges (2)
- Cross-specialty consultations
- HIV, HBsAg & HCV disposable kit
- Any medications or investigations not related to the procedure
- Diabetic management
- Special equipment charges
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)

---

## Sample 4 — LSCS (CAESAREAN SECTION) - PA (`GYN5219`)

Package amount: ₹90,000 · Package duration: 3 days

### ORIGINAL (as stored)

```
- Hospital Stay | 3 day-ward , 0 day-ICU
- Pharmacy Charges up to Rs. | 25000
- Investigations | NIL
- Surgeon Charges: | GENERAL WARD - 19670,TWIN - 21580,SINGLE - 28640,Deluxe - 37300,Suite - 41900,
- Anaesthetist Charges | GENERAL WARD-4920,TWIN-5400,SINGLE-7160,Deluxe-9320,Suite-10470,
- Assistant surgeon and anesthesia charges | As per policy
- Drug Administration Charges for ( pharmacy)OT - 1 1/2 HOUR - 1,WARD CONSUMABLES - 3,CSSD CHARGES FOR GA - 1,OT DISINFECTION CHARGES - 1,MEDICAL RECORDS- > 1 DAY - 1,DIET CONSULTATION - 1,PRE ANAESTHETIST CHECK - 1,FOLEY'S CATHETERIZATION - 1,POST SURGERY RECOVERY CHARGES - 1,INSTRUMENT CHARGES (MEDIUM) - 1,CTG MONITOR-HALF DAY - 1,FOLEYS CATHETER REMOVAL - 1,OXYGEN PER HOUR - 2,
- DMO-3

- Hospital Stay : | Room Days-3,ICCU days-0
- Pharmacy Charges : | 20000
- Peadiatrician Charges : | 5000
- Surgeon Charges : | GENERAL WARD-13710,TWIN-15140,SINGLE-16680,DELUXE-22500,SUITE-30000,
- Anaesthesia charges Rs. | GENERAL WARD-3430,TWIN-3790,SINGLE-4170,DELUXE-5630,SUITE-7500,
- Assistants Surgeon & Anaesthesia | As per the policy
- Drug Administration Charges for ( pharmacy),OT - 1 1/2 HOUR - 1,OT DISINFECTION CHARGES - 1,INSTRUMENT CHARGES (MAJOR) - 1,MEDICAL RECORDS- > 1 DAY - 1,MONITOR PER DAY - 1,CTG MONITOR-HALF DAY - 1,FOLEY'S CATHETERIZATION - 1,DIET CONSULTATION - 1,0 - 0,CSSD CHARGES FOR GA - 1,POST SURGERY RECOVERY CHARGES - 1,Ward Consumables - 3,SYRINGE PUMP PER DAY - 1,INFUSION PUMP - 1,WARMER - 1,OXYGEN PER HOUR - 2,OP-10 - 2,
```

```
- Cross Consultation.
- HIV, HBSAG, HCV Disposable Kit.
- All medications and investigations other than Procedure.
- Diabetic Managements
- Special Equipment Charges.
- Beyond the package days, all services and investigations are charged based on actual costs.

- Room Rents and doctors fee cost beyond 3 days of stay for whatever reason
- Cross Consultation
- Any extra ordinary costly drugs and disposable like Anti D Ig and Baby vaccines
- Tubectomy charges, twin Baby Delivery, Muhurtham charges
- High Risk charges Charged Extra
- All medications and investigations other than Procedure
- Special Equipments Charges
- Diabetic Managements
- Beyond package days All services & Investigations are at actual
```

> DATA FLAG: the stored text contains two different tariff versions merged together (e.g. pharmacy limit ₹25,000 vs ₹20,000; surgeon fee General Ward ₹19,670 vs ₹13,710; the older version also lists a paediatrician fee of ₹5,000). Both versions are preserved below; needs reconciliation before publishing.

### PROPOSED PATIENT-FACING REWRITE

**What the package covers — Version A (current)**

- Hospital Stay: 3 days Ward (no ICU)
- Pharmacy: Up to ₹25,000
- Investigations: None included
- Surgeon Charges: ₹19,670 (General Ward) / ₹21,580 (Twin) / ₹28,640 (Single) / ₹37,300 (Deluxe) / ₹41,900 (Suite)
- Anaesthetist Charges: ₹4,920 (General Ward) / ₹5,400 (Twin) / ₹7,160 (Single) / ₹9,320 (Deluxe) / ₹10,470 (Suite)
- Assistant Surgeon & Anaesthesia: As per hospital policy
- Duty Medical Officer (DMO): 3 visits
- OT & Procedure Charges: 1.5 OT hours, medium instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, oxygen (2 hours)
- Monitoring: CTG monitor (half day)
- Catheter Care: Foley’s catheter insertion & removal
- Pre-operative Care: Pre-anaesthetist check
- Medical Records
- Consultations: Diet consultation

**What the package covers — Version B (older stored block, retained for audit)**

- Hospital Stay: 3 Room days (no ICCU)
- Pharmacy: Up to ₹20,000
- Paediatrician Charges: ₹5,000
- Surgeon Charges: ₹13,710 (General Ward) / ₹15,140 (Twin) / ₹16,680 (Single) / ₹22,500 (Deluxe) / ₹30,000 (Suite)
- Anaesthesia Charges: ₹3,430 (General Ward) / ₹3,790 (Twin) / ₹4,170 (Single) / ₹5,630 (Deluxe) / ₹7,500 (Suite)
- Assistant Surgeon & Anaesthesia: As per hospital policy
- OT & Procedure Charges: 1.5 OT hours, major instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, syringe pump (1 day), infusion pump, monitor (1 day), warmer, oxygen (2 hours)
- Monitoring: CTG monitor (half day)
- Catheter Care: Foley’s catheter insertion
- Medical Records
- Consultations: Diet consultation

**What is NOT covered (billed extra)** *(combined from both stored lists; duplicates merged)*

- Cross-specialty consultations
- HIV, HBsAg & HCV disposable kit
- Any medications or investigations not related to the procedure
- Diabetic management
- Special equipment charges
- Room rent and doctors' fees beyond 3 days of stay, for any reason
- Unusually costly drugs & disposables (e.g. Anti-D immunoglobulin, baby vaccines)
- Tubectomy charges, twin baby delivery, muhurtham charges
- High-risk charges (charged extra)
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)

---

## Sample 5 (optional extra) — LSCS (CAESAREAN SECTION) - EMERGENCY (`GYN5322`)

Package amount by room: General Ward ₹1,35,000 / Twin ₹1,46,000 / Single ₹1,70,000 / Deluxe ₹1,98,000 / Suite ₹2,20,000 · Package duration: 3 days

### ORIGINAL (as stored)

```
- Hospital Stay | 3 day-ward , 0 day-ICU
- Pharmacy Charges up to Rs. | 28000
- Investigations | NIL
- Surgeon Charges: | GENERAL WARD - 34200,TWIN - 36140,SINGLE - 44170,Deluxe - 52430,Suite - 57720,
- Anaesthetist Charges | GENERAL WARD-8550,TWIN-9030,SINGLE-11040,Deluxe-13110,Suite-14430,
- Assistant surgeon and anesthesia charges | As per policy
- Drug Administration Charges for ( pharmacy)OT - 1 1/2 HOUR - 1,WARD CONSUMABLES - 3,CSSD CHARGES FOR GA - 1,OT DISINFECTION CHARGES - 1,DIET CONSULTATION - 1,MEDICAL RECORDS- > 1 DAY - 1,FOLEY'S CATHETERIZATION - 1,POST SURGERY RECOVERY CHARGES - 1,INSTRUMENT CHARGES (MEDIUM) - 1,MONITOR PER DAY - 1,FOLEYS CATHETER REMOVAL - 1,CTG MONITOR-HALF DAY - 2,OXYGEN PER HOUR - 2,GRBS - 6,
- DMO-3
```

```
- Cross Consultation.
- HIV, HBSAG, HCV Disposable Kit.
- All medications and investigations other than Procedure.
- Diabetic Managements
- Special Equipment Charges.
- Beyond the package days, all services and investigations are charged based on actual costs.
```

### PROPOSED PATIENT-FACING REWRITE

**What the package covers**

- Hospital Stay: 3 days Ward (no ICU)
- Pharmacy: Up to ₹28,000
- Investigations: None included
- Surgeon Charges: ₹34,200 (General Ward) / ₹36,140 (Twin) / ₹44,170 (Single) / ₹52,430 (Deluxe) / ₹57,720 (Suite)
- Anaesthetist Charges: ₹8,550 (General Ward) / ₹9,030 (Twin) / ₹11,040 (Single) / ₹13,110 (Deluxe) / ₹14,430 (Suite)
- Assistant Surgeon & Anaesthesia: As per hospital policy
- Duty Medical Officer (DMO): 3 visits
- OT & Procedure Charges: 1.5 OT hours, medium instrument charges, OT disinfection, CSSD (GA), post-surgery recovery
- Routine Consumables & Nursing: Ward consumables, monitor (1 day), oxygen (2 hours)
- Monitoring: CTG monitor (2 half-day sessions), blood sugar checks (GRBS, 6)
- Catheter Care: Foley’s catheter insertion & removal
- Medical Records
- Consultations: Diet consultation

**What is NOT covered (billed extra)**

- Cross-specialty consultations
- HIV, HBsAg & HCV disposable kit
- Any medications or investigations not related to the procedure
- Diabetic management
- Special equipment charges
- Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)

---

## Notes on cleanup decisions applied in these samples (the bulk run will follow the same)

1. **Style follows the canonical sample (Sample 0).** Flat "Label: value" bullet lists; IP + OT pharmacy combined into one line; caps phrased "Up to ₹X"; room-wise figures in compact "₹X (Twin) / ₹Y (Single)" notation, collapsed to a single number when identical across room types; the comma-run of OT/ward service items grouped into thematic lines (OT & Procedure Charges, Routine Consumables & Nursing, Catheter Care, Pre-operative Care, Medical Records, Consultations, Monitoring); procedure rows get their own labeled line.
2. **Every substantive item and rupee figure preserved, nothing added.** The only removed tokens are pure OCR junk (the stray `0 - 0,` entries, trailing commas/pipes) and trivial "×1" counts; meaningful quantities (days, hours, "1 each", session counts) are kept.
3. **Internal codes are omitted from the patient-facing text.** Per the sample, cryptic internal codes like `OP-10` are dropped from the clean text and always preserved in the original/audit column. If the billing team supplies a glossary, the bulk run can expand these into patient-friendly terms instead.
4. **Merged/duplicated blocks are flagged, not resolved.** Samples 1 and 4 show the flag format. The AI keeps both versions and marks the record for data-team reconciliation.
5. **Two-column storage:** `inclusions_text_clean` / `exclusions_text_clean` shown to patients on the estimate; original `inclusions_text` / `exclusions_text` untouched for audit.

**Manager:** please approve, or annotate the specific samples/rules you want changed.
