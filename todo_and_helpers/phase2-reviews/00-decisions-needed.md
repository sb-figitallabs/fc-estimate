# Review 00 (Phase-2) — Decisions needed before we implement

Consolidated from all the new tabs plus the four carried over from this morning. Each one, if guessed wrong, would silently change estimates that are already verified — so nothing in these topics ships until answered. `D…` carry over from `../review-00-decisions-needed.md`; `N…` are new from the leftover tabs.

## Carry-over decisions (still open)

| # | Decision | Affects | Priority |
|---|----------|---------|----------|
| **D1** | Insurer PF: new **rule-percentages** vs our live **historic-P50 override**. Also drives DNB suppression and the Billing-Excel conflict. | PF, DNB, Excel | **HIGHEST** |
| **D2** | Is the FC estimate the **LAN surface (open surgeon 25%)** or final-insurance (35%)? | PF, Excel | High |
| **D3** | Where do the rule/master tables live for **our RDS runtime** (not your local `fc_curated`)? Who seeds them? | PF, NME, +ve, Pkg | High |
| **D4** | Accept a **planned same-sitting FC input** as evidence for the 50/25 reduction (estimate is pre-OT)? | PF | Med |
| **D5** | Confirm the **factor-adjusted combo total** becomes the headline (drops up to ~37%), 100% sum kept as reference. | PF | Med |
| **D6** | NME: run the new range **parallel** to the old during validation, or clean **cut-over**? | NME | Med |
| **D7** | Emergency defaults (ER-physician on only if arrived-via-ER; ER-assessment insurance-default-on) + who owns the **public-holiday calendar**? | Emergency | Med |
| **D8** | +ve blocked set: ICU-isolation code, `MSC2816` rate/scope, `RNS0116` validity, Non-GIPSA OT-uplift MOUs, workbook effective date. | +ve cases | Med |

## New decisions (from the leftover tabs)

| # | Decision | Affects | Priority |
|---|----------|---------|----------|
| **N1** | Approve the **per-line four-value model** (gross / insurer-submitted / expected-approved / patient-payable + disposition). Needed by DNB and Equipment. | DNB, Equipment | High |
| **N2** | Approve the **package rule schema** (`rule_action` + `limit_bucket`) + resolution hierarchy; accept that only **114 cash / 45 Non-GIPSA / 0 GIPSA** rows are runtime-ready. | Package | High |
| **N3** | **Missing masters to supply:** cradle code, attendant-room code + 18% rate, ICU-isolation code, `MSC2816` rate, chemo drug prices, emergency-OT codes. | Newborn, Tax, +ve, Chemo, Emergency | High |
| **N4** | Confirm cross-consult stays **suggest-and-confirm** (never auto-charged); ICICI/`TR201` treated as review exception; consultation `tariff_code` mapping to be supplied. | Cross consult | Med |
| **N5** | Confirm **"outside package ≠ collect from patient"** as a global principle, and a per-setting ward/ICU excess-LOS ledger; 743 packages need a governed LOS. | Outside LOS, Pkg | Med |

## New decisions (from the data-readiness & flow tabs)

| # | Decision | Affects | Priority |
|---|----------|---------|----------|
| **N6** | Confirm the tariff resolver **fails closed** — block estimates with unexplained ₹1/₹10 rates, unvalidated TR1 fallback, median-of-room pricing, cross-payer package fallback; approve the 7-step hierarchy. Hospital must supply the missing tariff extracts (TR290 investigations, full TR292, TR287/289/286, TR202, corporate, ₹0/₹1/₹10 meaning). <br>✅ *Engine-checked 21-Jul: our engine already guards placeholders + flags TR1 as last-resort + prices lines from cohort history — so this is mostly a data-supply + policy-confirm item, not an engine fix.* | Tariff | **HIGHEST** (data supply) |
| **N7** | The project-3 **`v_package_rates_current` under-prices ~½** (TKR ₹79k vs ₹135k) — must not become anyone's production price source; hospital to confirm authoritative rate columns; import the 186 cash staging rows. <br>✅ *Engine-checked 21-Jul: our FC Builder reads `fc.package_master` (TKR TR290 ₹1,49,900 uni / ₹2,24,600 bi = correct) — **not** the halved view. Our estimates are unaffected.* | Package | Resolved for our engine; data fix upstream |
| **N8** | Accept that **treatment-level cohorts are gated** until the surgery-master mappings (42% contaminated) and the 756 multi-treatment / combo `clinically_valid` flags are rebuilt; promote the 167 curated medical concepts into a governed medical master. | Non-pkg, Variants | High |
| **N9** | Approve expanding AI to a **governed optional-item suggestion layer** (constrained to approved candidates), with the strict boundary that AI never invents a code/rate/quantity/amount/eligibility or computes PF/GST/totals. Record as a product decision. | Flow | Med |

## New decisions (from the classification & estimate-logic tabs)

| # | Decision | Affects | Priority |
|---|----------|---------|----------|
| **N10** | Fix/replace the **defective production implant flag** (it misses 1,436 implants) — it must not drive FC implant selection; apply the item corrections and split implant brand/type/manufacturer/model into separate fields. | Pharmacy classification | High |
| **N11** | **Don't cut over to `v_item_fc_bucket_map`** (304 codes / ₹63cr absent, 1,017 mismatches); adopt the multi-dimension service model + regroupings (Blood Bank out of Investigations, Intensivist→Critical-Care-Consultant PF, split Emergency), then recalc all admissions and verify total unchanged. | Non-pharmacy grouping | High |
| **N12** | **Change the ">₹1000 optional item dropped" rule** to surface-for-confirmation (it's live in our engine). Approve the direction: build the general add-on compiler + the insurer-vs-patient allocation stage; migrate to deterministic+residual **family-by-family after backtest** only. | Stage-2 logic | High |
| **N13** | Adopt the **treatment hierarchy** (family→treatment→subtype→variant) with enforced *specific-outranks-broad* fallback; label broad concepts `fallback_only`; add the **88 missing canonical concepts + 353 family selections**. | Treatment review | Med |

## Suggested fast path
- **N6 + N7 are the two highest-value engine safety checks** — the ₹1-placeholder / TR1-fallback guard and the package-rate-source fix each prevent whole classes of silently-wrong estimates. We'll verify our engine against both immediately.
- **D1, D2, D3** unblock the biggest clinical topic (PF) and cascade into DNB and the Billing Excel — answer these three first and we start T1 validation immediately.
- **N1 + N3** (four-value line model + the missing-masters list) unblock DNB, Equipment, Newborn, Tax and +ve cases together.
