# Payer-Driven Flow — Audit & Design Note (14-Jul)

**Manager model (#5, 14-Jul doc):** *"First a family categorization happens. Then, within this
family, the best flow is chosen based on the PAYER TYPE and the treatment. The entire flow should
only be selected once we have the exact payer and the treatment. Right now the flow is selected
based solely on the treatment; the payer isn't playing a significant role."*

Scope of this audit: `src/modules/engine/{buildEstimate,cohort,artifacts,lineItems,services,advanced,rules}.js`,
`src/modules/resolve/{payorTariff,payerBasis}.js`, `src/modules/packages/{packages.service,coverage}.js`,
`src/modules/insurance/settlement.js` (engine repo `~/Downloads/handoof/backend-node`, branch dev).
Behavior cross-checked live against the deployed dev engine (`fc-estimate-dev.figitallabs.com`).

---

## 1. How the flow is actually selected today (pipeline trace)

```
input(payment.payor_bucket, payment.organization_cd, clinical.procedure)
 │
 ├─ 1. resolveTariff(payor, org)            ← PAYER   (Cash→TR1; else fc.organization_tariff_mapping)
 ├─ 2. pricingMode Cash/TR1 vs Insurance    ← PAYER   (drives PF cascade, drug-admin, exclusion guard)
 ├─ 3. getCohort(family) + care controls    ← TREATMENT ONLY (whereSql is clinical; all payors in)
 ├─ 4. payorBucketCounts + resolveBasis     ← PAYER   (exact→InsuranceAll→AllPayers→Cash fallback chain)
 ├─ 5. stats per basis (svc/pharm/summary)  ← PAYER via basis label filter
 ├─ 6. robotic_redirect suggestion          ← PAYER-gated (GIPSA/Non-GIPSA + thin robotic cohort)
 ├─ 7. drivers (LOS/ICU/ward/OT/cath)       ← PAYER: percentiles read from the RESOLVED service-basis row
 ├─ 8. template rows (auto vs fixed layout) ← TREATMENT (layout) / PAYER (row set, via basis stats)
 ├─ 9. rates: tariffRateLookup(tariff_cd)   ← PAYER (+ per-item TR1 back-fill, flagged tr1_fallback)
 ├─ 10. OT slot ladder                      ← PAYER tariff… but NO TR1 fallback → insurer OT = ₹0  ← BUG (fixed, see §5)
 ├─ 11. add-ons / OT-consumable shortlist   ← PAYER via basis-filtered stats
 ├─ 12. implant hierarchy + grouping gaps   ← TREATMENT ONLY (full all-payors cohort)
 ├─ 13. PF cascade / drug admin             ← PAYER (binary: cash formula vs zeroed-into-tariff)
 ├─ 14. package offer                       ← PAYER (lookup by tariff_cd + organization_cd)
 └─ 15. coverage + settlement               ← PAYER (tariff-specific curated inclusion text; policy input)
```

So the payer already plays a **large statistical and pricing role** — what it does *not* do is
select a named, declared "flow", and a handful of components silently ignore it.

## 2. Current matrix — component × payer influence

| # | Component | Payer role | Mechanism / location |
|---|-----------|-----------|----------------------|
| 1 | Tariff / rate card | **YES** | `resolveTariff` — Cash→TR1, else org mapping; never guesses (`payorTariff.js`) |
| 2 | Pricing mode (PF, drug admin, exclusion guard) | **YES** | `pricingMode` in `buildEstimate.js:59`; `insuranceMode` zeroes PF cascade + 12.5% drug admin (`lineItems.js`) |
| 3 | Cohort membership | **NO** | `FAMILIES[*].whereSql` is clinical-only (by design, `cohort.js:48`); exception: `robotic_tkr_unilateral_right` pinned to Cash for workbook parity |
| 4 | Component basis (services / pharmacy / PF) | **YES** (with fallback) | `resolveBasis` chain exact→Insurance All→All Payers→Cash; thresholds 15 (surgical/daycare) / 20, fallback 25 (`payerBasis.js`). **Caveat:** `mkBasis()` is called 3× with identical inputs — the three "independent" bases are always identical today |
| 5 | Drivers: LOS / ICU / ward / OT-hrs / cath-hrs percentiles | **YES — already on payer basis** | `resolveDrivers(svcBasisRow, …)` (`buildEstimate.js` step 8) reads the *resolved service basis* summary row. Verified live: TKR-uni + Non-GIPSA → basis `Non-GIPSA Insurance` (376 cases, exact, high confidence), LOS/ICU from that cohort |
| 6 | Template layout (fixed vs auto; ot/cathLab/surgical row flags) | **NO** | `coreTemplate`/`rows` are family constants (`cohort.js`); fixed TKR layout is Cash-parity frozen regardless of payer |
| 7 | Template ROW SET for `auto` families (default-included) | **YES** | `cleanServiceRows(svcStatsForBasis)` + presence rule >90% / ≥75%&≤₹1000 — computed on the payer basis cohort |
| 8 | Add-on candidates + prioritization | **YES** | basis-filtered stats; expected contribution uses tariff rates embedded by `buildServiceStats(cohorts, tariff_cd)` |
| 9 | OT-consumable shortlist | **YES** | `buildOtConsumableShortlist(pharmStatsForBasis, …)` |
| 10 | Implant hierarchy (family→brand→item) | **NO / partial** | `buildImplantHierarchy(cohortRows, …)` runs on the FULL all-payors cohort; only the resolved ₹ anchor (`implants_p50`) comes from the payer pharmacy basis |
| 11 | Grouped residuals / grouping gaps | **NO / partial** | `buildGroupingGaps(cohortRows, cleaned, …)` — exact group quartiles over ALL payors, while `captured` comes from basis-cleaned rows → mixed-basis math |
| 12 | OT slot ladder | **WAS BROKEN** | `buildOtSlotMatrix([tariff_cd])` had no TR1 fallback → insurer tariffs without "OT - X HOURS" rows priced OT Charges at **₹0 silently** (reproduced on dev: TR289 Bajaj, `ot_slot.hours: null`). Fixed in this change |
| 13 | Cath-lab pricing | **YES** | historical slot-family amounts/hours from the payer basis row |
| 14 | PF logic | **partial** | binary cash-formula (25/15/25/25%) vs insurance-zero; `pf_analysis` compares against pf-basis historic P50; no org-/tariff-specific PF behavior |
| 15 | Insurance item exclusions | **NO (stub)** | `insuranceExcluded: new Set()` — "seeded from insurance policy table when in insurance mode" is still a TODO |
| 16 | Package offer lookup | **YES** | `lookupPackage(tariff_code, org_cd)` — payer tariff keys the whole package catalog |
| 17 | Package candidate selection (no explicit input) | **partial** | cohort-dominant package = frequency over ALL payors' historical cases; can nominate a cash-dominant package name (lookup still runs under the payer tariff, so wrong-candidate ⇒ `no_package_exists` rather than wrong price) |
| 18 | Robotic path | **YES** | presence/default from basis stats; `robotic_redirect` suggestion payer-gated (GIPSA/Non-GIPSA, robotic bucket <5 cases, base ≥5) |
| 19 | Coverage parse + settlement | **YES** | curated inclusion/exclusion text is per-tariff; settlement from the payer's policy input |
| 20 | Historic metrics / PF payor summary | **YES** | keyed by basis label |

## 3. Gaps vs the manager's model

1. **No declared flow.** The payer *does* shape tariff, rates, statistical basis, package lookup and
   robotic path — but nothing in the response *says so*. The flow is implicit in a dozen scattered
   decisions, which is exactly why it reads as "selected solely on the treatment".
   → Fixed now: additive `resolved_context.flow` block (§5).
2. **Rate surfaces that ignore the payer silently:** the OT slot ladder had no TR1 fallback (insurer
   OT = ₹0). → Fixed now.
3. **Payer-blind analytics:** implant hierarchy and grouping-gap/residual quartiles run on the full
   all-payors cohort even when an exact payer basis exists (TKR-uni has 376 Non-GIPSA cases).
4. **Template layout is treatment-only:** an insurer that historically bills TKR as
   *package + robotic add-on* still gets the itemized cash-shaped layout; the robotic-redirect
   suggestion is the only payer-conditioned structure change, and it is advisory.
5. **Cosmetic component independence:** service/pharmacy/PF bases resolve from the same counts and
   can never differ; doc 14's "independent per component" is not yet real.
6. **Package route is always side-by-side**, never *the* flow — even when the payer's tariff has a
   comprehensive priced package (`can_generate_estimate = true`) which is how that insurer actually
   settles.
7. **Insurance item-exclusion set is empty** — payer policy never removes line items yet.

## 4. Recommended design — what "payer + treatment selects the entire flow" should mean

Introduce an explicit **flow-resolution step** at the top of `buildEstimate`:
`(family, payor_bucket, organization_cd) → FlowPlan` — a plain object the rest of the pipeline
*reads* instead of each stage re-deriving payer behavior. The `resolved_context.flow` block shipped
now is the read-only version of this plan; the steps below progressively make it load-bearing.

| Step | Change | Effort | Risk / notes |
|------|--------|--------|--------------|
| F1 | `resolved_context.flow` transparency block | S — **done** | additive; zero behavior change |
| F2 | OT slot ladder TR1 fallback (flagged + warned) | S — **done** | changes insurer estimates *upward* from a silent ₹0 — this is a bug fix, mirrors `tariffRateLookup`'s documented per-item TR1 back-fill; UI already renders `tr1_rate` badges |
| F3 | Basis-scope the payer-blind analytics: run `buildImplantHierarchy` and `buildGroupingGaps` on `cohorts[svcBasis]` when the resolved basis is `recommended_exact`, else keep the family cohort | M (1–2 d) | **This is why basis-fallback exists:** small payor cohorts destroy quartile quality (many buckets have <15 cases — e.g. robotic TKR insurance buckets). Reuse the already-resolved basis status as the gate; never re-derive a second threshold scheme |
| F4 | Real per-component basis independence: gate each component on its own data sufficiency (e.g. pharmacy basis needs cleaned-pharmacy rows present, PF basis needs PF bucket > 0), not just headcount | S/M | low value until component data availability actually diverges; keep the shared `payorBucketCounts` query |
| F5 | Payer-conditioned template variants: let a family declare per-payer overrides, e.g. `flows: { 'GIPSA Insurance': { redirect: 'total_knee_replacement_unilateral', robotic: 'yes' } }` — makes the robotic redirect a *selected flow* instead of a suggestion (still one-click reversible) | M (2–3 d) | needs manager sign-off per family; keep suggestion behavior as the default so nothing auto-switches without UI consent |
| F6 | Package-route-first flow: when the payer tariff resolves a priced, `can_generate_estimate` package whose coverage parse is `comprehensive`, rank the package route above open billing in the response (`flow.billing_route.recommended = 'package'`), itemized estimate retained as the extras/comparison engine | M/L (3–5 d) | changes what the FC leads with — product decision; the math already exists (`applyCoverage` + `settleWithPackage`) |
| F7 | Seed `insuranceExcluded` from a payer policy/exclusion table | M, blocked on data | needs the insurance policy item-exclusion table that doesn't exist yet |
| F8 | Payer-scoped package candidate: compute the cohort-dominant package over `cohorts[svcBasis]` first, family-wide as fallback | S (hours) | tiny; only affects the no-explicit-input path |

**Explicitly NOT recommended:** making cohort *membership* payer-scoped (`whereSql AND payor_bucket = $target`).
The basis mechanism (`resolveBasis` with 15/20-case exact thresholds and the Insurance-All/All-Payers
fallback) already is the safe middle ground — a hard payer cohort would collapse most families'
percentile quality (robotic TKR has <5 insurance cases; several generated families are thinner) and
re-create the exact sparse-data problem the fallback chain was built to absorb. Restructuring
cohorts wholesale is a separate project, not a patch.

## 5. Implemented in this change (engine repo, no git)

1. **`resolved_context.flow`** (`buildEstimate.js`, before the estimate object) — additive block:
   treatment (family/label/kind), payer (bucket/org), tariff (+source, pricing mode), rates
   (service-rate tariff, TR1-fallback item count, OT-ladder tariff + fallback flag), cohort scope
   (`clinical_family_all_payors`, case count, payor mix, care-filtered), component_basis
   (auto/manual + services/pharmacy/PF basis with status/case-count/confidence/reason + explicit
   note that drivers ride the service basis), template (layout `auto_from_cohort` vs
   `fixed_workbook_parity`, derived-from basis, row flags), billing_route (itemized always +
   package status/source/code/tariff), robotic (selection, redirect_suggested, base_family).
   All consumers of `resolved_context` read specific keys — verified additive-safe
   (`workbook/bands.js`, `workbook/dynamicSheets.js`, `ai/explain.js`, `packages/coverage.js`).
2. **OT slot ladder TR1 fallback** (`buildEstimate.js` step 7 + `lineItems.js`): when the org
   tariff has **zero** "OT - X HOURS" rows, the TR1 ladder prices OT Charges, each slot flagged
   `tr1_fallback`, a warning is pushed, the OT line row carries `tr1_rate: true` and
   `otSlot.tr1_fallback: true` (both layouts). Conservative: any org slot rows at all ⇒ org ladder
   used untouched. Reproduced the pre-fix defect live on dev (TR289 → `ot_slot.hours: null`, OT ₹0).
3. **Drivers on payer basis** — audited, already true (no change needed): `resolveDrivers` reads
   `svcBasisRow`, the summary row of the payer-resolved service basis; confirmed live on dev.

`node --check` clean on `buildEstimate.js`, `lineItems.js` (and re-checked `artifacts.js`,
`cohort.js`, `payerBasis.js`). DB unreachable locally, so no runtime execution — the dev deploy
still runs the pre-change build; re-verify `flow` + TR289 OT pricing after the next dev deploy.
