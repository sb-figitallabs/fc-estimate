# 14-Jul task plan (from FC_14th_July_tasks.pdf + today's call i16 + i15 restart)

Process rules (his explicit instructions): **stop minor UI fixes — technical/data tasks first** · fix at dev level, **push confirmed fixes to dev at end of each day** · main stays untouched · TPA list arriving (free-text stays till then).

## P0 — Package-bill actuals (restart of i15; he asked twice, "very beneficial for rectifying estimates")
1. [x] Load the 3 record Excels into `fc.package_bill_admissions/_lines` — **DONE via S3 + IAM: 12,648 admissions + 514,599 lines loaded in 51s** (dependency-free SigV4 loader; re-dispatchable). Coverage: **85.4% matched to our admissions**; Open 8,912 / Package 3,736; F&B 0.1%.
2. [x] Package-bill P25/P50/P75 **per payor group** — **DONE, live in the admin audit panel** ("Package bills — converted actuals"). Verified: TKR Bilateral → GIPSA 136 cases P50 ₹6.35L · Non-GIPSA 23 P50 ₹6.33L · Cash 16 P50 ₹5.20L.
3. [x] **DONE — report run on the loaded actuals.** Headlines: only **42.4% of package-billed admissions match a priced master row by name** — 565 package-name groups (2,153 adm) have no priced master coverage, worst being **GIPSA TR290** (TKR Bilateral 123 adm, Left 99, Right 68… all name-drifted/unpriced) and whole tariffs with zero coverage (SSG_CARE, HDFC, KIMSI_MA, NIVA…). TR1 master carries **₹10 placeholder rows** (THR billed ₹3.4–4.5L). Of the matched set: 80 pkgs within ±5%, 69 at 5–15%; ICICI +26.8% and TR288 +17.8% (master too low); **Bajaj 0.0% — perfectly in line**. Re-run anytime: `gh workflow run maintenance.yml --ref dev -f script=report-package-diff.js`.

## P1 — Debug/audit view (dev-only; "make it complex, don't worry about UI")
4. [x] **DONE (admin-only, live)** — Bucket-level provenance for EVERY bucket + gross total: **basis + case count + download-the-cases (CSV)** — his bucket list: Pharmacy (total), IP Drugs, IP Consumables, OT Drugs, OT Consumables, Implants, Professional Fees, Investigations, Procedure/OT, Room, Bedside, OT hours, LOS. (Extends the existing admin Data-source panel; add the package-bill P25/50/75 from #2 here too.)

## P1 — Flow selection by payer + treatment
5. [~] **AUDITED + first pieces shipped (queued).** Audit (`payer-flow-audit-14jul.md`): the payer already drives tariff, pricing mode, per-component basis (drivers included — verified live), packages, robotic redirect; it does NOT drive cohort membership, template layout, implant/residual quartiles. Implemented now: additive **`resolved_context.flow`** block (the whole flow choice auditable per estimate) + **BUG FIX: OT priced ₹0 on insurer tariffs with no OT slot rows** (e.g. Bajaj) — OT ladder now TR1-falls-back, flagged. Deeper restructuring (basis-scoped stats, payer-conditioned templates, package-route-first) is specced F1–F8 in the note with efforts/risks — needs a design call.

## P1 — Daycare correctness
6. [x] **DONE** — Daycare: no General/Twin/Single anywhere (incl. compare-rooms gap), "Daycare" chip instead of stay fields, no "0 days", preview says "Daycare" (translated too).
7. [x] **DONE** — Explicit **Daycare/Inpatient toggle** when ambiguous (family flag or cohort LOS p50 < 1) in BOTH forms; LOS=0 shows a one-click "switch to Daycare" hint.

## P1 — Cath-lab hours
8. [x] **DONE (queued for EOD push)** — Cath Lab hours mirrored on the OT-hours pattern: manual override controls end-to-end (cath is lump-sum priced → manual hours × historical ₹/hour), stay-stats `cath` percentiles, input beside OT hours in BOTH forms, visible only for cath-lab families (CAG/PTCA).

## P1 — Patient preview: money statements
9. [x] **DONE (queued for EOD push)** — Insurance preview shows only **"Expected Out-of-Pocket Cost"** (ranged) + advance; "Insurance claimable" row, coverage statements and the AI-remarks coverage leak removed.
10. [x] **DONE (queued for EOD push)** — Advance: cash = 80% floored at ₹10,000; insurance = **₹10,000 flat**; 7-day refund disclaimer added (translation-wired); details-modal deposit hint is payor-aware.

## P2 — Estimate display
11. [x] **DONE (queued for EOD push)** — Implants shown as their own group (Pharmacy shows the remainder) in workbench + preview; display-only via a shared `displayBucketOf` helper — totals byte-identical, the 12.5% drug-admin-on-pharmacy-incl-implants rule untouched by construction.
12. [x] **DONE (queued for EOD push)** — ICU Charges split from Room Charges (engine `sub` classification + name fallback for old saves) in workbench + preview; totals invariance audited.

## P2 — FC-requested capabilities (from his meeting notes)
13. [ ] **Multiple procedures** per estimate (D&C + Mirena case) — kept for last per plan; design-heavy.
14. [x] **DONE (queued)** — override machinery existed (editable lines + custom items); added the discoverable "**Doctor prescribed something specific? + Add specific drug / item**" quick-action (opens a ready custom row in Pharmacy).
15. [x] **DONE (queued)** — Simple input flow confirmed fully engine-calculated; manual fallback gains stay-stat placeholders + cohort hint; PF row hint "auto-calculated — leave blank unless the doctor specified" (blank never zeroes); misc bucket verified + wording polish. (Per-bucket fabricated amount defaults deliberately NOT added — no honest data source in the manual path.)

## P2 — NLP match quality
16. [x] "Spine L4 L5 surgery for herniated disc" must top-match Spinal Decompression/Laminectomy — tune the resolver prompt + build a small eval set from his examples. - Its already done and working fine

## Data-handling decisions he stated (bake into #1–3 and the override plan)
- KIMS Insurance Excel = **separate reference, NOT an override** of our dataset (unless we argue otherwise) — revises the earlier override plan.
- When importing from that Excel, **tag by TARIFF CODE**, not insurance provider.

## Execution status (14-Jul, end of day)
- **Done — 15 of 16** (#5 partial-by-design: audit + transparency + OT bug fix shipped; deep restructuring specced for a design call). Only **#13 multiple procedures** remains, kept for last as planned.
- **On the dev test server already:** actuals load + converted-actuals P25/50/75, bucket audit view, daycare, cath-lab engine, actuals-diff report script.
- **Queued locally for the EOD batch:** HO frontend `343deaa` + `f2732dc` (wave-2 UI + overrides/Simple polish) · engine `cf014a8` (flow block + OT-₹0 bug fix). EOD push → deploy → combined verification (incl. TR289 OT fix + flow block).
- **For the manager:** the #3 report headline — 42% master coverage of real package bills, GIPSA names drifted, ₹10 placeholders in TR1 — belongs next to the Excel-audit answers.
