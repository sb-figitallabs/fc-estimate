# Review — Tariff dataset completeness & fallbacks

**Input reviewed:** `newinps_updated.docx` → "Tariff Dataset completeness and fallbacks" tab.
**What this tab decides:** whether our tariff data is a complete/safe universal price master, and whether your premise "if a rate doesn't exist for a tariff, cash/TR1 is the fallback" actually holds. Short answer: item *identity* is near-complete; exact insurance *pricing* is not, and blanket TR1 fallback is **rejected** by held-out validation.

## 1. ✅ Confirms / matches our direction
- **Item identity completeness is excellent:** >99.9% of historically used non-PF, non-F&B items exist somewhere in the current tariff catalogue. Only ~23 genuine master gaps (e.g. `CAR0110` IVUS CAT-2, `ROM5171` HDU bed, `MRI5044`, `MSC0528` packed cells).
- **Cash/TR1 open-bill pricing is essentially complete** (TR1 99.88% normal exact rate) — close to usable after resolving code gaps + placeholder semantics.
- **Our package runtime already does NOT apply a generic TR1 package fallback** — the doc explicitly says retain that. The PRD's per-code fallback language is more accurate than the blanket-cash assumption and should remain the policy.

## 2. ⚠️ Could worsen currently-verified logic — flag hard
- **Your premise is not universally valid.** Held-out validation: **9,710 of 9,721** candidate fallback identities *failed* certification; only **11 certified** across three codes (`EME5060`, `PRO0004`, `PRO0016`). A blanket "missing → use TR1" rule would misprice insurance. Confirm we never blanket-fallback to TR1.
- **₹1/₹10 placeholder pricing = production blocker.** The service resolver treats *any* positive rate (including ₹1) as a valid exact tariff rate — so it can silently price a high-value service at ₹1 (e.g. `OTI0018` Major Instrument, historical ₹8,850, sits at ₹1; DMO ₹1 vs P50 ₹990). These ₹1 rows encode "included/not-payable/actual/percentage/sentinel", not a real price. Needs `rate_semantics` / `is_priceable` / `sentinel_type` fields and **fail-closed** otherwise.
- **Never median-of-room price** — the resolver's "median of candidate rates when room doesn't match" must not be production behaviour; require room category where room-sensitive rates differ.
- **Insurance exact-tariff pricing is NOT ready for deterministic repricing:** only 62.6% of lines have a usable exact numeric rate; 28% missing; 9.4% ₹1/₹10. GIPSA TR290 is 39.6% normal; several Non-GIPSA tariffs 0–37% (TR292 has *no* usable pricing surface). So GIPSA/Non-GIPSA reconstructed totals must not be treated as final-bill truth.

## 3. ⛔ Blocked / needs the hospital (N6)
- **Missing target-tariff extracts:** TR290 investigations (3,594 recent lines missing — `BIO0003`/`PAT0042`/`BIO0002`/`BIO0001`/`XRY044`…), the complete TR292 tariff, TR287/TR289/TR286, TR202 service/investigation, corporate TR215/TR274; consultation schedules for every active tariff name; the meaning of ₹0/₹1/₹10.
- Adopt the **7-step service fallback hierarchy** (exact current → shared-tariff → effective-dated same-tariff → explicit contractual reference → certified empirical → certified bucket model → **fail closed with a readiness warning + optional manual entry**) and a **stricter package fallback** (never Non-GIPSA→Cash, never borrow another org's amount).
- Service vs investigation views overlap (132,908 shared rows; 386 conflicting rates) — need governed domain precedence per code/tariff/period.

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**N6 is largely already handled in our engine.** (a) Placeholder guard is pervasive: `PLACEHOLDER_PRICE_MAX = 1000` in `packages.service`/`packageGate`/`flow2` — a sub-₹1000 package with no per-room rate is flagged `price_placeholder` and produces **no with-package total + a warning** ("carries a placeholder price… see its actual billed history"), never a silent ₹1 quote. (b) TR1 is a **flagged last-resort** in robotic pricing (`tariff_contracted` → `cohort_history` → `tariff_tr1_fallback`, and contracted tier excludes `tr1_fallback` rates) — not a blanket insurance fallback; TR1 is only the *cash* default (correct). (c) Line-item amounts come from **cohort history** (`amount_cash_typical`, quartiles), not raw ₹1 tariff-rate rows — so the "resolver treats ₹1 as valid" failure mode doesn't apply to us the way it does to the project-3 service resolver.
Residual to confirm (per-topic): median-of-room never used for a contractual rate; which missing tariff extracts (TR290 investigations, TR292…) our insurance estimates currently lean on.
