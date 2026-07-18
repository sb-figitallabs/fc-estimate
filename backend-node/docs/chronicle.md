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
