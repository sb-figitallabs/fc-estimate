# Review file T4 — Positive-case (infective/seropositive) billing layer

**Input reviewed:** `+ve_cases_handling.pdf` — checked against our current engine.

## 1. Core design (we endorse)
A separate **positive-case billing-rule layer** driven by VERIFIED infection status + clinical context + payer agreement + room/ICU days + LOS — never inferred from a test order (`MIC0066` appears in 2,840 admissions incl. 905 medical — clearly just an investigation). New FC inputs (shown only when relevant, but flag available early because it changes package exclusions): `positive_status (NONE/HBSAG/HCV/HIV_SEROPOSITIVE/H1N1/OTHER_INFECTIVE)`, `confirmation_source (green sticker/lab/clinical/manual)`, `requires_isolation` + projected isolation room/ICU days, `surgery_context (non-heart/CT/cath-lab/medical)`, `payer_agreement_id`.

## 2. Ready-to-implement rules (per the doc, we agree)
- HBsAg/HCV management: qualifying procedure + verified status ⇒ context code (non-heart RNS0123 / CT RNS0121 / cath RNS0122), quantity 1, **no charge for medical management** (the 20 historical medical charges = billing exceptions, not precedent); never RNS0116+RNS0123 together for one context; RNS0116 only when the tariff explicitly says so.
- Package handling: positive-management charges outside the package by default (95% historical support); consumables separate actuals.
- HIV/seropositive: LOS-banded HSP5020–5024 (daycare precedence; exactly one category; normalized billable LOS).
- Isolation: daily, additive to room/ICU charges, day-ledger quantities, never room+ICU isolation same day; H1N1 = isolation occupancy + care per isolation day, only on verified status.
- Non-GIPSA OT surcharge (MOU rule: infective +50%, seropositive +100%): only where the org's MOU explicitly contains it, on the OT-CHARGES base only, stored as a separate line, highest-single not cumulative; historical LAN lines show ~1.00× so this is a **final-insurance adjustment by default** — matches your doc.
- Rate resolution always service code + payer tariff + org/MOU + room + effective date (never the workbook's hardcoded rates; historical exact-match was only 11–41%).

## 3. ⚠️ Blocked items — your own doc lists these; we need the answers before those branches activate
1. ICU isolation-care service code + rates (RNS0101 room-isolation exists; ICU code unidentified — stays `CONTEXT_REQUIRED`).
2. Effective date + payer scope of the attached rates workbook.
3. `MSC2816` conflict: workbook ₹10,000/₹5,000 vs ₹10 placeholder in current tariff views — and whether MSC2816 replaces or coexists with HSP5020–5024.
4. Whether `RNS0116` remains valid on any current tariff.
5. Which Non-GIPSA orgs actually carry the 50%/100% OT uplift (need the MOU list).
6. Package-case OT-surcharge base: reconstructed OT tariff base or package-embedded OT?

## 4. Risks / questions from our side
**Question 1 — input friction:** the positive-case section adds ~6 inputs; we propose a single "Positive case?" toggle on the inputs page that expands the section only when set (rest of the flow untouched). Confirm.
**Question 2 — interaction with T3:** OT surcharge (positive) and emergency-OT pricing both touch OT lines; when both apply we'll compute them on the same eligible base with separate lines and NO compounding unless an agreement says so. Confirm.
**Question 3 — sample size honesty:** only 124 historical positive-management admissions — profiles will be policy-first with history as evidence flags (statuses `ACTIVE_POLICY`/`PROVISIONAL`), not "historically certified". Confirm this presentation.

## 5. Validation to run first
Replicate the 124-admission cohort + code distribution (RNS0123 83 / RNS0116 31 / RNS0122 13 / RNS0121 1) and the 95% package-exclusion rate on our now-17k history before wiring rules.
