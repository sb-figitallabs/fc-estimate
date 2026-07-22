# Review file T3 — Emergency handling

**Input reviewed:** `Emergency_Handling.pdf` — checked against our current engine.

## 1. Core design (we endorse)
Emergency is a **billing overlay on Treatment A**, not a separate treatment and not one surcharge. Six independent facts (clinically urgent / arrived via ER / emergency bed / emergency-OT hours / MLC / payer emergency clause) — none implies the others. "Emergency Treatment A" wording opens a **decision workflow** (the 9 questions), it never auto-adds charges — strongly supported by the data point that only 66 of 294 "emergency"-worded FC records had ER-origin evidence.

## 2. What we have today
- `emergency_ot: Yes/No` control → OT slot ladder switches to the emergency OT codes (OTC0054–0069). ✅ matches the doc's OT-E mechanism, including "replace, don't add" (we price the slot, not an uplift).
- MLC input → HSP0047 row. ✅ matches (and the doc's "MLC = patient-payable NME for insurance" plugs into T2's classification).
- `has_emergency_origin` exists in the mart (retrospective ER-physician evidence) — the doc correctly says this is NOT sufficient as a forward-looking input.

## 3. New components to add (post-approval)
| Component | Rule | Default |
|---|---|---|
| ER physician (D000806, ~₹1,000) | when arrived-via-ER | all payers |
| ER initial assessment (EME5060, ~₹3,000) | payer-sensitive: insurance 93–94% historical vs cash 2% | insurance default-on (if via ER); cash/corporate default-off |
| Emergency bed 1–4h (EME0065) | only when ER-bed use expected; NOT the room category; usage fell sharply after Jul-2025 | ask, default off |
| Emergency OT | OT-E code lookup (tariff+org+room+duration) MINUS normal OT already in estimate; timing rule 8PM–8AM/Sun/holiday | existing control, enriched |
| Package emergency % (Bajaj 15% holiday/Sunday, ICICI 10% 8PM–8AM) | org/agreement-specific; never both OT-E and package % unless agreement allows | per-agreement |
| MLC | independent yes/no (never inferred from emergency) | existing |
| Variable emergency-care services (suturing, intubation, CPR…) | from matched emergency-treatment history as a RANGE, not a surcharge | range display |
New structured inputs: `is_clinically_emergency, arrived_via_emergency_department, emergency_bed_expected(+hours), procedure_expected_at, emergency_ot_eligible/approval, is_mlc, emergency_pricing_method, emergency_rule_id`.

## 4. ⚠️ Risks / questions
**Question 1 — estimate inflation risk.** Our current estimates verified well WITHOUT ER components (they're small: ~₹1k–₹4k typical, but package-% surcharges are not). Auto-defaults matter: we propose ER-physician auto-on only when "arrived via ER" is explicitly answered yes; everything else opt-in. Confirm.
**Question 2 — emergency OT validation gap.** Your own doc notes zero historical emergency-OT codes in clean service lines — the policy is tariff-backed but empirically unvalidated. We'll implement the lookup but mark it `ACTIVE_POLICY` (provenance shown). Confirm.
**Question 3 — "one procedure-level emergency method"**: OT-E uplift vs package emergency % vs exact emergency procedure code — we implement as mutually exclusive with agreement-flagged exceptions. Confirm.
**Question 4 — holiday calendar.** The 8PM–8AM/Sunday rule is computable from `procedure_expected_at`, but PUBLIC HOLIDAYS need a hospital holiday calendar — who supplies/maintains it?

## 5. Validation to run first
On our 17k history: re-derive ER-component frequencies and medians per payer (doc used 13,974 clean admissions — his DB; ours should agree), and confirm the ER-assessment payer split (94/93/2/9%) replicates before wiring defaults.
