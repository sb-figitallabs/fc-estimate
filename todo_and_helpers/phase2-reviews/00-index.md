# Phase-2 Input Reviews — `newinps.docx` (20 Jul 2026)

One review file per tab of your `newinps.docx`. Same workflow as this morning: **you approve/correct each file BEFORE we implement anything** in that topic. Each file separates:

- ✅ **What already matches our engine / safe additive work** — we just build it.
- ⚠️ **What could worsen currently-verified logic** — we stop and ask (your explicit concern).
- ⛔ **Blocked** — a decision, a missing master/code, or data not yet runtime-ready.

## Tabs

**Reviewed this morning (full files already in the parent folder):**
- T1 — PF & Multi-Treatment → `../review-01-pf-multitreatment.md`
- T2 — NME estimator → `../review-02-nme.md`
- T3 — Emergency handling → `../review-03-emergency.md`
- T4 — +ve (infective) cases → `../review-04-positive-cases.md`

**New this round (this folder):**
| # | Tab | Headline status |
|---|-----|-----------------|
| 05 | Insurance — Do Not Bill items | Validated; conflicts with PF spec (D1); needs 4-value line model |
| 06 | Newborn | New pathway; don't auto-add bed; package/cradle masters missing |
| 07 | Newborn — mother-linked bed | Clarifies model; needs bed-transfer timestamps |
| 08 | Package inclusion / exclusion | Aligns with engine; don't infer caps; data not runtime-ready |
| 09 | Cross consultation | Matches our 18-Jul work; never auto-charge; rate master gap |
| 10 | Outside package LOS | Endorsed, 97% support; per-setting ledger; 743 pkgs lack LOS |
| 11 | Medical management | Framework sound; route procedures out; not yet certified |
| 12 | Handling daycare | Foundation kept; classifier fixes |
| 13 | Chemotherapy | Dedicated engine; never a generic total; 54% drug prices missing |
| 14 | Billing training Excel | Useful as rules; final-insurance PF conflict (D1) |
| 15 | Labour room | Additive; needs projected labour-room hours |
| 16 | Tax & attendant room | **Room GST ready to ship now**; attendant code missing |
| 17 | Blood bank | Rule endorsed; history double-charges; no issue register |
| 18 | Equipment & manual add-ons | Architecture endorsed; masters missing |

**Added in `newinps_updated.docx` (data-readiness & flow tabs):**
| # | Tab | Headline status |
|---|-----|-----------------|
| 19 | Tariff dataset completeness & fallbacks | Identity ~complete; **blanket TR1 fallback rejected**; ₹1 placeholder pricing is a blocker |
| 20 | Pharmacy dataset readiness | Your approach endorsed; double-count guard; high-cost prices/UOM missing |
| 21 | Non-package handling | Financials strong; **surgery-master mappings over-confident (42% contaminated)** |
| 22 | Package handling | Names reliable; **clean package-rate view under-prices ~½** — don't trust it yet |
| 23 | Handling variants | Attributes-on-concept; never pool uni+bi; no lap multiplier |
| 24 | Flow / package codes / AI boundary | Code-first + AI-interprets/rules-decide endorsed; refinements |

**Added in `newinps_updated2.docx` (classification & estimate-logic tabs):**
| # | Tab | Headline status |
|---|-----|-----------------|
| 25 | Pharmacy items classification accuracy | Bucketing broadly good; **production implant flag has a SQL defect** — don't let it drive FC |
| 26 | Non-pharmacy items grouping | Historical map reliable; **don't cut over to the incomplete clean view**; regroup blood-bank/intensivist/emergency |
| 27 | FC Estimate Builder stage-2 logic | **Architecture endorsed**; fix the ">₹1000 optional item dropped" rule (it's live in our engine) |
| 28 | Treatment review (broad vs specific) | Specificity-first matches us; enforce exact-outranks-broad; label `fallback_only`; add 88 missing concepts |

**Act on this:** `00-decisions-needed.md` — all open decisions (D1–D8 carry-overs + new N1–N5) with the tabs each affects and a suggested fast path.

> Nothing in these topics is implemented until the decisions are answered.
