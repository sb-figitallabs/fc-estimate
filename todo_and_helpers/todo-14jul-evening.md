# 14-Jul evening call — task list (verified against DB)

Recording: `2026-07-14 16-06-13.mov` (23 min). Every factual claim below was
checked against `fc.package_master`, `fc.package_alias`,
`fc.package_bill_admissions` and `mart.main_table` on dev.

## The core problem he demonstrated

Typed **"URSL + DJ Stenting"** → the resolver picked the single family
**URSL (Ureteroscopic Lithotripsy)** — a 16-case cohort (Cash 4 / Non-GIPSA 7 /
Corporate 5). Meanwhile the billed-package history has far richer exact
matches the flow never looked at:

| Billed package (actuals) | Tariff | Cases | P50 actual |
|---|---|---|---|
| URSL + DJ STENTING | TR290 (GIPSA) | 27 | ₹1,45,510 |
| CYSTOSCOPY URS WITH DJ STENTING UNILATERAL | TR290 | 26 | ₹1,04,617 |
| URSL AND DJ STENTING - PA | TR1 (cash) | 16 | ₹99,402 |
| URSL AND DJ STENTING - PB | TR1 | 12 | ₹2,76,725 |
| URS WITH DJ STENTING | TR290 | 8 | ₹70,975 |

DJ-stent/URSL package-billed admissions overall: **327** (Insurance 248 /
Private 72 / Corporate 5). His agent's "251 related, 49 cash" was the right
order of magnitude.

## Where he is RIGHT

1. **Package-first gate is missing.** `fc.package_master` keyed by the payor's
   tariff code already answers "does a package exist for this treatment +
   payor" (e.g. TR1 URO5011 URSL+DJ STENTING ₹58,000; TR290 URO5379 ₹1,24,700).
   Our flow goes template-cohort-first and only meets packages later.
2. **Composite procedures beat single-family matching.** The exact combo
   exists as packages + billed history; picking bare URSL (4 cash cases) was
   a worse basis than the 16-case TR1 combo package actuals.
3. **Best display-name should be payor-aware** (his Hemodialysis example):
   among candidate cohorts, prefer the one that actually has cases for the
   current payor, not the globally biggest one.
4. **`fc.package_alias` already maps the combos** — "URSL", "URSL + DJ
   STENTING", "URSL + DJ STENTING - G I" all → URO5011, with FC-history notes.
   The mapping he wants mostly exists in our DB; the intake flow just never
   consults it.

## Where he is WRONG (or the data betrays him)

1. **"DJ Stenting matched wrongly"** — it didn't. "dj stenting" →
   Minor Endourological Procedure is correct (he conceded on the call);
   only the literal dropdown search "dj stent" surfaces DJ Stent *Removal*,
   which is the only onboarded family with that literal name. The real gap
   is combos + the package gate, not the resolver's choice.
2. **His agent's "we DO have cash package details for standalone DJ stenting
   (URO5443)" is half-true.** TR1 URO5443 "DJ STENTING (DOUBLE J STENTING) -
   UNILATERAL" exists — priced at **₹10**, the TR1 placeholder disease from
   the excel-vs-db report. Inclusions exist; the price is unusable. Same for
   TR1 URO5577 (DJ removal daycare, ₹10). Any "exact package" route MUST
   placeholder-guard and fall back to billed actuals (TR1 removal-daycare
   actuals: 6 cases, P50 ₹40,728).
3. **"Multi-package" (Shubham's suggestion) — manager's doubt was right.**
   URO5011 is a single combined package; combos are usually single packages,
   not two stacked ones.

## TODO (priority order he set)

- [x] **1. Intake package-gate + flow view** — DONE 14-Jul eve: engine
  `POST /api/lookup/package-gate` + admin-only "Flow" mode in the builder
  (steps chain, per-room prices parsed from tariff_information, related
  billed-history button). Verified against the manager's agent output:
  URO5443 rooms ₹70k–₹1.01L, route package-with-review.
- [ ] **2. Payor-aware candidate choice** — when several display names match,
  rank by (payor has cases) then count, not count alone.
- [ ] **3. Backward-validate with his Excel** — his sheet (package/non-package,
  counts, payor mix per display name) is the ground truth to reproduce.
  He's sending his agent's output document + the dataset.
- [ ] **4. Test with real admission notes** from the KIMS drive folder as
  intake inputs — stabilise on common treatments first, random ones later.
- [ ] **Parked by him**: multiple procedures, PF logic, combined-LOS logic —
  "don't touch until the review".
- [ ] **Data fix needed (flag to him)**: TR1 ₹10 placeholder packages
  (URO5443, URO5577, THR…) make the "exact cash package" route impossible
  without a source-level fix or an actuals fallback.

## He owes us

- His agent's output doc + the package-mapping dataset ("I'll send you this one").
- TPA master list (from the morning call).
