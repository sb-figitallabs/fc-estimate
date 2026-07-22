# Review — Medical management

**Input reviewed:** `newinps.docx` → "Medical Management" tab (+ the "doctors write high-value items that can be auto-added" note for Subha).
**What this tab decides:** not one generic medical estimate — a menu of ~15 clinical families × ward/ICU/daycare setting, with exact room + PF and ranged pharmacy/investigations; doctor-stated high-value items auto-added.

## 1. ✅ Safe / additive
- The **setting split is real and large**: ward P50 ₹73.5k, ICU-involved P50 ₹1.73L, daycare/observation P50 ₹28.2k. Model as families (general/undifferentiated, fever/infection, sepsis, respiratory, cardiac, neuro, GI/hepatology, renal, endocrine, onco/haem, paediatric, neonatal, obstetric observation, toxicology/trauma).
- **Exact room + governed PF; historical ranges for pharmacy/investigations/variable bedside services.** Doctor-written tests / high-value items captured as a structured input and confirmed (matches the hospital note).
- **Hybrid mapping** (Step 1 explicit treatment → dedicated pathway; Step 2 explicit diagnosis → auto-select+confirm; Step 3 symptom-only → ranked suggestions; Step 4 "medical management" only → department + wide range; Step 5 multiple conditions → one primary + secondaries). Preserve original text + normalized family + mapping reason.

## 2. ⚠️ Could worsen currently-verified logic
- **Route out of generic medical management** (own pathways): chemotherapy, immunotherapy, dialysis/CRRT, blood transfusion, bronchoscopy, endoscopy, interventional radiology, planned procedures, medical-management-plus-procedure. The 38 procedure-like "medical" records must not appear as medical-management options.
- The existing **general-medical template is a 28-admission cash cohort** — must **not** be deployed as the universal medical estimate.

## 3. ⛔ Reality check / blocked
- Of 1,071 medical scenarios, only **7 are historically estimable and none are production-certified** — present as **policy-first with wide ranges + confidence flags**, refreshed after 24h / on ICU transfer / LOS change / high-cost investigation / pharmacy escalation. Don't pretend a precise diagnosis is established when the doctor wrote only "medical management".
- FC remarks are mostly counselling language — the doctor-written indication must be a structured, confirmed input.

## 4. Validation we'll run first
Reproduce the ward/ICU/daycare P25–P75 bands and the 7 estimable scenarios on our data; confirm the procedure-like records are excluded from the medical menu.
