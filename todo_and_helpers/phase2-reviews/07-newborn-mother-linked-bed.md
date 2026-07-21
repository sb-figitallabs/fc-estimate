# Review — Newborn: mother-linked bed

**Input reviewed:** `newinps.docx` → "New Born 2" tab (hospital's admission-workflow clarification).
**What this tab decides:** the newborn is a separate IP linked to the mother via a "dollar bed" (e.g. `522§1`); that linked bed is a location, not a billable bed while the baby rooms with the mother.

## 1. ✅ Safe / clarifies the model
- Store the linked bed as `bed_type = MOTHER_LINKED_BABY_BED` with `parent_room = 522`, `linked_baby_sequence`, `separate_bed_charge_applicable = false`; **room rate ₹0** while the baby stays in the linked bed. The baby may inherit the mother's room category for context only.
- **Twins = separate baby admissions** (`522§1` / `522§2`) — never combine charges just because they share the mother's room.
- **Separate bed billing begins** only when: (a) the baby moves to NICU/nursery/another chargeable location, or (b) the mother is discharged while the baby remains admitted. Model the stay in segments (₹0 while rooming-in → chargeable from the transfer/discharge point).

## 2. ⚠️ Needs data before automation
- Requires four fields to automate correctly: **mother admission no., linked dollar-bed number, mother discharge timestamp, baby room-transfer timestamp.** Until those exist, this is an FC-input-driven segment model.
- Do **not** interpret a missing baby-bed charge as "incomplete billing".

## 3. ⛔ Blocked
- Same masters gap as file 06 (no standalone newborn package, no cradle code). This tab resolves the *linkage/bed* question; it does not resolve pricing.

## 4. Note
507 baby/neonatal clean admissions support three states (rooming-in = no room rent/no ward consumables; NICU = ICU billing; mother-discharged = ordinary bed from that point) — good validation base once the linkage fields are available.
