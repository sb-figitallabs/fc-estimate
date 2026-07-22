# FC Estimate Builder — project chronicle

**What this is:** the dated decision history of the whole estimate-builder project — what the logic is TODAY, what it was BEFORE, WHEN it changed, and WHICH manager input changed it. It powers "Ask the Project": when someone asks "why is this number X / what's the logic behind Y", the answer should cite this file's dates and the commit history.

**Upkeep rule:** every working session that changes logic appends to the timeline and updates the affected "Logic reference" entry. Commit messages in both repos always name the manager input that drove them (e.g. "manager 16-Jul #8") — the git log is the fine-grained companion to this file.

**The two repos:** `fc-estimate` (this repo — the pricing engine, Node ESM, RDS Postgres; `dev` branch auto-deploys to fc-estimate-dev.figitallabs.com, `main` to fc-estimate.figitallabs.com) and `Hospital_OS` (the hospital app; the Estimate Builder UI lives in `frontend/src/modules/estimate-builder-v3`).

---

## Part 1 — Timeline

### Foundations (May – early July 2026)
- **~May 2026 — project start.** Goal: a Financial Counselor (FC) tool that produces a realistic pre-admission cost estimate from (a) the hospital's own billing history and (b) its tariff/package masters — never from invented numbers. Core design from day 1: **history-grounded cohorts** — each procedure family maps to admissions in `mart.main_table` (HIMS billing extract), and the estimate is built from that cohort's P25/P50/P75 per bucket.
- **2026-05-18 — pricing audit engine** built in Hospital_OS (migrations 038/039, 30+ policy rules from KIMS billing docs).
- **2026-05-25 — Vertex AI migration:** all AI calls proxied through the backend with service-account auth (no client-side keys).
- **2026-06-15 — package + template catalogs** loaded (HO migration 058 + ETL): package catalog (cash + GIPSA) and the template catalog (registry/heads/sub-heads/items).
- **June–July — the 12-family estimate pipeline** became this standalone engine (`fc-estimate`), later expanded to 150+ generated families. Package layer + coverage engine added; TKR pinned as the parity reference procedure.

### 2026-07-13/14 — first correction round + meeting
- Manager meeting (14-Jul recording) + admission-notes test round produced the first structured todo. Key manager directions: the intake classification chain ("payor → tariff → package in master? → details usable? → FC history? → route") must be auditable step by step — this became the **package gate** and later Flow-2; day-care rule: **LOS < 1 day ⇒ daycare** (rule 4).
- DJ-stenting was the manager's recurring probe case from the start (his own reference flow for how classification should read).

### 2026-07-15 — the big review round (meeting + jul15_answers)
Manager's answers file drove these decisions, all shipped and deployed to main that day:
- **Determinism:** matching must be reproducible — Gemini **temperature 0** everywhere, model pinned (`gemini-3.1-pro-preview`) (todo #22).
- **Q1 — insurer PF:** insurer tariffs price Professional Fees at token consultation rates (₹740 vs real ₹15k–₹1.4L). Decision: *"use the historic PF P50 for the time being"* — every insurer build re-prices the PF bucket to the cohort's billed P50, scaled across PF lines so totals reconcile.
- **Q3 — empty buckets on medical families:** historical bucket backfill from the cohort's actual bills ("could be a good fallback for now").
- **Q4 — session-based families** (dialysis, phototherapy, newborn care): LOS×room rows would fabricate lakhs — room rows suppressed; they bill per visit.
- **Robotic (#9, #25, #27):** per-payor presence rule — presence >90% for THIS payor basis ⇒ robotic included; ≥30% ⇒ optional add-on row + convert prompt. Robotic add-on priced from the payor tariff's contracted robotic item (e.g. TR290 "ROBO (TKR) - UNILATERAL" ₹1,20,000), cohort billed history as fallback. Robotic classification is DB-driven (`fc.robotic_admission_classification`), never AI guesswork; a negation guard (P2) stops "no robotic" wording from flagging robotic.
- **Stage-1 payor-aware flow:** the procedure is resolved from the doctor's wording + payor together (payor-aware case counts shown), FC confirms.
- **TPA dropdown:** documentation-only — prints on the estimate; rates still come from the primary insurer's tariff.

### 2026-07-16 — clarity round (meeting refs #6/#7/#8, P1/P4)
- **#6 "clarity kahan pe hai":** range/total reconciliation — the system range and the headline total must visibly agree.
- **#7:** type-ahead resolve debounce 600ms → 1100ms ("search fires as I type").
- **#8:** combo announcement — wording carrying ≥2 treatments is announced at intake with per-treatment paths; each path prices alone (combo interactions not modeled — sums are labeled upper-bound).
- **P1:** with-package headline quote (package + payable extras) shown beside the itemized total.
- **P4:** catch-all guard — specific wording must not silently resolve to a generic cohort; generic matches need explicit FC confirmation.
- **flow_summary:** every saved estimate stores a deterministic narrative of how the engine approached it (HO migration 089, admin-only display) — "manager wants to see the flow-2 summary for each".

### 2026-07-17 — flow parity, transparency docks, medical-family fix
- **Flow parity #2–#5:** the build now judges and prices packages EXACTLY like the flow view: gate-driven package selection in the build (#2 rank on family label when no wording), per-room package prices rescued from `tariff_information` markdown (#3), placeholder guard — a ₹10 scalar with no per-room rescue is NOT a price (#4), medical-management families never auto-attach a package (#5).
- **TR287 mismatch (manager screenshot):** gate said "no package" while the build attached ORT5510 — alias coverage is uneven per tariff (TR287 had 951 aliases, only 2 KNEE). Fix: master-catalog name fallback in the gate ranking so the gate sees everything the build can.
- **UI:** the flow-2 narrative moved into a right-side **Engine flow dock** on all three builder pages (live on Inputs: treatment→family, payer→tariff, package candidates as pickable chips); Ask-AI and Feedback docks got the same pattern (exclusive-open, drag-resize).
- **Manager feedback #4 (dev portal):** a pulmonology **medical-management** estimate carried CSSD charges + Surgeon/Assistant-Surgeon/Anesthetist PF (₹8,685 of ₹54,234 fabricated by surgical logic). Root cause: CSSD template row was ungated and the surgical PF cascade (surgeon 25% of pre-PF subtotal → assistant 15% → anesthetist 25% → asst-anesthetist 25%) ran for every family. **Fix (engine `6111d25`):** CSSD + OT-pharmacy rows gate on the family registry's surgical/ot flags; medical families emit ONE "Physician Fees — Daily Visits" row priced from the cohort's billed PF history (his visit-based fee sheet will refine it — still pending).
- **Gemini double-JSON bug (`06fafac`):** certain wordings ("DJ stent removal", "LAP. CHOLECYSTECTOMY - PA") made Gemini emit two JSON objects back-to-back at temperature 0 — deterministically 500ing resolve-treatment. Fixed with a balanced-brace first-object parse.
- **UI verification (10 real patients through the UI):** flow 10/10, accuracy 6/10 within ±25%; misses concentrated in implant-heavy cases and unmapped orgs — consistent with the 15-Jul backtest (39 admissions, median −24.9%).
- **Evening meetings + `17_july_inp.pdf` + 4 feedback screenshots** — the "package re-grounding" directive (see 18-Jul).

### 2026-07-18 — package re-grounding + the big unblocked batch
Morning meeting decisions: **historic metrics become reference-only for PF** (only the explicit historic-PF override survives; other discrepancies get flagged, not replaced — his PF doc with samples still pending); data prep flips to him (surgery master from Sattar, FC data Dec-24→); read-only DB access for him (`fc_readonly` role, SELECT-only on public/fc/mart, URL shared).
Shipped this day (engine `1250c28`→`79216d2`, HO `67a0b69`→`d1d2759`):
- **A1 — package LOS from the package master** (his 17-Jul directive: "the LOS should come from the package master… PKGDURATION, 0 = daycare; do NOT use pre/post days"). The package now resolves BEFORE the stay drivers; `package_duration` is the LOS default when the FC gave no manual stay; pre/post days exposed; provenance = `drivers.los_source: package_master` + an estimate warning. **Notable: TR1's TKR package duration is 3 — exactly the LOS he said was right.**
- **D1 — LOS audit:** why did conventional TKR show LOS 5? Every LOS surface used p50 over **CEILED billable stays** (`normalized_billable_stay_days`; raw p50 3.61 → 4) and his 7-case robotic-presence subset ceiled to 5. His "it takes the larger value" suspicion was correct. The package-master LOS (A1) supersedes this for package cases.
- **A2 — Service-All tariff matrix is the authoritative per-room package price** (his 17-Jul directive: "package tariff for each room category should come from the service-all tariff already in our database", NOT MOU). `fc.service_tariff_rate_matrix` prices 593 package codes per ward group; those charges override jsonb/tariff-info amounts, with `room_amounts_source` for audit.
- **B1 — per-candidate match verdicts** (his feedback p1: "show if it's a match or not for each option… bilateral is not a match because I asked right only"). Deterministic laterality/side/robotic/revision rules on top of the AI ordering; every candidate carries `verdict` + `verdict_reason`; not-a-match options stay pickable (same surgery, commercially different — THR 1/2/3, Revision TKR 8/9/10 are hospital-commercial variants; "the user can choose").
- **B3 — robotic answer re-runs the gate** (his feedback: "it could have allowed me to change it to robotic TKR unilateral"): a robotic=yes answer promotes the robotic package (ORT5535) to the top in gate, build and flow-2.
- **B2 — pick-any-package** in flow-2 ("use this" per candidate) + dock chips.
- **C1+C2 — clinical vs commercial split** (his meeting-2 design: clinical = IP-approximate bill with no package/PF confusion; commercial = tariff/package/incl-excl/GIPSA/PF): a two-card strip on flow-2 results with BOTH grosses side by side. C3 — flow diagram (`todo_and_helpers/clinical-commercial-flow.md`).
- **D3 — cross-consultation PF separated** from the operating surgeon's PF (his 17-Jul: "cross consultations handled separately"): consult rows tagged `cross_consult`, own sub-group, never scaled with surgeon PF; surgeon rows absorb the historic target net of the fixed consult amounts.
- **E1+E2 — audit tooling:** Feedback dock carries the exact flow-2/3 request for recreation; HIMS-vs-derived source legend on the case set.
- **Evening feedbacks (`feedback_jul18.pdf`):**
  - **F1 — the ₹10 placeholder** (DJ stenting URO5443): stage-1 hint showed ₹10 while stage-2 priced ₹70k/74k/83k. Deep cause: the Service-All matrix ITSELF carries duplicate TR1 rows at ₹10 for some packages (his data note) — for URO5443 the matrix has ONLY ₹10 rows; the real prices live in the package master's tariff-info. Fix (`87e1a98`+`79216d2`): charges ≤ ₹1,000 are never treated as prices anywhere; candidates promote their real General-room amount into a placeholder scalar; quotes priced from a real room tier are no longer blocked by master "not ready". Verified: hint ₹10 → ₹70,000, quote ₹1,42,866 unblocked. **The ₹10 dup rows still deserve data-side cleanup.**
  - **F2 — GIPSA/non-GIPSA reclassification (PENDING, next up):** his dataset never tagged GIPSA. Agreed rule: HIMS general→Cash, corporate→Corporate, insurance→if the org is a GIPSA org (TR290 tariff) then GIPSA else non-GIPSA.
  - **F3 — answered:** yes, package LOS comes from the pkg master since 18-Jul (A1).
  - **F4 — Audit view** (HO `d1d2759`): the Excel "Estimate Breakdown" sheet as an in-app table (line item / bucket / sub / source / how-calculated / included / qty / rate / amount; FC edits flagged).

### 2026-07-18 (evening) — feedback fixes + "Ask the Project"
- **F1 — ₹10 placeholder pricing fixed end to end** (`87e1a98`+`79216d2`): the Service-All matrix itself carries duplicate TR1 rows at ₹10 for some packages (URO5443's matrix rows are ALL ₹10 — real prices live in the package master's tariff-info). Charges ≤ ₹1,000 are never treated as prices anywhere; gate candidates and the stage-1 hint promote the real General-room amount over a placeholder scalar (hint verified ₹10 → ₹70,000); a quote priced from a real room tier is no longer blocked by master "not ready" (DJ stenting quote ₹1,42,866 unblocked).
- **F4 — Audit view** (HO `d1d2759`): the workbook's "Estimate Breakdown" sheet as an in-app table on the workbench (line item / bucket / sub / source / how-calculated / included / qty / rate / amount; FC edits flagged).
- **"Ask the Project" launched** at `/ask` on the engine (`aa9f5a2`→`349e4e8`): this chronicle + the auto-refreshed git log ride the Ask-AI context, so "what is the logic / what was it before / when did it change / what did the manager say" questions get dated, cited answers. Added: standalone chat page, **server-side conversation storage** (`fc.ask_conversations` — shared across browsers, sidebar with past chats), **screenshot understanding** (paste/attach/drop up to 4 images; the agent reads the figures, verifies them against live queries, and explains each number's provenance).
- **Agent hardening after the manager's first real failure** ("list the 7 robotic TKR cases" → "could not produce an answer"): two causes — (1) the robotic tables + stay columns weren't in the agent's schema notes; (2) at tool-budget exhaustion the model was still mid-query, so the empty final turn hit the canned fallback DESPITE having all rows in hand. Fixes (`9c3d01d`+`349e4e8`): schema notes now cover the robotic classification tables, raw-vs-ceiled stay fields and the cohort-reproduction recipe; live `information_schema` discovery is mandatory before giving up; tool budget 6→9; and a forced no-tools final-synthesis pass answers from gathered results when the budget runs out. Standing rule: never chase a conversation-quoted count — data drifts; present what the data shows and note the difference.

### 2026-07-18 (late) — surgery master received, measured, wired in
- Manager shared `Surgery Master _SSG.xlsx` — the hospital's canonical surgery/procedure list (14,885 rows, 7,938 codes, 38 tariffs); "it's what the FC currently uses to map what the doctor has written to which dropdown to select"; medical management deliberately has no list.
- **G1 coverage analysis** (`fc.surgery_master` ingested, report `g1-surgery-master-coverage-18jul.md`): 97.7% of billed surgical admissions map (code 86% + name 12%); 95.2% of ALL surgical IP admissions map via OT-booking/package/bill-line codes; medical maps 1.6% (expected negative control). ~159 billed codes are missing from the master (reconciliation export for the hospital); legacy 2024 OT names are the other gap class.
- **G2** (`ccb440e`): the surgery master became a first-class stage-1 matching corpus in the gate/build/flow-2 ranking, with `master_match` provenance on candidates. Verified: "DJ STENTING (DOUBLE J STENTING) - UNILATERAL" and "cystoscopy with DJ stenting" both surface URO5443 at the real ₹70,000; TKR candidates/verdicts unchanged.
- **G3** (`5695a30`): treatment directory at `/treatments.html` — all 309 treatments with case counts (total + per payor), surgical/medical, daycare/robotic/emergency rates, LOS p25/50/75 and ICU/OT/cath typicals from one mart scan (10-min cache); rows drill into Flow 2 prefilled. This is the `17_july_inp.pdf` clinical-part directory ("we should have a list of all hospital treatments… know the top treatments").
- **D4 closed** — verified on flow-2: the DJ-stenting wording now decides `billing_type: package [URO5443] ₹70,000` via the "similar package NAME" ladder rung (F1+G2 fixed it; the manager's original complaint was a bare minor-procedure answer).
- **D5 closed** — 45-vs-26 reconciled with zero missing data: his 45 = umbrella count of any cash admission mentioning DJ stenting (42 distinct; mostly URSL+DJ combos + bilateral); our numbers are scoped per exact package (URO5011=30, URO5443=0 billed, family cohort=6). Union matches.
- **D6 verified compliant** — the only silent historic overrides are the sanctioned historic-PF paths; cash PF is flag+button; Q3 backfill is additive-only; bands are reference. His PF doc is wanted only for validation samples.
- **F2 closed, no change** — mart already classifies GIPSA per his TR290-org rule with zero violations (3,396 GIPSA all TR290; no non-GIPSA on TR290); the gap existed only in his raw extract, which the engine never uses for buckets. Manager: "no gipsa changes for the moment". His "new pdf" declared waste — rates come from Service-All (A2), LOS from the package master (A1); the only remaining GIPSA ask is the incl/excl delta beyond the MOUs.

### 2026-07-20 (later) — neonatal packages + Due Mobilisation B2
- **Neonatal cash packages (i22, engine `9c8d4b1`):** PAE5048/5049 (Well Baby, MOTHER_BED), PAE5055/5061 (Phototherapy, WARD) added to the FINANCIAL package layer (package_master + room_rates + org_applicability, TR1/cash) — the codes already existed in the clinical surgery_master, so this enriched rather than duplicated. "Surgeon Charges" normalized to professional_fee (neonatologist — role label pending manager confirm). Effective 17-Jun (three) / 18-May (PAE5061). Verified: all four surface as top cash gate candidates at their real rates. Builder can now route: healthy baby 1d→PAE5048 / 2d→PAE5049; phototherapy single→PAE5055×days, double→PAE5061×days; NICU stays a separate flow; phototherapy during a well-baby package is a separate package (excluded from well-baby). NOTE: ingest gotcha — a best-effort INSERT to a maybe-absent table (fc_source_registry) inside the txn aborted it and COMMIT silently rolled back; moved post-COMMIT. Also the runtime view INNER-JOINs package_organization_applicability, so a new package needs an applicability row to appear.
- **Due Mobilisation tool** — new parallel product, separate worktree `feat/due-mobilisation`. B2 shipped: migration 098 (due_mob schema) + ingest module (header-signature schema detection, merge-by-UMR/IP, snapshot-per-day) + upload/ledger API. Not in the estimate engine.

### 2026-07-20 — Phase 2 kickoff (edge cases + Due Mobilisation)
Two meetings set the next phase. Estimate Builder declared ~90% done; remaining = edge cases validated against the manager's cleaned DB (~14k IP). **Mandated workflow:** he sends raw+Codex topic docs → our agent validates against OUR data → we produce a per-topic REVIEW FILE → he approves → only then we implement (noisy inputs archived, never auto-implemented). Four topic docs received and reviewed same day — review files at `todo_and_helpers/review-01..04`: **T1 PF/multi-treatment/extended-stay** (spec + Gen-Doc-6 + his i21 validation; key open question: LAN 25% vs final-insurance 35% surface for the FC estimate, and whether rule-percentages replace the Q1 historic-P50 insurer-PF override), **T2 NME hybrid estimator** (rules classify, history prices, zero-inflated display), **T3 emergency overlay** (six independent facts, decision workflow, OT-E replace-not-add), **T4 positive-case layer** (verified-status-driven, context codes, isolation, MOU OT surcharges). Master plan: `20jul-phase2-master-todo.md`. **Parallel new product: Due Mobilisation tool** (daily report uploads → admitted-patient ledger → collect/enhance worklists) to be built in a separate Hospital_OS worktree, our own PRD, then handover to Gautam.

---

## Part 2 — Logic reference (current logic + its history)

### Payor → tariff
**Now:** Cash ⇒ TR1 (KIMS's own tariff). Insurers resolve via `fc.organization_tariff_mapping` (org → tariff, e.g. National Insurance → TR290 GIPSA, Star Health → TR287). When an insurer tariff has no rate for an item, the TR1 (cash) rate backfills and the row is flagged `tr1_rate`.
**History:** stable since the start; TR1-fallback flagging added in the July rounds for auditability.

### Cohort & payer basis
**Now:** each family maps to `mart.main_table` admissions via `curated_template_names_jsonb`. Basis ladder (15-Jul): exact payor bucket needs ≥15 cases; else Insurance-All (≥20); else All-Payers (≥25); else Cash.
**History:** thresholds fixed in the 15-Jul round after backtesting.

### LOS (length of stay)
**Now:** (1) FC's manual entry always wins. (2) If a package is attached and the master's `package_duration` > 0, that is the default — provenance `los_source: package_master` (0 = daycare-style). (3) Otherwise the cohort P50 of billable stays. Daycare rules: LOS < 1 day ⇒ daycare (14-Jul rule 4); ambiguous families require an explicit Daycare/Inpatient confirmation (15-Jul Q7).
**History:** originally cohort-only, using p50 over CEIL-style `normalized_billable_stay_days` ("billable nights"). 17-Jul the manager flagged conventional TKR showing 5 where 3 was right ("it's taking the larger value") — 18-Jul audit confirmed the ceiling inflation, and per his 17-Jul directive the package-master duration became the primary source (A1, engine `1250c28`). TR1's TKR package duration is 3.

### Package matching (which package for this wording?)
**Now:** alias word-match on `fc.package_alias` → if empty, master-catalog NAME search (17-Jul TR287 fix) → AI clinical ranking at temperature 0 → deterministic per-candidate verdicts (18-Jul B1: laterality/side aware — unilateral ask ⇒ bilateral marked not-a-match; robotic/revision reasons) → robotic answer re-biases to the robotic package (B3) → a not-a-match candidate never leads. The FC can override to ANY candidate (B2) — same surgery under different commercial packages (THR 1/2/3) is explicitly the user's pick (his 17-Jul call; the hospital's own assignment rule for those variants is still an open ask, #8).
**History:** aliases-only at first → 17-Jul master-name fallback (TR287 had 951 aliases but only 2 KNEE ones — gate/build disagreed) → 18-Jul verdicts + robotic bias + override → 18-Jul (late, G2) the hospital's **surgery master** (`fc.surgery_master`, 7,938 canonical codes — literally the FC's dropdown list, received from the manager that day) became a first-class candidate source: word-match on SURGERYNAME → surgery_cd → package on the tariff, unioned with alias/master-name candidates before AI ranking (G1 had measured ~95% of surgical IP bills carry these codes; fixed the DJ-stenting candidate surfacing).

### Package pricing (what does the package cost?)
**Now:** priority per (tariff, package, room): ① Service-All matrix (`fc.service_tariff_rate_matrix`, 18-Jul A2 — his "the package tariff should come from the service tariff" directive) → ② structured `room_rates_jsonb` → ③ per-room rescue parsed from `tariff_information` markdown (17-Jul #3). Charges ≤ ₹1,000 anywhere are placeholders, never prices (18-Jul F1 — the matrix itself carries dup ₹10 TR1 rows). The with-package quote prefers the room-tier price; a band-check can fall back to the scalar; a real room-tier price un-blocks master "not ready" readiness.
**History:** master scalar `package_amount` first (broken by ₹10 placeholders) → 17-Jul tariff-info rescue + placeholder guard → 18-Jul matrix authoritative + placeholder-proofing end to end.

### Package LOS / duration
**Now:** `package_duration` from `fc.package_master` (0 = daycare), `pre_days`/`post_days` exposed separately — NOT used for LOS (his explicit 17-Jul instruction).
**History:** before 18-Jul, package cases used cohort LOS like everything else.

### Professional Fees (PF)
**Now, three regimes:** (1) **Cash surgical:** logic cascade — Surgeon 25% of the pre-PF subtotal, Assistant Surgeon 15% of surgeon, Anesthetist 25% of surgeon, Assistant Anesthetist 25% of anesthetist. (2) **Insurer:** tariff carries token PF (₹740-style) — bucket re-priced to the cohort's billed P50 (15-Jul Q1 "use the historic PF P50 for the time being"). (3) **Medical management:** NO surgeon cascade — a single "Physician Fees — Daily Visits" row priced from billed PF history (17-Jul feedback #4); his visit-based fee sheet will refine it. **Cross-consultations (diet etc.) are separate** (18-Jul D3): tagged, own sub-group, never scaled with surgeon PF.
**Direction (18-Jul meeting, pending his doc):** historic matrix becomes REFERENCE-only — only the explicit historic-PF override survives; other discrepancies get flagged, not silently replaced.
**History:** cascade-for-everyone at first → Q1 insurer historic → 17-Jul medical split → 18-Jul cross-consult separation.

### Robotic
**Now:** DB-classified per admission (`fc.robotic_admission_classification`), never AI guesswork. Per-payor default (15-Jul #9): presence >90% ⇒ included; ≥30% ⇒ optional add-on row + convert prompt. Add-on priced from the payor tariff's contracted robotic item, else cohort billed history. Wording detection negation-guarded (P2). A robotic=yes answer re-biases the package pick to the robotic package (18-Jul B3).
**History:** 15-Jul rules → P2 negation guard → 18-Jul gate re-bias. Note: robotic classification must run per payor — conventional cohorts hide insurer robotic cases.

### Medical-management families
**Now:** registry-flagged (`rows: {surgical:false, ot:false}`); no CSSD/OT/instrument rows, no surgeon-PF cascade, no auto-attached package (#5), visits-style PF from history.
**History:** before 17-Jul feedback #4, medical estimates leaked surgical rows (CSSD ₹2,000 + ₹6.7k fabricated surgeon PF in his pulmonology case).

### Combos
**Now:** intake detects multi-treatment wording, announces the combo, prices each path alone; combined figure = sum of per-path P50s labeled "combo interactions not modeled — upper-bound".

### Insurance settlement
**Now:** per-room insurer-vs-patient split; patient side = NME (non-medical items), copay (% or absolute), proportionate deduction, sub-limit overflow, room-upgrade excess, beyond-cover. Room-rent caps: none / ₹-per-day / % of SI (ward 1% / ICU 2% defaults) / room-category.

### Transparency & audit surfaces
**Now:** Engine-flow dock (live gate on Inputs, full notes 1–7 after build), stored `flow_summary` per estimate (admin), Flow-2 stepper with per-step evidence + case set + clinical/commercial split strip, Data source + Historic metrics modals, F4 Audit view (Excel-style breakdown in-app), Feedback dock with exact-request recreation bundles, HIMS-vs-derived source legend, Ask-AI (read-only SQL) — and this chronicle.

### Known data issues (open)
- Duplicate TR1 matrix rows at ₹10 (newer workbook) — guarded in code, needs source cleanup.
- GIPSA/non-GIPSA missing in the shared dataset — F2 reclassification next (TR290-org rule).
- His 45-vs-26 case-count discrepancy — awaiting his side (watch "PR292").
- Star Allied absent from the non-GIPSA tariff-bearing insurer list (F3 of 17-Jul report).
- Implant-heavy cases (bilateral TKR, PTCA-with-stent) under-estimate ~50% — implants ride as exclusions in real bills; pending token-OT (Q2) + implants work.

### Waiting on the manager (current as of 18-Jul night)
1. **GIPSA incl/excl DELTA** — only the additions beyond the previously-extracted MOUs (he's chasing the hospital). The old "updated GIPSA+MOU sheet" ask was **dropped 18-Jul** ("the new pdf is waste") — rates come from Service-All (A2 done), LOS from the package master (A1 done).
2. **Common-exclusions sheet** — always-excluded items (cross-consultation etc.) that apply to every package.
3. ~~Historical dataset~~ — ✅ **received + ingested 18-Jul night**: the Dec-2024→Apr-2025 window (his two xlsx exports) loaded via the standard snapshot pipeline — package-bill admissions 12,648 → 17,002 (+34%), 690k lines, coverage back to Aug-2024, reconciliation 98.6% within 1%, bucket metrics + robotic classification rebuilt. Anything older than Dec-2024 would be a future drop.
4. **PF doc with samples** — for VALIDATION only; the flag-not-override semantics are already implemented and verified (D6).
5. **Cleaned FC data Dec-2024→** (doctor remarks, billing tags, estimates, actual bills) — he does the cleaning.
6. **GIPSA business-rules JSON.**
7. **THR 1/2/3 assignment-rule confirmation** — hospital rule vs purely the FC's pick (today: user's pick, B2).
8. **His OK on the 45-vs-26 reconciliation** (D5 closed our side: no missing data, scope difference) + his PR292 note if it changes anything.
9. **Hospital-side data cleanups** (guarded in code, source still dirty): duplicate ₹10 TR1 tariff rows; ~159 billed surgery codes missing from the surgery master (export ready).
10. **Visit-based medical-PF fee sheet** (medical PF interim = billed history P50).

RECEIVED so far: surgery master sheet ✅ (18-Jul — measured G1, wired G2, directory G3); read-only DB access delivered ✅.

---

## 2026-07-22 — Tab-2 NME unblocked: HIMS NME ingest + cohort profiles + advisory wiring

Manager's i23.md revealed the real NME target is **`HIMS NME Amount (Rs.)`** in `Estimate-Variance-Report (1).csv` — NOT `fc.package_bill_admissions.nme_amount` (that set is ~all zero: 192/17,002 positive). Constraint: import ONLY IPs present in our DB, relevant fields only, no PII; HIMS vs FC NME separate; quarantine negatives. Built on branch `feat/nme-phase1` (not pushed):

- **migration 003** `fc.fc_nme_source` (16,389 present-IP admissions; 10 EVR orphans dropped; 29 negatives quarantined; lineage-preserving, no PII) + `fc.nme_profile` (cohort positive-prob + positive-only P25/P50/P75/P80; ladder L1 payer+package+dept+LOS+ICU → L2 dept → L3 payer+package; min-sample gating ≥30/15-29 blended/<15 fallback). `scripts/backfill-nme.js` idempotent ETL over `matched_in_mart` clean cohort (14,031). Reconciles to manager targets within ~1% (P50 5,466 vs 5,524; P75 9,235 vs 9,272; pos 4,321 vs 4,212).
- **`nmeProfile.js` `lookupExpectedNme()`** + `buildEstimate.js`: `estimate.expected_nme` (Open Bill) + `packageOffer.expected_nme` (Package Bill), **non-Cash only**, as a SEPARATE advisory patient-payable line (P50 typical-when-present + positive_prob) — never folded into the settled insurer/patient split. Cash → null; table-absent → null (never breaks the estimate).
- Verified: Non-GIPSA ortho open-bill ₹12,156 @86% (L1); package ₹280 @30%; GIPSA → L2; Cash null. **No regression** — sanity_insurance 24/0, sanity_family 12/0; settle()/totals byte-identical.

Open: push pending approval; frontend must render the advisory line; International Open-Bill L3 is a 2-sample ₹150k outlier (winsorize later); Phase-2 still needs companion exports (clean spine, open-bill service lines, pharmacy lines) — FC folder alone only unblocks admission-level NME.

---

## 2026-07-22 — Tab-3 Emergency billing overlay

Doc T3: emergency is a **billing overlay on Treatment A** — never a separate treatment, never one surcharge; a decision workflow, not auto-charges. Manager approved the components ("Make sense"), confirmed Q1 (ER-physician auto-on only when arrived-via-ER=yes, rest opt-in), Q3 (one mutually-exclusive method), and the governing principle Q4 **"we don't infer"**. Q2 (emergency-OT) left "need more info". §5 validation ("Sure") run first.

**§5 validation** (fc.package_bill_lines, 17,002 admissions): D000806 ER-physician median ₹1,000 (n≈91); EME5060 ER-assessment ₹3,000 (n=56, ~96% of occurrences insurance, ~0% cash — the doc's "93-94%" is the payer *share* of occurrences, not a penetration rate; base rate is low); EME0065 emergency-bed ₹1,310 (n=49); **OTC0054-0069 emergency-OT = 0 admissions** → confirms Q2 gap, marks OT-E ACTIVE_POLICY (not history-validated).

**Built on `feat/emergency-overlay` (not pushed):**
- `emergency.js buildEmergencyOverlay()` — additive, explicit-input-only, never mutates the parity-pinned base totals. ER physician (history-priced, no tariff row), ER assessment (tariff, insurance default-on / cash default-off), emergency bed (tariff, ask). Package-% flagged `requires_agreement` (mutually exclusive w/ OT-E, Q3); emergency-OT `ACTIVE_POLICY`; variable services as range display. Attached as `estimate.emergency`.
- Estimate schema: `arrived_via_emergency_department, is_clinically_emergency, emergency_bed_expected(+hours), emergency_pricing_method` (all default off).

Verified: insurance ER arrival → physician+assessment ₹4,000; +bed ₹5,310; cash → assessment OFF, ₹1,000; **baseline byte-identical**. No regression — sanity_insurance 24/0, sanity_family 12/0.

Open (for manager): Q2 emergency-OT still needs data to validate (0 historical); ER-physician priced from history (no tariff row) — confirm ₹1,000 reference; holiday calendar not built (Q4 — no auto-apply); package emergency-% needs per-org agreement table; variable-services range dataset not yet wired.

---

## 2026-07-22 — Tab-4 Positive-case (infective/seropositive) billing layer

Doc T4: a separate positive-case billing-rule layer — VERIFIED status only, explicit FC toggle (or explicit doctor's-note selection), NEVER inferred from a test order (MIC0066 is in 2,840 admissions incl. 905 medical — just an investigation). Manager approved §2 rules; key answers: #5 OT surcharge 50%/100% is **standard for GIPSA+Non-GIPSA (no MOU list needed)**; #6 package-case OT base = package-embedded OT with review flag; Q1 single toggle; Q2 positive-OT + emergency-OT share the OT base, separate lines, **no compounding**; Q3 **policy-first** (124 samples → ACTIVE_POLICY/PROVISIONAL); §5 validation first ("Sure"). Blocked #1-4 → handle with flags (rare).

**§5 validation** (package-bill lines only — package_bill_lines has ZERO open-bill line data, 4,906 pkg IPs): RNS0123 51 / RNS0122 12 / RNS0121 1 / RNS0116 5 vs doc full-cohort 83/13/1/31; cohort 67 vs ~124. The delta is open-bill positive cases we have no line data for — **the same open-bill gap as NME Phase-2**. RNS0123 priced ₹16,280 = tariff median. HSP5020-5024 in TR1 (priceable); RNS0123/0121/0122 in TR177 only; MSC2816 ₹10 placeholder (Blocked #3).

**Built on `feat/positive-case-overlay` (not pushed):**
- `positiveCase.js buildPositiveCaseOverlay()` — additive overlay `estimate.positive_case`, never mutates base totals; charges outside package by default. HBsAg/HCV context code by surgery_context (medical = no charge); HIV LOS-banded HSP5020-5024; isolation RNS0101 (ICU isolation CONTEXT_REQUIRED); OT surcharge +50%/+100% standard GIPSA+Non-GIPSA, OT base only, separate line, no compounding w/ emergency-OT. Rate = payer tariff + TR1 fallback, never hardcoded; absent → CONTEXT_REQUIRED. Policy-first flags. Blocked #3/#4/#6 as flags.
- schema: positive_status, confirmation_source, requires_isolation, isolation_room/icu_days, surgery_context, payer_agreement_id.

Verified: HBsAg non-heart ₹16,280 +50% OT; HIV HSP5022 ₹11,000 +100%; +isolation ₹25,760; cash → no OT surcharge; baseline byte-identical. No regression — sanity_insurance 24/0, sanity_family 12/0.

Open (for manager): ICU isolation code (#1), rates effective date (#2), MSC2816 conflict (#3), RNS0116 validity (#4) — all pending hospital; open-bill line data needed to see the full 124 cohort; frontend to render the positive-case toggle + section.

---

## 2026-07-22 — Tab-5 Insurance DNB four-value billing-disposition model (N1)

Doc T5: 12 "Do Not Bill" items that must never make the patient liable — FC estimate shows only patient_payable; SI exhaustion never transfers these to the patient. Manager answers: D1 → **follow final-bill logic (GIPSA vs Non-GIPSA differ)**; cash rules don't apply to insurance; **N1 four-value model APPROVED as metadata-only** (UI = covered/non-covered; hide items where patient pays ₹0); patient-facing = only patient_payable (confirmed); drug-admin-as-NME = **moot** (drug-admin not present in insurance; NME is insurance-only); ₹1-share reproduction + N1 wiring = "need more info".

**Engine audit:** classifyRow already routes most DNB items off the patient (monitor/intensivist/ICU-nursing → icu; asst-anaesthetist/asst-physician/DMO → associated) — the "patient ₹0" goal is largely already met; no separate patient-side PF lines, so the "suppression lowers insurance PF" concern is mild for us.

**§5 ₹1-share validation BLOCKED:** package_bill_lines is package-bill-only, so our shares are ~0-4% vs the doc's 43-50% (DMO 1.6% vs 46.5%, monitor 0.6% vs 43.4%). The ₹1 non-show is an open-bill/LAN phenomenon — needs open-bill service lines (3rd time this gap bites: NME Phase-2, positive-case cohort, DNB ₹1-share).

**Built on `feat/dnb-disposition` (not pushed):**
- `src/modules/insurance/dnbDisposition.js annotateDnbDisposition()` — PURE metadata annotation on the settlement rows; changes NO amount. Each row gets billing_disposition (CLAIM_AND_WAIVE_IF_DENIED / INCLUDED_IN_PARENT_TARIFF / LAN_NON_SHOW_RUPEE_ONE / SUPPRESS_DO_NOT_BILL / PATIENT_PAYABLE_NME_GIPSA / PATIENT_PAYABLE / COVERED) + four_value block + fc_hidden (patient ₹0 → hidden from FC). GIPSA general-instruments → PATIENT_PAYABLE_NME_GIPSA (label only). `dnb` summary on the settlement.
- Wired into buildEstimate for both estimate.insurance_settlement and packageOffer.insurance_settlement.

Verified: insurer_total/patient.total unchanged; sanity_insurance 24/0, sanity_family 12/0.

Open (for manager): ₹1-share needs open-bill line data + manager clarity ("need more info"); GIPSA general-instruments NME **amount-move** (currently label-only) is a verified-number change held for confirmation; N1 metadata is ready but UI wiring (covered/non-covered + insurer/audit view) is a frontend follow-up.

---

## 2026-07-22 — Tab-6 Newborn pathways

Doc T6: four DISTINCT newborn pathways (healthy-with-mother / well-baby-in-package / phototherapy / NICU), never one "newborn" estimate. Manager: "newborn" never auto-adds bed/PF — explicit select then confirm (Agreed); NICU days from NICU room-service codes not generic icu_days (Agreed); provided **4 cash newborn packages** (verified in package_master: PAE5048 ₹11k / PAE5049 ₹18k / PAE5055 ₹22k / PAE5061 ₹23k); cradle code missing → flag; mother-baby linkage = ask the FC (FC perspective); §4 validation "Sure".

**Built on `feat/newborn-pathways` (not pushed):**
- `src/modules/engine/newborn.js buildNewbornScenario()` — additive scenario `estimate.newborn`, explicit-selection-only, never mutates base totals. healthy_with_mother (₹0 bed + neonatologist/paediatrician PF history modes ₹8k/₹4k + BIO5229 screening + BIO0240 bilirubin); well_baby_package (PAE5048/5049, or attach-to-mother); phototherapy (PAE5055/5061 per-day × days + PF); nicu (ROM5015 NICU bed × nicu_days + PF + investigations, NOT icu_days). Priced from payer tariff (TR1 fallback) / 4 cash packages / history PF. N3 blocks as flags (cradle code, package master beyond 4 pkgs, mother-baby linkage).
- schema: newborn_pathway, newborn_stay_days, nicu_days, newborn_twins, newborn_in_mother_package, phototherapy_double_surface.

§4 validation note: 144 healthy-newborn cohort (median PF ₹8k, cash P25/P50/P75 ≈ 9.2k/15.1k/18.9k) is open-bill/minimal → not fully reproducible on our package-bill-only lines; pathways are tariff/package-priced, not history-certified (consistent open-bill gap).

Verified: healthy ₹19,290; well-baby-2d ₹18,000; in-mother attach ₹0; phototherapy-3d ₹69,000+PF; NICU-5d ₹55,840; baseline byte-identical. No regression — sanity_insurance 24/0, sanity_family 12/0.

Open: cradle code (asked hospital); Tab-7 mother-linked-bed is the companion; frontend to render the 4 pathways + provisional-then-confirm flow.

---

## 2026-07-22 — Tab-7 Newborn mother-linked bed (KB-only)

Doc T7: newborn linked to mother via a "dollar bed" (522§1) — ₹0 while rooming-in, chargeable on NICU-transfer or mother-discharge. **Manager deprioritized for FC**: "linkage bed is not an FC-related thing… we can ignore that", handle with the right question when the FC selects newborn; optionally a knowledge-base item (secondary). The FC-relevant handling is already in Tab-6 (healthy-with-mother ₹0 bed, in-mother-package attach, twins flag, NICU pathway).

**Built on `feat/newborn-mother-linked` (not pushed):** no automation — only a `mother_linked_kb` reference (scope knowledge_base_only) on estimate.newborn: 3 bed states (rooming_in ₹0 / moved_to_nicu ICU billing / mother_discharged ordinary bed). Metadata-only; no amount change; sanity_family 12/0. §4 note: 507 baby/neonatal clean admissions support the 3 states, but linkage fields (mother adm no., dollar-bed no., discharge/transfer timestamps) aren't in our data — validation base for later.

---

## 2026-07-22 — Tab-8 Package Inclusion/Exclusion (validation + clarification, NO code change)

Doc T8: how the builder handles what a package absorbs vs bills extra; whether a hidden pharmacy/investigation threshold exists (it doesn't). Manager: §1 core design **Agreed** (start from governed package rate + add only source-supported extras — already our approach; four independent per-item decisions; honour cash caps); don't invent GIPSA/Non-GIPSA caps from exclusion frequency **Agreed**; but **"need more info"** on the conditional-extra label, the no-offset rule, Non-GIPSA org-resolution, and data-readiness; **N2 package-rule-schema questioned** ("mostly doesn't seem right approach").

**§4 validation (our RDS):**
- Cash reconciliation-to-₹0 (`gross = pkg + defined_exc + undefined_exc + nme`): **1,465/1,486 = 98.6%** reconcile — reproduces the doc; UNDEFINED_EXCLUDES is a balancing field → **no hidden threshold/cap**. Insurance reconciles far less (Non-GIPSA 53%, GIPSA 38%) → confirms "excluded lines are not auto patient-payable; don't invent caps".
- Runtime-ready packages (`has_inclusions AND has_tariff`): **176 cash + 570 Non-GIPSA + 259 GIPSA** — FAR ahead of the doc's snapshot (114 + 45 + 0). The "data not runtime-ready / 0 GIPSA" concern is largely resolved for us.
- `coverage.js` already implements §1 (parseCoverage/applyCoverage → fully_included / partially_included / capped / excluded / payable_extras from the package rate + source-supported extras).

**Decision: no engine change.** Our engine + data already meet the endorsed design; N2 heavy per-line schema NOT built (manager's instinct confirmed — the four-status coverage model + cash-reconciliation-to-₹0 already covers it). Clarifications written for the manager's 4 "need more info" points (conditional-extra label, no cross-component offset, Non-GIPSA org→agreement→package→rule resolution, data-readiness now much better).

---

## 2026-07-22 — Tab-9 Cross-consultation pricing

Doc T9: hybrid detect-and-confirm; separate subtotal under Professional Charges; excluded from surgeon-PF denominator; diet consult (DIE0001) is NOT a cross-consult. Core (exclusion + grouping) already shipped D3 (17-Jul) — confirmed. Manager: never auto-include (suggest-and-confirm) Agreed; **one visit/consultant/day** (cross-consults only, not primary) Confirmed; role placeholders when doctor unknown, specific doctor needs name+verified code; **Non-GIPSA/TR201 kept as EXCLUSION** until a TR201 include-guideline is added; **insurance → placeholder department (not doctor name), contracted rates by TR code — "validate this once before implementing"**.

**Validation (his ask):** `fc.consultation_tariff_rate_matrix` = 35,372 rows, 57 depts × 30 tariffs, tariff_cd populated (34,119) — resolves the old `v_consultation_rates_current` null-tariff blocker. Rates are FLAT per dept+tariff+ward (TR290/GENERAL: Ortho ₹2,500, Cardiology ₹3,000, across all doctors) → placeholder-department pricing by TR code is valid.

**Built on `feat/cross-consult` (not pushed):**
- `src/modules/engine/crossConsult.js buildCrossConsults()` — FC-selected, suggest-and-confirm, additive `estimate.cross_consultations`; base unchanged. Prices from consultation_tariff_rate_matrix by (payer tariff + dept + ward); INSURANCE → placeholder dept CROSS:<DEPT> (real doctor code before billing); doctor_cd → specific rate (cash/open). One visit/day cap (visits ≤ LOS). Charged separately at visit tariff, not PF %. TR1 fallback; absent → CONTEXT_REQUIRED. package_treatment=excluded_charge_separately (GIPSA 96.5% / Non-GIPSA 91.7%; TR201 kept excluded).
- schema: cross_consults [{department, visits?, doctor_cd?}].

Verified: GIPSA Cardiology 2v ₹6,000 + Nephrology ₹2,750; cash specific-doctor ₹1,000; baseline byte-identical. No regression — sanity_insurance 24/0, sanity_family 12/0.

Open: supply a governed consultation tariff-code mapping for exact per-doctor auto-pricing (placeholder-department works meanwhile); ~92% outside-package reproduction is package-bill-limited (open-bill gap); frontend to render the suggest-and-confirm cross-consult picker.

---

## 2026-07-22 — Tab-10 Outside-package LOS excess-day model

Doc T10: beyond the package LOS, package stays the base charge; only incremental excess-day care added at actuals; package + PF never recomputed. Manager: outside-package ≠ collect from patient (apply insurer eligibility after) Agreed; per-setting ledger **only when ward/ICU breakdown exists, else total LOS regardless of setting**; new procedure during excess = separate treatment (Yes); no double-charge (PACKAGE_EXCLUSION xor POST_PACKAGE_LOS) Agreed; **drug-admin on excess pharmacy = CASH only** (for outside-package pharmacy it applies on cash); "recheck package master for LOS".

**Validation:** package_master LOS coverage = **1,149/1,149 have package_duration (0 missing)** — the manager's 743-missing concern is resolved for us. No prior explicit excess-day charge model existed (only package_duration as the LOS default).

**Built on `feat/outside-package-los` (not pushed):**
- `src/modules/engine/outsidePackageLos.js buildOutsidePackageLos()` — additive `packageOffer.outside_package_los`, package base+PF untouched. Per excess day: room (ward ROM0001/0024/0036 / ICU ROM5009), DMO (ROM0093, ward), intensivist (ICC0002, ICU), physician visits (1 ward/2 ICU/day at the treating-dept consultation median). Net pharmacy + investigations as RANGES. All lines POST_PACKAGE_LOS. Per-setting ledger when ward/ICU breakdown present, else total excess LOS. Drug-admin on excess pharmacy CASH-only. collectability=apply_insurer_eligibility_after. New procedure during excess = separate treatment (flag).
- Wired into the package route (fires only when drivers.los.selected > package_duration).

Verified: GIPSA overstay 12d (pkg LOS 4) → 8 excess days, ₹44,008 deterministic (ward room 8×₹3,000 + DMO 8×₹1 [GIPSA ₹1-non-show] + physician 8×₹2,500), pf_recomputed=false, no drug-admin on insurance; no overstay → none; baseline byte-identical. No regression — 24/0, 12/0.

Open: ward/ICU package-level breakdown not in package_master (pkg_defined_*_stay) → total-LOS fallback used; net-pharmacy/investigations exact numbers need per-day cohort data (open-bill gap); frontend to render the excess-day breakdown.

---

## 2026-07-22 — Tab-11 Medical management (family × setting menu)

Doc T11: NOT one generic medical estimate — ~15 clinical families × setting (ward/ICU/daycare), exact room+PF, ranged pharmacy/investigations, doctor high-value items auto-added, 5-step hybrid mapping. Manager: Agreed on the model; procedure-like items get a separate UI name (Agreed, asked Subha to confirm — yes); 28-admission general template = "need more info"; policy-first with **semi-manual FC builder fallback** (auto-add calculable room/drug-admin/PF, FC manually adds pharmacy/investigations) when no strong template; doctor indication must be structured (remarks are counselling language); §4 validation Yes.

**Validation:** setting bands (open-bill non-surgical) — Ward P50 ₹75,053 (doc ₹73.5k ✓), ICU-involved P50 ₹210,046 (doc ₹1.73L), Daycare/Obs P50 ₹36,256 (doc ₹28.2k). Top medical depts: Med Onc, Nephrology, Paediatrics, Internal Med, Neonatology, Pulmonology, GI, Cardiology.

**Built on `feat/medical-management` (not pushed):**
- `src/modules/engine/medicalManagement.js buildMedicalManagement()` — additive `estimate.medical_management`, base unchanged. calculable auto: room (setting×LOS), governed PF (1 ward/2 ICU per day), drug-admin (cash only). pharmacy/investigations/bedside → historical RANGES (estimable families) or MANUAL (semi-manual). PROCEDURE_LIKE (chemo/dialysis/transfusion/endoscopy/IR/planned) → route_out. semi-manual fallback (auto room/PF/drug-admin, FC adds pharmacy+investigations). high-value items = confirm-before-add; indication_text preserved; refresh triggers (24h/ICU-transfer/LOS/high-cost-investigation/pharmacy-escalation).
- buildEstimate queries the validated setting band (by setting + department) for the range.
- schema: medical_management {family, setting?, high_value_items?, indication_text?, semi_manual?}.

Verified: respiratory ward ranged (₹115.5k P50 Pulmonology, n=318); neuro ICU → semi-manual; chemo → route out; general daycare ranged; baseline byte-identical. No regression — 24/0, 12/0.

Open (manager): clarify the "28-admission general-medical template not universal" point; family list + estimable set to be refined with domain input; frontend to render the family/setting picker + semi-manual builder + confidence flags.

---

## 2026-07-22 — Tab-12 Daycare stay/billing modifier + classifier fix

Doc T12: daycare is a stay/billing MODIFIER (treatment/drug drives cost — chemo ₹25.4k vs immunotherapy ₹150.7k vs cystoscopy ₹39.5k), not a generic estimate. Manager: keep foundation; classifier fix (strict ≤12h + 4 statuses) "Sure"; auto-daycare = confirm "Sure"; DMO-excluded/nursing-conditional/no-mix/MSC10-not-procedure "need more info but seems right"; inpatient-conversion contingency "seems right"; oncology previous-cycle only if regimen-equivalence "need more info, will ask hospital + check FC DB"; drug/regimen infusion pricing blocked (chemo tab). §4 validation Sure.

**Validation:** classifier bug reproduced — calendar-date-only "strict" = 2,937 vs real ≤12h = 2,720 (268 extended same-day cases wrongly counted, analogous to the doc's 119). Timestamps carry hours, so the 12h threshold is computable. (ROM0010 line cohort is package-only = 2 rows — open-bill gap; used timestamp-hours split across all short-stay admissions instead.)

**Built on `feat/daycare` (not pushed):**
- `src/modules/engine/daycare.js` — `classifyDaycareStatus(hours, sameDay)` (12h fix: strict_daycare / extended_same_day_daycare / daycare_cross_midnight / converted_to_inpatient) + `buildDaycareModifier()` → additive `estimate.daycare`, base unchanged. auto-daycare=confirm (confirmed=false when auto_suggested); ROM0010 (never both w/ RNS0075); DMO excluded; nursing conditional; MSC10 not a procedure; inpatient_conversion contingency (retain daycare + ward/ICU from conversion + excess-LOS if packaged); oncology_cycle reuse only_if_regimen_equivalence_confirmed; routing=exact_treatment_regimen_cohort.
- schema: daycare_expected_hours, daycare_auto_suggested, daycare_inpatient_conversion (fires when setting=Daycare).

Verified: classifier 8h→strict/16h→extended/20h→cross-midnight/30h→converted; conversion toggles; chemo → oncology-cycle guard; baseline byte-identical. No regression — 24/0, 12/0.

Open (manager): confirm whether non-strict daycare cases are needed for modelling; DMO/nursing/conversion details "seems right, need more info"; oncology cycle-reuse — check FC DB handling of repeating treatments; infusion drug/regimen pricing depends on the Chemo tab (file 13).

---

## 2026-07-22 — Tab-13 Chemotherapy conservative estimator

Doc T13: dedicated systemic-therapy engine — drug/dose/brand/vial explains the bill; default routine chemo → open-bill daycare; never a generic chemo total. Manager AGREED with the conservative approach (add only sure things = base daycare + PF; pharmacy = structured doctor/user input; trigger a separate chemo form) but wanted to FIRST validate how chemo is handled in the hospital FC data, and HELD the deep work (drug master, price audit, prior-cycle) pending hospital confirmation.

**Validation (his ask):** chemo FC estimates ARE created — Estimate-Variance shows 1,624 chemo/oncology admissions with an FC counselled amount (P25 ₹25.1k / P50 ₹44.5k / P75 ₹98.5k, range ₹27k-₹627k). Procedure Name mostly blank → estimate not driven by a structured regimen field today (the gap this module fills). Financial-Counselling "Service Name" is a counselling-event type (Query/Admission/Discharge), not a procedure.

**Built on `feat/chemo` (not pushed):**
- `src/modules/engine/chemo.js buildChemo()` — additive `estimate.chemo`, base unchanged. 5 routes; regimen items priced ONLY from user-supplied unit prices (× vials) else drug_cost_pending (no silent zero, low_confidence); dose_source=treating_team (never computed); never_generic_total; supportive infusions + chemoport SEPARATE; prior_cycle=rebuild_not_copy. `held[]` lists the 3 deferred deep pieces.
- schema: chemo {route, regimen_items[], supportive_infusions[], chemoport, prior_cycle_ref}.

Verified: routine → pending/low-confidence; immunotherapy priced ₹113k + chemoport/supportive separate; baseline byte-identical. No regression — 24/0, 12/0.

HELD per manager (not built): systemic-therapy drug/regimen master; pharmacy-price-coverage audit (6,132/11,254 unpriced → last-observed provisional + confirm); prior-cycle auto-retrieval by UMR. Ties to Tab-12 daycare infusion pricing.

---

## 2026-07-22 — Tab-14 Billing Training Guide (confirmation/enrichment, NO code change)

Doc T14: the 8-sheet hospital billing checklist workbook — useful as a RULE-ENRICHMENT source (billing units, OT slots), NOT a rate master or complete policy. Manager: 133/135 codes already in our tariff, join canonical, ROM0013 (Triple Sharing) + MSC1891 (Cadaver) inactive (Agreed); workbook confirms our LAN PF rules (25/15/25, GIPSA pkg 20 / Non-GIPSA pkg 25, corp 16, cardio 20) (Agreed); **IGNORE the workbook's final-insurance PF block** (35-40/35/45) — "use what we already confirmed, not this"; monitor code error EME0019 (workbook Half-Day vs our Per-Day) — don't import as alias (Agreed); "ignore what contradicts, use only what we already confirmed"; urology-instrument threshold: **"the instrument itself is NOT in the base — validate with the dataset"**.

**Validation:** OT slot ladder (normal OTC0005-0020 / emergency OTC0054-0069) + PF rules already implemented in the engine (lineItems otSlots + Tab-1 PF cascade). Urology instruments OTI0058/0059 = 150 tariff rows each but **0 history admissions** (confirms doc's "absent from history"); present as SEPARATE billable codes → consistent with "instrument not in base" (full threshold-mechanics validation limited by the package-only line gap). ROM0013/MSC1891 = 0 tariff, 0 history → keep inactive.

**Decision: no engine change.** The workbook confirms + enriches existing logic; its only danger (the final-insurance PF block) is IGNORED per manager (same D1/D2 as the PF tab, already decided). Any incremental billing-unit / instrument-tier rules are training evidence in fc_curated, promoted rule-by-rule — not bulk-imported.

---

## 2026-07-22 — Tab-15 Maternal labour-room add-on

Doc T15: labour-room = a maternal LOCATION add-on billed by occupancy duration, additive to (never replacing) the ward charge, never the room category. Manager: agreed; **default <4h at FC estimate time** (no live bed transfer → projected hours as FC input); **"use 0-4 slot as default"**; find the code in the tariff.

**Validation (his ask):** labour-room codes ROM0121 "LABOUR ROOM CHARGES UP TO 4 HRS" ₹9,900 and ROM5166 "LABOUR ROOM CHARGES" ₹15,000 (both flat across ward groups, TR1). No explicit 4-8h/8-12h codes.

**Built on `feat/labour-room` (not pushed):**
- `src/modules/engine/labourRoom.js buildLabourRoom()` — additive `estimate.labour_room`, base unchanged. Rule: <4h → occupied-bed only (charge 0, billed=false); 4-8h → ROM0121 ₹9,900; 8-12h → ROM5166 ₹15,000; additive_to_ward (never room category); off unless delivery pathway/hours; default 0-4h slot. package_open_handling=apply_after.
- schema: labour_room, labour_room_hours.

Verified: default/<4h → ₹0 occupied-bed only; 6h → ROM0121 ₹9,900; 10h → ROM5166 ₹15,000; baseline byte-identical. No regression — 24/0, 12/0.

Open: confirm the exact slot→code mapping with the billing head (tariff lacks explicit 4-8/8-12 codes); frontend to render the projected-hours input under the delivery pathway.

---

## 2026-07-22 — Tab-16 Room-rent GST (highest-confidence, statutory)

Doc T16: statutory 5% GST on non-ICU room rent > ₹5,000/day, on the FULL amount; ICU/CCU/ICCU/NICU/HDU exempt; by service code not ward name; same math all payers; room rent only. Attendant room 18% (no code yet). Manager: guard rails Agreed; **attendant room OFF by default, flag if user selects** (will ask hospital); **HDU assume untaxed for now**; three categories "okay".

**Validation:** no existing GST in the engine. Room bed rates (TR1): ROM0001 general ₹3,320 / ROM0024 twin ₹4,660 (< ₹5,000 → no GST), ROM0036 single ₹7,680 (> ₹5,000 → 5%), ROM5009 ICU ₹10,500 (exempt).

**Built on `feat/tax` (not pushed):**
- `src/modules/engine/tax.js buildRoomTax()` — SEPARATE `estimate.tax` line, additive, never folded into the parity-pinned base total. 5% GST on non-ICU room rent > ₹5,000/day (full amount, strictly above; exactly ₹5,000 → ₹0). ICU → CRITICAL_CARE_ROOM_EXEMPT. Attendant room = no_code_flag_only (18%, off by default). package_rule=tax_identifiable_room_component_only. Categories PATIENT_ROOM_5_ABOVE_5000 / CRITICAL_CARE_ROOM_EXEMPT / ATTENDANT_ACCOMMODATION_18.
- schema: attendant_room. Computed automatically on every estimate.

Verified: General → GST ₹0; Single 3d ₹7,680/day → GST ₹1,152; ICU exempt; attendant flag; baseline byte-identical. No regression — 24/0, 12/0.

Open: attendant-room code/SAC/rate/date from Finance; HDU tax status from Finance (assumed untaxed); frontend to render the "GST on room rent @ 5%" line + attendant-room flag. GST is currently a separate line (not in the headline total) to preserve parity — confirm whether it should roll into the patient-payable headline.

---

## 2026-07-22 — Tab-17 Blood bank (minimal transfusion add-on)

Doc T17: three events (reserve→cross-match / issue→component / transfuse→per-unit); history doesn't follow cross-match reversal (99.6% keep both = probable double-charge). Manager strongly simplified for FC: blood bank only if doctor-inputted; **no unit-level states** ("we don't need this for FC"); **no reversal** (real-time); **FC should only decide if transfusion is needed or not, not units** unless significant impact; **ignore the double-charge for now** (validating with hospital, "don't act on it").

**Validation:** EME0088 Transfusion TR1 ₹1,270; BLD0024 PRBC ₹2,650; BLD0027 FFP ₹500. Blood cohort 1,034 package-only (doc 2,379 full — open-bill gap).

**Built on `feat/blood-bank` (not pushed):**
- `src/modules/engine/bloodBank.js buildBloodBank()` — additive `estimate.blood_bank`, base unchanged. transfusion flag → transfusion service (EME0088) + component (default 1u PRBC BLD0024, or FFP BLD0027). unit_level_model=false; reversal_logic=not_applicable_fc; default 1 unit, optional units. Scope = transfusion service + components only. double_charge_note (not reproduced, not acted on).
- schema: blood_transfusion, blood_component, blood_units.

Verified: default PRBC 1u → ₹3,510; 3u FFP → ₹4,080; baseline byte-identical. No regression — 24/0, 12/0.

Open: manager validating the 99.6% double-charge with the hospital; units modelled only if the doctor specifies a significant count; frontend to render the transfusion-needed add-on question.

---

## 2026-07-22 — Tab-18 Equipment & manual add-on catalogue

Doc T18: governed manual add-on catalogue (OT/ward/ICU equipment, respiratory, bedside, transport) — billing basis, valid locations, mutual exclusions, payer admissibility, four financial columns; staff-confirmed suggestions, never auto. Manager: fetch missing-master supply codes from **past IPs / the tariff dataset**; **MRD/MRT = normal positive charge** (not a discount).

**Validation:** equipment/add-on codes fetchable from tariff (EQP0018 AngioJet, HSP0042 ambulance, ORT arthroscopy, OTI instruments…).

**Built on `feat/manual-addons` (not pushed):**
- `src/modules/engine/manualAddons.js buildManualAddons()` — additive `estimate.manual_addons`, base unchanged. Prices FC-selected add-ons from tariff × billing basis; four-column separation (expected_gross / included_in_package / separately_claimable / expected_patient_payable) by payer+package (insurer-admissible→claimable else patient-payable; "separately billed"≠"separately payable"); mutual-exclusion conflict detection; valid-location check; staff_confirmation mandatory; unknown code→CONTEXT_REQUIRED; MRD/MRT positive. Seed CATALOG (HSP0042/EQP0018/OTI0018); governed masters curated from tariff+past IPs.
- schema: manual_addons [{code, name?, basis?, qty?, location?, mutex?, admissible?, package_included?}].

Verified: ambulance → patient-payable; instrument → claimable; two same-mutex → conflict; cash → all patient; baseline byte-identical. No regression — 24/0, 12/0.

Open: expand the governed catalogue masters (basis/locations/admissibility/rates) from tariff + past IPs; supply the missing-master codes (cradle, arthroscopy major/minor, microscope>3h, NIV variants, retropositive, external PF, hospitality); frontend to render the staff-confirmed add-on picker + incompatibility warnings.

---

## 2026-07-22 — Tab-19 Tariff dataset completeness & fallbacks (validation + deliverable, NO code change)

Doc T19: is our tariff a safe universal price master, and does "missing rate → TR1 fallback" hold? Item identity ~complete (>99.9%, ~23 gaps); insurance exact pricing NOT ready; blanket TR1 fallback REJECTED by held-out (9,710/9,721 failed certification). Manager: ₹1/₹10 placeholder fail-closed **Agreed**; asked **what to use instead of TR1** ("price diff small, your thoughts?"); median-of-room "need info"; **"give me the list of missing codes/rates per TR code"**; service-vs-investigation → lean service-primary, wants our thoughts; 7-step hierarchy "packages or items?".

**§4 engine check confirmed — N6 largely already handled in our engine:** line amounts come from **cohort history** (`amount_cash_typical`, quartiles in artifacts.js), NOT raw ₹1 tariff rows → the "resolver treats ₹1 as valid" failure mode doesn't apply; `PLACEHOLDER_PRICE_MAX = 1000` (packageGate/packages.service/flow2) flags sub-₹1000 placeholder packages (no total + warning); TR1 is a **flagged last-resort** (`tariff_contracted → cohort_history → tariff_tr1_fallback`), cash-only, never a blanket insurance fallback; rateOf is room-specific (no median-of-room).

**Deliverable:** `todo_and_helpers/missing-tariff-codes-per-TR.md` — missing/placeholder frequently-billed codes per insurance TR (TR290 ~640 missing, TR292 & TR274 all 736, TR215 728, TR289 631, TR286 560, TR287 519) for the hospital.

**Decision: no engine change** — our pricing already follows the accurate per-code / cohort-history policy the doc endorses; blanket-TR1 is not used. Recommendations recorded in the manager-review doc (TR1→keep cohort-history; service-tariff primary with per-code conflict review; hierarchy = items vs packages both handled; no median-of-room).
---

## 2026-07-22 — Tab-20 Pharmacy exact high-value item selection (source-mapped)

Doc T20: two capabilities — routine pharmacy from historical distributions (keep), + exact selection of high-value items with current price / custom item. Manager: exclude-then-add is complicated — **current show-high-contributing-items method is fine**; for selected items **flag + provide the rate WITH its source**, user can enter own amount, **historic P50 fallback with a flag**; **UOM dropdown** for manual high-value; curated selectable = high-value items; custom-item workflow Agreed; static map weak → use historical classification (Agreed); extend replace-don't-add to implants + reconcile totals (Agreed).

**§4 engine check:** replace-don't-add double-count guard already exists (P3 named-drug path: MRP×qty replaces cohort pharmacy via max()). Manager generalises to implants/devices — an extension.

**Built on `feat/pharmacy-selection` (not pushed):**
- `src/modules/engine/pharmacySelection.js buildPharmacySelections()` — additive `estimate.pharmacy_selections`, base unchanged. Source-mapped rate: user_entered → catalog sale_rate → catalog MRP → historic P50 (flagged) → pending_user_entry (prompt; never silent zero/excluded). UOM + bucket from fc.pharmacy_catalog_rate_reference / pharmacy_item_mapping. double_count=replace_family_baseline.
- schema: pharmacy_selections [{item_code?, name?, quantity?, user_amount?, uom?, source_date?}].

Verified: mesh → ₹15,061 (sale_rate); vaccine → ₹2,800 (mrp); custom → ₹140k (user); unknown → PENDING; baseline byte-identical. No regression — 24/0, 12/0.

Open: curated v_pharmacy_fc_selectable_items (active, materially-priced high-value only); current catalog prices for implants/devices/chemo (6,132/11,254 unpriced → P50 fallback meanwhile); reconcile cleaned bucket vs legacy net_pharmacy_amount; frontend UOM dropdown + selectable-item picker.

---

## 2026-07-22 — Tab-21 Non-package handling (validation + details, NO code change)

Doc T21: financial data strong; exact treatment / multi-treatment mappings over-confident. Manager firm "Agreed" only on **historical FC estimates are evidence not templates — never copy** (our engine already uses cohort history, not old FC estimates); everything else "need more info, sounds serious, need details to evaluate"; §4 validation "Okay".

**§4 contamination screen — REPRODUCED on our mart:** surgery codes spanning ≥5 departments (sentinel mis-map proxy): **RT0006 "100 MCI THERAPY DOSE" across 34 departments / 1,629 admissions** (exactly the doc's example), 20G Vitrectomy 25 depts, 23G Vitrectomy 20, 3D Angio 18, etc. **2,514 procedure admissions** flow through ≥5-dept codes (doc ~1,754 sentinel); open-bill procedure cohort 4,297 (doc 4,149). Contamination confirmed.

**Engine relevance:** our estimate cohorts are FAMILY-based + ≥15-case gated + governed-fallback, NOT raw surgery_cd → partly insulated; but the raw surgery-master feeding family selection can still pull contaminated cases. Recommend gating treatment-level cohorts on CLEANED mappings (exclude sentinel codes like RT0006) before treatment-level production; keep the strong financial data (services_json / cleaned_pharmacy_net / fc_actual_bucket_totals, NOT legacy service_net_amount=0); use reconstruction for composition, reported final for calibration — no blanket 10% uplift; never copy old FC estimates (already so).

**Decision: no engine change now** — N8 rebuild (clean surgery-master evidence, revalidate 756 multi-treatment, component-verify combos, governed medical master, hierarchical cohort fallback) HELD pending the manager's evaluation. Contamination evidence delivered for that evaluation.

---

## 2026-07-22 — Tab-22 Package handling (validation + confirmation, NO code change)

Doc T22: clinical names reliable; combos understated; clean package-rate source (v_package_rates_current) under-prices ~half. Manager: use the **service tariff dataset (actual current rates)**, not the halved GIPSA-JSON extract; **verify real combos first** then apply; FC-flag≠final **Agreed**; open_bill_amount≠package-plus-open **Agreed** (combos only when multiple treatments); package≠patient-estimate → **follow our finalized inclusion/exclusion rules, ratios as reference only**; immediate fixes "review and rectify"; decision-states "useful enrichment"; §4 validation "Sure do both".

**§4 confirmed — N7 does NOT affect our engine:** FC Builder reads package price from `fc.package_master`/`fc.v_package_runtime_lookup`, NOT the flagged `v_package_rates_current`. Live spot-check: ORT5510 TKR = ₹255,000 / ₹125,000 / ₹199,580 — **full commercial amounts**, not the halved ~₹79k. Under-pricing is an upstream project-3 artifact.

**Validation:** final/package ratios (our 17k) — Non-GIPSA 2.08× / GIPSA 2.41× / Cash 1.77× (doc 1.67/1.80/1.09; direction confirmed — package << final, higher for insurance; reference only). Immediate fixes are **project-3 artifacts NOT in our master**: GYN5013 absent; our delivery packages correctly classified (GYN5322 LSCS / GYN5324 Normal Delivery / GYN5109 Forceps — all GYN, not Medical); no SBI packages. Combo detection already exists in the engine (comboDetect.js / flow2.service.js).

**Decision: no engine change** — our package base is correct (full amounts), we follow the finalized inclusion/exclusion rules (ratios reference only), FC-flag-not-final and open-bill≠package-plus-open already respected, combo detection already present. The N7 clean-up / immediate fixes / 21.9% combo verification are project-3 data work, not our engine. Decision-states could be an optional past-IP enrichment.

---

## 2026-07-22 — Tab-23 Handling variants (validation + confirmation, NO code change)

Doc T23: variants as structured attributes on a canonical treatment (approach/scope/side/episode/implant), payer-dependent, never free-text or universal multipliers. Manager: never pool uni+bilateral **Agreed**; **laparoscopic handled like robotic** (approach-specific package or add-on) — validate before applying; FC-text not a benchmark (patients may ask robotic upfront); left/right pool only when commercially equal **Agreed**; laterality conflicts → require confirmation **Agreed**; variant table + backfill from billed/package codes (not surgery_master_names_jsonb) **Agreed**; unknown variant → scenarios not average "need more info"; §4 "Yes validate".

**§4 confirmed — engine already handles variants:** cohort.js keeps distinct families (conventional TKR unilateral vs bilateral; robotic uni-left/uni-right/bilateral) → uni+bi NEVER pooled; robotic priced as a payer-specific add-on (contracted → cohort → TR1-flagged); left/right pooled only within unilateral (commercially equal for TKR); no universal "lap = open +N%" multiplier (families are named cohorts).

**Validation:** robotic packages present (ORT5536 Robotic TKR Bilateral ₹690k / ORT5784 Uni-Left / ORT5535 Uni-Right ₹355k). **Laparoscopic hypothesis CONFIRMED** — 14 lap-specific packages (SGA5169 Lap Cholecystectomy ₹107,120; SGA5698/5699 Inguinal Hernia Lap Bi/Uni), themselves uni/bi-split → laparoscopic IS an approach-specific package (handle like robotic), resolved by package matching, not a multiplier. TKR packages: 14 unilateral / 6 bilateral (separate).

**Decision: no engine change** — uni/bi separate, robotic payer-specific, left/right within-uni, lap-specific packages all already supported. The canonical variant table + backfill (from billed/package codes) and per-family laterality/approach certification are future data work (Agreed, not built). Unknown-variant scenarios (conventional-vs-robotic side by side) is a presentation choice; engine already carries robotic scenarios.

---

## 2026-07-22 — Tab-24 Flow, package codes & doctor-input / AI boundary (validation + confirmation, NO code change)

Doc T24: package CODE (not name) is the anchor; AI interprets while governed rules decide. Manager: check effective-period exists; cross-payer history = context only **Agreed**; robotics don't auto-decide from prevalence (>90% → preselect+confirm) **Agreed**; AI never invents code/rate/PF/GST/other-payer-pkg **Agreed** (need more info on "infer laterality/robotic/implant as fact"); doctor code = assertion not truth **Agreed**; mismatch tiers block/confirm/inform "sounds right"; N9 governed AI optional-item suggestion layer **Agreed/aligned**; doctor-input contract "agreed on a call"; template consolidation "validate upside first".

**§4 confirmed — architecture already ours:** engine is code-first (production key tariff+package_code+org+room), robotic is a USER selection (cohort.js "payor/tariff/room are user inputs"), AI refuses rather than fabricating (familyResolve: "Never invent packages… return null"). The >90%-prevalence caution maps to our add-on inclusion heuristic (`services.js case_presence_rate > 90 → include`) — the suggest/confirm refinement would apply there.

**Effective-period validation (manager's ask):** `package_master` HAS `effective_from`/`effective_to` → package price can key on effective period; `service_tariff_rate_matrix` has NO effective-date columns → service-line rates cannot key on effective period (gap to flag if the hospital wants effective-dated service rates); `organization_tariff_mapping` none.

**Decision: no engine change now** — the flow + AI boundary are already implemented and endorsed. The approved refinements touch verified logic / need the product call: (a) >90% add-on → preselect-but-confirm (changes the default add-on set — verified-number-adjacent), (b) N9 governed AI optional-item suggestion layer (scoped expansion of AI scope), (c) doctor-input contract with source-span provenance + field-level override governance ("agreed on a call"). Scheduled for that call, not silently built. Effective-dated service rates flagged as a data gap.
