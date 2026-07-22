# Review 00 — Decisions needed before we implement (read this first)

This is the consolidated decision list pulled out of review files 01–04. Nothing in Workstream A gets implemented until you answer these — because each one, if guessed wrong, would silently change estimates that are already verified. Cross-references point to the full context in the topic files.

## A. Cross-cutting decisions (affect multiple topics)

### D1 — Insurer PF: rule-percentages vs our live historic-P50 override ⚠️ HIGHEST RISK
Today, insurance estimates re-price the PF bucket to the cohort's **billed P50** (your 15-Jul Q1 instruction; reaffirmed 18-Jul "historic PF is the only override that remains"). The new PF spec computes PF from **rules** instead (package GIPSA 20% / Non-GIPSA 25%; open 25% LAN / 35% final-insurance). These disagree case-by-case.
- **Decide:** for the FC estimate, do rule-percentages now REPLACE the historic-P50 override (historic shown as reference only)? Or does historic-P50 still win and rules are the fallback?
- (Ref: review-01 §3a Q1/Q2.)

### D2 — Which billing surface is the FC estimate: LAN (25%) or final-insurance (35%)?
The spec separates LAN/estimate logic from final-insurer-claim logic. Our estimate is the counselling surface. We read that as: **open-insurance surgeon = 25%** in the FC estimate; 35% only if we ever build a separate final-insurance view.
- **Decide:** confirm the FC estimate uses LAN percentages (25%), not 35%.
- (Ref: review-01 §3a Q2.)

### D3 — Where do the rule tables live for OUR runtime?
All three specs put rules in `fc_curated.*` / `fc_clean.*` / `fc_estimate.*` at `127.0.0.1:54322` — that's YOUR local project DB, not our engine's RDS. We will not hardcode percentages; we need versioned rule rows somewhere our engine can read.
- **Decide (pick one):** (a) we create equivalent rule tables in our RDS and you supply the seeded rows; (b) you export snapshots we ingest on a schedule; (c) we point at a synced copy of your schemas.
- Applies to T1, T2, T4.
- (Ref: review-01 §3e Q5, review-02 Q2, review-04.)

### D4 — Same-sitting evidence at estimate time (pre-surgery)
The spec requires OT-session evidence for the 50/25 multi-treatment reductions — but an FC estimate is made BEFORE the OT exists. We propose a **"same sitting vs separate sittings?" FC input** (default same-sitting for a single anaesthesia event, recorded as PLANNED evidence, provisional flag on).
- **Decide:** confirm this planned-sitting input satisfies the requirement for estimates.
- (Ref: review-01 §3b Q3.)

### D5 — Combo/multi-treatment headline will drop (up to ~37%)
Applying insurance factors reduces multi-package totals (e.g. 3 packages: 100/50/25 instead of 100/100/100). This is the intended fix, but it changes numbers reviewers have already seen.
- **Decide:** confirm the factor-adjusted total becomes the headline, with the old 100% sum kept as "unadjusted reference".
- (Ref: review-01 §3c Q4.)

## B. Topic-specific decisions

### D6 — NME: replace or run parallel during validation? (T2)
New NME range vs our current history-only NME line. Clean cut-over, or show both (new + old-as-reference) for a validation window? (Ref: review-02 Q1.)

### D7 — Emergency default-on behaviour (T3)
We propose ER-physician auto-on ONLY when "arrived via ER" = yes; ER-assessment insurance-default-on; everything else opt-in. Confirm — this governs whether estimates inflate. (Ref: review-03 Q1.) Plus: who supplies/maintains the **public-holiday calendar** the 8PM–8AM/Sunday/holiday OT rule needs? (review-03 Q4.)

### D8 — Positive-case blocked items (T4) — your own doc flagged these
These branches stay OFF until you answer:
1. ICU isolation-care service code + rates (only room-isolation RNS0101 known).
2. `MSC2816` = ₹10,000/₹5,000 (workbook) vs ₹10 (current tariff) — which is real, and does it replace or coexist with HSP5020–5024?
3. Is `RNS0116` still valid on any current tariff?
4. Which Non-GIPSA orgs/MOUs actually carry the 50%/100% OT surcharge?
5. Effective date + payer scope of the rates workbook you attached.
(Ref: review-04 §3.)

## C. Things we will NOT implement (on record, per your own i21 validation)
Universal assistant-physician 10% · physician 10%-of-total default · automatic 35–40% multi-surgeon cap · local-anaesthesia inferred from procedure names · workbook rates hardcoded. Flag if you disagree with any. (Ref: review-01 §3d.)

---
**Suggested fast path:** D1, D2, D3 unblock the whole of T1 (the biggest topic). If you can answer just those three first, we can start T1 validation immediately while the rest are decided.
