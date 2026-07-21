# Review — Tax & attendant room

**Input reviewed:** `newinps.docx` → "TAX and Attendant Room" tab.
**What this tab decides:** 5% GST on non-ICU room rent above ₹5,000/day (on the full amount); ICU/CCU/NICU exempt; attendant room carries 18% GST but has no code yet.

## 1. ✅ Ready to implement now — the highest-confidence tab
- **5% GST on non-ICU room rent >₹5,000/day, on the *full* room-rent amount** (not just the excess). Exactly ₹5,000 → ₹0. **ICU/CCU/ICCU/NICU exempt** even above ₹5,000. Statutory (CBIC, effective 18-Jul-2022; 2.5% CGST + 2.5% SGST).
- **Historical compliance 99.68%** (15,092 taxed lines; 879/879 at-₹5,000 correctly untaxed; 12,049/12,049 ICU untaxed) — the rule is safe to forward-calculate.
- **Tax by service code, not ward name** — a regular single-room code in a ward named "MICU" still carries 5%; the category belongs to the code.
- **Line-level automatic GST**; the estimate shows a separate "GST on room rent @ 5%" line. **Packages:** tax only the identifiable room component, never the whole package amount (avoid double-count when the package already includes GST).
- Same GST math for all payers; payer logic only decides who bears it.

## 2. ⚠️ Guard rails
- Do **not** apply 5% to the whole hospital bill, nor to nursing/pharmacy/consultations/bedside services/meals — room rent only.

## 3. ⛔ Blocked
- **No attendant-room code/rate in tariff** (`RNS0077` is an attender *pass* charge, not a room; `FNB0200`/`FNB5003` are meals). Attendant room stays a **manual, off-by-default** add-on at 18% GST until Finance supplies code / SAC / daily rate / charging unit / effective date. Internal concept `ATTENDANT_ROOM` may be used but must not masquerade as a billing code or publish a default rate. **(N3)**
- **HDU** (42 historical lines untaxed) — mark `critical_care_tax_exempt_pending_finance_confirmation`.

## 4. Recommendation
**Ship the patient-room 5% GST rule now** (it's validated and statutory); hold attendant room as a manual add-on pending the code. Introduce three tax categories: `PATIENT_ROOM_5_ABOVE_5000`, `CRITICAL_CARE_ROOM_EXEMPT`, `ATTENDANT_ACCOMMODATION_18`.
