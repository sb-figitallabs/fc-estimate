# 14-Jul — completed

All items below are live on the test server (https://fc-estimate.hospitalos.figitallabs.com)
and the dev engine. Nothing touched main/prod.

## Package-bill actuals (converted cases)
- [x] 3 record Excels ingested via S3 → streaming loader: **12,648 package-billed admissions + 514,599 bill lines**, keyed by IP number (`fc.package_bill_admissions` / `fc.package_bill_lines`)
- [x] Coverage vs master measured: 85.4% of billed admissions matched; Open-bill 8,912 / Package-bill 3,736
- [x] P25 / P50 / P75 of actual final package bills (excl. F&B) per payor group in the admin **Data source** panel
- [x] **Estimate range from actuals**: with-package total shows "actual bills ₹X–₹Y · N converted cases"; the patient preview's range comes from the actuals band (≥5 cases) with a source footnote

## Intake package-gate + Flow view (admin)
- [x] Engine `POST /api/lookup/package-gate`: payor → tariff → package in master → details usable → FC history → route (`exact_package` / `package_with_review` / `non_package_cohort` / `blocked_no_tariff`), every step with status + evidence
- [x] ₹10 placeholder prices detected and never trusted; real per-room prices recovered from the tariff-information table (e.g. DJ Stenting URO5443: GW ₹70k → Suite ₹1.01L)
- [x] **Flow view** in the builder (admin-only, third mode next to Simple/Detailed): two inputs (treatment + payor/insurer) → the classification chain rendered step by step
- [x] **Related package history** button: every billed package sharing words with the treatment — counts + P50 actuals per tariff/payer
- [x] **Full note** button: analyst-style narrative of the exact gate result (Flow / What the data says / Caveat / FC historic picture / Conclusion)
- [x] Verified against the reference agent output: same conclusion (package-with-review), same room prices, same related-history picture

## Ask AI (all three pages)
- [x] Right-edge dock on Inputs, Estimate and Preview — light-yellow tab minimised, dark-yellow header open
- [x] Answers grounded in the page's own data: estimate JSON, flow explanation, TR1 flags, settlement, historic metrics; per-bucket audit folded in for source questions
- [x] **Read-only database access**: engine `POST /api/lookup/ask` — AI with a guarded SQL tool (SELECT-only whitelist + READ-ONLY transaction + timeout + row cap) over packages, tariffs, billed history, cohorts; primed with the engine's pricing logic for how/why questions
- [x] "Include what I'm seeing" tick attaches a page screenshot to the same call
- [x] Answers show "checked the database (N queries)"; the API returns executed SQL for audit

## NLP / intake accuracy (from the 20 real admission-note test)
- [x] End-to-end test: 20 real admission-note photos → AI extraction → package-gate (report: `admission-notes-test-14jul.md`)
- [x] Package candidates now **AI-ranked** — appendicectomy→Myomectomy class of misses fixed; noise rejected as "no genuine clinical match"
- [x] Medical-management admissions skip the package chain entirely
- [x] **Alias enrichment on dev**: 272 curated abbreviation/spelling variants (TEP/TAPP, appendicectomy, B/L TKR, HYS D&C, caesarean spellings) + 153 billed-name backfills → 5,466 aliases, all tagged for review/rollback
- [x] Intake never returns an empty procedure when anything is written (uncertain readings marked "(?)")
- [x] Root-caused the one "extraction miss": a 2.4MB photo was silently 413'd by a 2MB body limit — raised to 20MB
- [x] Re-test: package-candidate accuracy 11/19 → ~17/19; the remaining misses route honestly to non-package instead of a wrong package
- [x] Regression-checked: "URSL + DJ stenting" → exact cash package URO5011 (16 billed cases); "dj stenting" → URO5443 package-with-review

## Payer-driven flow + estimate correctness
- [x] `resolved_context.flow` transparency block: how payer → tariff → basis → route were chosen, on every estimate
- [x] Payor-aware hints in the family dropdowns (per-payor case counts / "no history" tags); dropdown widened for full names
- [x] Bajaj OT-₹0 bug fixed; OT slot-ladder TR1 fallback (flagged + warned)
- [x] Cath-lab hours input (CAG/PTCA families) in both forms, priced at historical ₹/hour
- [x] Stay/OT/cath fields auto-filled with cohort typicals ("· typically N" beside labels; edits stick)
- [x] Care type / Setting "Auto" labels resolve to what Auto means for the selected family
- [x] Display split: Implants out of Pharmacy, ICU Charges out of Room Charges
- [x] Preview money rules: no insurer-split on the patient document, ranged OOP with reason, deposit rules (80% cash / flat ₹10k insurance + refund note), daycare wording, zero rows hidden

## Reports / docs produced
- [x] `excel-vs-db-package-report.md` + PDF — 642-row Packages-Excel vs DB comparison (9 open questions listed)
- [x] `package-bill-actuals-report-14jul.md` — actuals load + coverage
- [x] `payer-flow-audit-14jul.md` — where payer already drives the flow, F1–F8 gaps
- [x] `admission-notes-test-14jul.md` — 20-note end-to-end test with before/after fixes

## Deploys
- [x] Engine: all changes on dev, auto-deployed and verified live
- [x] Hospital_OS: feature branch pushed to origin (`6fa01eb`); test server rebuilt (both containers) and verified through login — bundle, package-gate, Ask AI all live

## Parked / waiting
- [ ] Multiple procedures per estimate (kept for last by agreement) + PF logic + combined-LOS logic
- [ ] Packages-Excel override ETL — waiting on the 9 mapping answers
- [ ] Insurance Excel mapping documentation + TPA master list — incoming
