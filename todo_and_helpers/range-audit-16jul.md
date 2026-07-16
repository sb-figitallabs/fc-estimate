# Range / total consistency audit — 16-Jul (manager demo complaints)

Scope: every place a range/band/total renders for ONE estimate in
`Hospital_OS/frontend/src/modules/estimate-builder-v3`, traced to its engine
source (`~/Downloads/handoof/backend-node`), reproduced with real dev-stack
builds (EC2 13.233.93.244:4200), and reconciled. **All root causes were
display-side; no engine change was needed or made** — the engine's bands are
internally consistent (no inverted p25>p75 or band[0]>band[2] anywhere in 7
probe builds) and it already flags the package-band divergence
(`package_offer.conversion_check` + a warning) that the UI never rendered.

---

## 1. The map — surface → source → room-key → transformation

| # | Surface | Data source field | Room key | Transformation / rule |
|---|---------|-------------------|----------|------------------------|
| 1 | **Workbench — itemized total** (big figure, `WorkbenchScreen`) | `grand_total.selected[rk]` re-derived live: Σ `line_items[i].selected[rk]` with FC edits (overrides/deletes), PF-historic factor, custom items | `resolved_context.room_key` | live recompute (`liveTotals.itemized`) |
| 2 | **Workbench — band under the itemized total** | `grand_total[rk][0]` and `[2]` — the engine's Low/High **mode** cells summed over rows (`lineItems.js` `grand`), shifted by the 13b insurer-PF delta and 13c backfill | `room_key` | **static** — build-time; never re-derived from edits |
| 3 | **Workbench — "With package" total** | `package_offer.coverage.totals.package_amount` (room-tiered via `room_amounts[rk]`, scalar fallback) + Σ coverage `final_amount` with edits/extras-removed/custom | `room_key` (package tier + coverage rows) | live recompute (`liveTotals.withPackage`) |
| 4 | **Workbench — "actual bills X–Y" under with-package** | `package_offer.billed_actuals.this_tariff.p25/p75` — **name-keyed** SQL over `fc.package_bill_admissions` (`final_pkg_bill_excl_fnb`), filtered to this tariff | none (bills are per admission, all rooms mixed) | was: raw p25–p75 shown whenever `cases ≥ 3`, **no bracket rule** → fixed (see §3) |
| 5 | **Workbench — per-bucket rows** (`BucketTable`) | coverage `final_amount` per line (package view) or `selected[roomKey]` (open-billing / other rooms), PF factor, edits on selected room only | all three room keys in compare view | compare view had package base + total rows; **single-room view had neither** → fixed |
| 6 | **Preview — Gross Total (cost table)** | snapshot: `grossTotal`/`withPackage` from the workbench (falls back to `final_estimate` + `bucket_totals`) | `room_key` (via snapshot) | was: `grossRangeText` = billed-actuals band (bracket rule, cases ≥ 5, floor ₹1,000) else synthetic capped range (upper = floor1000(t), lower = tiered 6–25 % below) → fixed to exact sum + separate labelled range line |
| 7 | **Preview — OOP box / rows** | `insurance_settlement.patient.total` (build-time itemized settlement) | `room_key` (settlement built on selected room) | synthetic capped range `rangeText(oop)`; exact when < ₹5,000 |
| 8 | **Preview — alternate-room cards** | `by_room[room].final_estimate` | each card's own room key | synthetic capped range + delta rounded to ₹1,000 |
| 9 | **Historic panel — gross band** | `historic_metrics.buckets[total_amount_excluding_…]` p25/p50/p75 (basis-filtered actuals over the cohort; summed-bucket fallback) | none (historic bills, room as billed) | raw p25–p75 vs live edited itemized total; ⚠ outside 75 %·P25–125 %·P75 |
|10 | **Historic panel — package-bill band** | same `billed_actuals.this_tariff` as #4 (raw, unfloored) + `package_amount` quartiles | none | raw p25–p75 vs live with-package; ⚠ same window |
|11 | **Historic panel — "charged above the package" buckets** | `billed_actuals.bucket_extras` — **code-keyed**, payor-group rollup (`fc.package_bill_bucket_metrics`, falls back to All Payers) | none | per-admission quartiles among bills where the bucket was charged |
|12 | **Flow view — package history table** (`FlowGateScreen`, read-only in this audit) | gate `fc_history` step: per-tariff billed-actuals rows | none | already carries the 15-Jul caption "not the package price, and not this estimate's total" — left untouched |
|13 | **Room dropdown "known" gating** | `grand_total[room][1]` (typical cell) | each room | presence check only, no display |

Note on #4 vs #10 vs #11 keying: `billed_actuals.this_tariff` is keyed by
package **name** + tariff; `bucket_extras` by package **code** + payor group.
For name-variant packages (e.g. CHOLECYSTECTOMY-LAP on TR287/Star) the gross
band can be null while bucket extras exist — `finishOffer` surfaces the
extras anyway and each block is separately captioned, so the two do not
contradict; they simply cover different populations. Verified: workbench #4
and historic #10 read the **same** `this_tariff` object, so they can never
disagree with each other — only with the estimate figure (fixed below).

---

## 2. Complaint 1 — "yahan 76 to 123 hai, yahan yehi alag hi band hai — clarity kahan pe hai?"

**Root cause: four genuinely different bands, none labelled.** Reproduced on
one build (lap cholecystectomy, Star Health TR287, Twin, SI ₹5L):

| Where | What it showed |
|---|---|
| Workbench, under itemized ₹1,60,692 | `band ₹1,46,750 – ₹1,74,853` (engine Low/High modes) |
| Historic panel, gross | `₹1,55,653 – ₹2,56,923` (cohort actual bills P25–P75, basis Non-GIPSA) |
| Preview, Gross Total cell | `₹1,22,000 – ₹1,36,000` (synthetic capped range on with-package ₹1,36,080) |
| Preview, OOP box | `₹57,000 – ₹67,000` (synthetic range on OOP ₹67,111) |

Same estimate, four unlabelled "ranges". **These are legitimate — they mean
different things** (mode spread vs historic population vs deliberately
softened patient quote vs OOP) — so the fix is captions, all now in the UI:

- **Workbench itemized band** → now reads `system range ₹X – ₹Y` (+ tooltip
  naming it the engine's low–high build, explicitly *not* past bills or
  historic P25–P75; `· excludes your edits` appended once the FC edits).
- **Workbench with-package line** → `actual bills … · N converted cases`
  with a tooltip naming the source, or the explicit amber divergence (§3).
- **Preview** → the range is now labelled `Expected final bill range`
  (translated key `expectedRange`) everywhere a range renders (table line,
  cash summary row, alternate-room cards) — never again under the same
  "Gross Total" label as an exact figure.
- **Historic panel gross band** → caption: "P25–P75 of past ITEMIZED bills
  for this cohort and basis — a different band from the workbench's system
  range… and from the package-bill band below."
- **Historic panel package band** → header now ends "— this is the band the
  workbench/preview quote as 'actual bills' when it brackets the estimate."

## 3. Complaint 2 — "ye abhi 83 to 120 aap bol rahe ho — ye to 83 to 120 bhi nahi hai, ye 160 to 140 hai"

**Root cause (a) — the workbench "actual bills" line had NO bracket rule.**
The 15-Jul #14 rule (actuals band only when it contains the quoted figure)
was implemented **only in PreviewScreen**; the workbench printed
`billed_actuals.this_tariff.p25–p75` under the with-package figure whenever
`cases ≥ 3`. Reproduced — 4 of 5 packaged probe builds contradict:

| Build | With-package figure | "actual bills" line shown |
|---|---|---|
| TKR uni, GIPSA TR290 | **₹1,76,230** | ₹2,61,176 – ₹3,85,304 · 31 cases |
| TKR uni, Star TR287 | **₹2,86,281** | ₹3,68,404 – ₹5,20,660 · 6 cases |
| PTCA 1-vessel, GIPSA | **₹1,24,480** | ₹2,82,232 – ₹4,42,039 · 43 cases |
| Lap chole, GIPSA | **₹46,990** | ₹1,16,085 – ₹1,80,443 · 7 cases |

A stated band that contains neither headline figure — exactly "ye to 83 to
120 bhi nahi hai". The manager's literal "160 … 140" also reproduces on the
Star lap-chole build: the two headline totals are ₹1,60,692 (itemized) and
₹1,36,080 (with package) while the bands on screen claim other intervals.

**Root cause (b) — the itemized band is static under a live-edited total.**
`grand_total[rk][0]/[2]` is build-time; FC deletes/overrides/custom items/
PF-historic move the figure above it, so the band can stop containing the
number it sits under.

**Fixed:**
- The bracket rule now lives in ONE shared helper,
  `billedBandFor(ba, figure, minCases)` in `lib/fcApi.ts` (bounds floored to
  ₹1,000 exactly as the preview prints them). PreviewScreen was refactored
  onto it (behaviour identical, cases ≥ 5); WorkbenchScreen now uses it
  (cases ≥ 3) against the **live** with-package figure — so it re-evaluates
  on every edit, and workbench + preview can never quote different bands.
- When the band does **not** bracket the figure, the workbench no longer
  contradicts silently: an amber line states it —
  `⚠ past package bills ran ₹2,61,176 – ₹3,85,304 (31 cases) — this estimate
  is below that range` — which is also the first UI surface for the engine's
  `conversion_check: out_of_range` (previously computed, warned, and never
  shown anywhere).
- The static band is captioned `system range … · excludes your edits` (§2)
  instead of pretending to track the edited figure.
- **Not a rendering inversion**: scanned all probe builds for `p25 > p75` or
  `band[0] > band[2]` in every array/quartile of the payloads — none exist,
  and both synthetic-range implementations guard `lower ≥ upper`. "160 to
  140" was the two headline totals read against a band containing neither.

## 4. Complaint 3 — "60,70,80,90 — 1,40,000 nahi hota total ye"

**Root cause (a) — Preview cost table: exact rows, range total.** The rows
(package price + payable-extra buckets) are exact rupee figures that sum to
the with-package total, but the Gross Total cell showed `grossRangeText` — a
band whose endpoints are NOT that sum (synthetic lower bound 6–25 % below;
actuals band endpoints unrelated to the sum). Reproduced (Star lap chole):
rows `₹1,32,190 + ₹3,890 = ₹1,36,080`, total cell `₹1,22,000 – ₹1,36,000` —
the column visibly "doesn't total".

**Root cause (b) — Workbench single-room bucket table had no package row and
no total row.** With a package, the visible bucket rows summed to just the
payable extras (₹3,890) under a headline "With package ₹1,36,080" — nothing
on screen added up to anything. (The compare-rooms view already had both
rows; the single-room view was missed.)

**Fixed:**
- Preview cost-table footer now shows the **exact sum** (`inr(grossDisplay)`,
  = package row + bucket rows to the rupee), with the softened band on its
  own labelled line `Expected final bill range` directly beneath. The
  15-Jul #14 bracket rule and the i9 "never above P50" cap are untouched —
  the same `grossRangeText` still renders, one labelled line lower (upper
  bound is `floor1000(sum)` ≤ P50 quote; the actuals band still only appears
  when it brackets the figure; the `billedBandNote` footnote still explains
  the actuals source). Verified on all 7 builds: rows sum equals the footer
  figure exactly.
- BucketTable single-room view now mirrors the compare view: green package
  base row (`coverage.totals.package_amount`) at the top and an
  `Estimate total (with package / open billing)` row at the bottom —
  `package base + buckets + custom = headline` verified to the rupee on all
  packaged builds (e.g. GIPSA TKR: ₹87,100 + ₹89,130 = ₹1,76,230).

## 5. What was fixed (diff summary — 5 files, display-side only)

| File | Change |
|---|---|
| `lib/fcApi.ts` | + `floor1000`, + shared `billedBandFor` (15-Jul #14 bracket rule in one place) |
| `components/WorkbenchScreen.tsx` | itemized band → `system range …` caption + tooltip + `excludes your edits`; with-package actuals line → bracket rule against the live figure, amber divergence line when outside (surfaces engine `conversion_check`) |
| `components/PreviewScreen.tsx` | cost-table total → exact sum + labelled `Expected final bill range` line; cash summary row + alt-room cards relabelled `expectedRange`; local bracket-rule code replaced by the shared helper (same behaviour) |
| `components/BucketTable.tsx` | single-room view: package base row + estimate-total row so visible rows sum to the headline |
| `components/HistoricPanel.tsx` | gross-band caption (cohort itemized bills ≠ system range ≠ package band); package-band header names it as the workbench/preview "actual bills" source |

Engine (`buildEstimate.js`, `packages.service.js`): **no changes** — bands
are consistent at source; `conversion_check`/warnings already existed and
are now surfaced by the workbench amber line. Off-limits files
(SimpleInputsScreen, Flow2Screen, flow2Api, flow2.service, familyResolve,
PF code) untouched. `cd frontend && npm run lint` (tsc) passes.

## 6. Legitimate-but-confusing — the four bands and their captions

Different bands genuinely mean different things; each now says which it is:

1. **System range** (workbench, under itemized) — the engine's Low/High
   build for this cohort at this room. Caption: *"system range ₹X – ₹Y ·
   excludes your edits"* (+ tooltip).
2. **Actual package bills** (workbench with-package line, historic panel
   package block) — what converted patients really paid for THIS package,
   excl. F&B. Caption: *"actual bills ₹X – ₹Y · N converted cases"* /
   amber divergence when it doesn't bracket the estimate.
3. **Historic itemized band** (historic panel gross) — P25–P75 of past
   itemized bills for the cohort/basis. Caption: *"P25–P75 of past ITEMIZED
   bills for this cohort and basis — a different band from the workbench's
   system range … and from the package-bill band below."*
4. **Expected final bill range** (preview, patient-facing) — the deliberately
   softened quote band (actuals when bracketing, else synthetic capped at
   the quoted figure). Caption: the *"Expected final bill range"* label
   itself, plus the existing footnote when the actuals band is used.

## 7. Repro notes

Probe builds (dev EC2, `POST localhost:4200/api/estimate/build`, Twin room,
`base_sum_insured` 5,00,000): lap_cholecystectomy × {ORG61/TR287, ORG56/TR290},
total_knee_replacement_unilateral × {ORG56, ORG61}, ptca_single_vessel ORG56,
hysterectomy ORG56, inguinal_hernia_repair ORG61. JSONs kept at
`$TMPDIR/est_*.json` during the session. All figures quoted above come from
those payloads and the exact UI arithmetic (emulated line-by-line from the
component code, then re-verified after the fixes).
