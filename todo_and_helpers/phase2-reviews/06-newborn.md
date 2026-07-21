# Review — Newborn

**Input reviewed:** `newinps.docx` → "New Born" tab.
**What this tab decides:** four newborn pathways — healthy-with-mother, well-baby-in-delivery-package, phototherapy, NICU — not one "newborn" estimate.

## 1. ✅ Safe / additive (new pathway, low risk to existing estimates)
- **Healthy newborn with mother = ₹0 separate bed** + neonatologist/paediatrician PF (historical modes ₹8,000 then ₹4,000) + screening + bilirubin/blood-group investigations. Confirmed: 125/127 no-declared-room cases had zero room charge; median room ₹0.
- **Well-baby inside a maternal delivery package:** attach the baby to the mother's admission/package, add only excluded items, don't add a second room charge or a separate newborn base package; for twins don't multiply a package that already says "single/twins".
- **Phototherapy** and **NICU** are separate, day-based pathways (bed × days + phototherapy/NICU rate + PF + investigations + pharmacy), each shown as its own scenario — not a checkbox on routine care.

## 2. ⚠️ Could worsen currently-verified logic
- The word "newborn" must **never auto-add a bed or PF** — provisionally select healthy/well-baby, then confirm: healthy-with-mother? phototherapy? NICU? twins? included in mother's package?
- **NICU days must come from NICU room-service codes**, not the generic `icu_days` field (which doesn't reliably capture them) — otherwise NICU estimates will be wrong.

## 3. ⛔ Blocked
- **No governed standalone newborn / phototherapy / NICU package master** — tariff-itemise until the hospital supplies exact package codes/rates/inclusions/payer scope. Any "newborn/phototherapy package" remark → `package_reference_unverified` (not a financial fact). **(N3)**
- **No cradle service code** — a baby-warmer code must not substitute. **(N3)**
- Needs a governed **mother–baby IP linkage** (see the mother-linked-bed tab, file 07).

## 4. Validation we'll run first
Reproduce the 144 healthy-newborn cohort (median PF ₹8,000, cash bill P25/P50/P75 ≈ ₹9.2k/₹15.1k/₹18.9k) and the phototherapy/NICU distributions on our data before wiring the pathways.
