# Review — Insurance: Do Not Bill items

**Input reviewed:** `newinps.docx` → "Insurance - Do Not bill Items" tab (your guideline + Codex validation against Insurance Policy 2.0 and history).
**What this tab decides:** 12 items that must never make the patient liable — some still submitted to the insurer and waived if denied, others bundled or shown as ₹1 in the LAN bill.

## 1. ✅ Safe / validated by history
- "Do Not Bill" really means **patient-payable = ₹0**; exhaustion of Sum Insured never transfers these to the patient. A line appearing in the LAN/insurer bill does not make it patient-payable.
- The **₹1 "non-show"** behaviour is real in history: DMO 46.5%, monitor 43.4%, assistant-intensivist 49.8%, OT-disinfection 44.1%, general instruments 45.4% billed at ₹1.
- **Submit-and-waive-if-denied** items: assistant physician (`DM163`, at tariff rate — not a %) and **intensivist billed as Critical-Care Consultation** (`ICC0002`) — never present "Intensivist" and "Critical Care Consultant" as two charges.
- **Bundled / non-show** items (patient ₹0): assistant anaesthetist `DM140`, DMO (`ROM0093`/`HSP5049`), Hospital+Allied `RNS5003`, Medical+Allied `RNS5004`, drug administration `PHA0001`, assistant-intensivist (`ICC0001`/`CAR5028`), monitor (`EME0019`/`EME5011`/`EME5047`), transfusion service `EME0088`, OT disinfection `OTI0015`, urology instruments `OTI0058–60`.
- **GIPSA exception:** general instrument charges (`OTI0014`/`OTI0101`/`OTI0018`) are patient-payable **NME** for GIPSA; Non-GIPSA may submit to insurer but patient stays ₹0 (DNB if denied). Urology instruments are excluded from this exception.

## 2. ⚠️ Could worsen currently-verified logic — your call
- **Suppressing assistant-anaesthetist / DMO / monitor from the insurance estimate reduces insurance PF totals.** The insurance-specific policy here (suppress asst-anaesthetist entirely) **conflicts** with the PF spec, which allows 25% asst-anaesthetist for final insurance. The doc says the insurance policy should override. **This is D1** — confirm the DNB suppression wins for the FC insurance estimate.
- Do **not** apply the cash rules to insurance patients: no DMO-per-day, no 12.5%-of-pharmacy drug-administration on insurance (or insurance package-pharmacy overage) unless a signed agreement says so.

## 3. ⛔ Blocked / new work
- **N1 — per-line four-value model.** A single covered/not-covered flag is insufficient. Each line needs: `gross_tariff`, `lan_display`, `insurer_submitted`, `expected_insurer_approved`, `patient_payable`, `hospital_waiver_if_denied`, `billing_disposition` (`CLAIM_AND_WAIVE_IF_DENIED` / `INCLUDED_IN_PARENT_TARIFF` / `LAN_NON_SHOW_RUPEE_ONE` / `SUPPRESS_DO_NOT_BILL` / `PATIENT_PAYABLE_NME_GIPSA`). Approve the model — it's a real schema change.
- Confirm the **patient-facing estimate shows only `patient_payable`**; the insurer view may show claimable asst-physician / CCC but must never move denial risk into the patient estimate.

## 4. Validation — ✅ engine check done (21 Jul, read-only)
Inspected `insurance/settlement.js` (`classifyRow`). **Most DNB items already sit off the patient in our engine:**
- Monitor-per-day, intensivist, ICU-nursing → class `icu` (insurer-admissible, **not** patient-NME); assistant-anaesthetist / assistant-physician / DMO → class `associated` (insurer-side, ward-ratio). So the DNB "patient ₹0" goal is **largely already met** — and we do **not** add these as separate patient-side PF lines, so the DNB tab's "suppression reduces insurance PF" concern is **much milder for us** than for the project-3 spec.
- **One real change:** `DRUG ADMINISTRATION` is currently classed `nme` (100% patient). The DNB policy says insurance drug-admin patient = ₹0 → adopting it would **move drug-admin off the patient and lower insurance patient totals**. That's a genuine change to verified numbers → keep it a manager decision (ties **D1**).
Still to do (per-topic): the ₹1-share reproduction, and wiring the four-value line model (**N1**).
