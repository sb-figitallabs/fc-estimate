# 20-Jul — Phase-2 master TODO (outer plan)

**Sources:** meetings `2026-07-20_10-04-48.mov` (13 min) + `2026-07-20_10-50-02.mov` (6 min); topic docs: `FC_PF_MULTI_TREATMENT_IMPLEMENTATION_SPEC.md`, `NME_inp.pdf`, `Emergency_Handling.pdf`, `+ve_cases_handling.pdf`, `Reyvant - General Doc 6 (6).docx` + `i21.md` (his validation of it); Due Mobilisation pack (`PRD_Due_Mobilisation_Tool_extended.md`, Brief Summary, Due_Mobilisation_Documentation/, refcdata/ CSVs).

**Manager's frame (meeting 1):** Estimate Builder is ~90%; what remains is edge cases + refinements, validated against his cleaned DB (~14k IP). **Mandated workflow (meeting 2):** he sends raw+Codex material per topic → OUR agent validates it against OUR data → we produce a **review file** → he cleans/approves it → only then we implement. Noisy inputs stay stored separately (future billing-audit value). **Standing risk rule (ours):** any suggestion that could WORSEN currently-verified logic gets flagged in the review file with a detailed question — never silently implemented.

---

## Workstream A — Estimate Builder edge-case topics (sequential, review-gated)

**⚠️ Blocking decisions consolidated for the manager:** `review-00-decisions-needed.md` (D1–D8) — one file, all the cross-cutting risk questions in one place so he can decide without hunting across four docs. Share this one FIRST.

Order: T1 → T2 → T3 → T4 (T1 is the biggest and most intertwined with current logic).

- [ ] **T1 — PF + Multi-treatment + Extended stay** (spec: `FC_PF_MULTI_TREATMENT_IMPLEMENTATION_SPEC.md` + Gen Doc 6 + i21)
  - [x] Review file drafted → `review-01-pf-multitreatment.md` (share with manager)
  - [ ] His approval of the review file (incl. the LAN-vs-final-insurance question and rule-table location)
  - [ ] Detailed implementation todo → implement → verify vs history → deploy dev
- [ ] **T2 — NME estimator** (hybrid rules + historical profiles; `NME_inp.pdf`)
  - [x] Review file drafted → `review-02-nme.md`
  - [ ] His approval → detailed todo → implement (Phase-1 profile estimator first) → verify → deploy
- [ ] **T3 — Emergency handling overlay** (`Emergency_Handling.pdf`)
  - [x] Review file drafted → `review-03-emergency.md`
  - [ ] His approval → detailed todo → implement (decision workflow + components) → verify → deploy
- [ ] **T4 — Positive-case billing rule layer** (`+ve_cases_handling.pdf`)
  - [x] Review file drafted → `review-04-positive-cases.md`
  - [ ] His approval (incl. the blocked items his own doc lists) → detailed todo → implement → verify → deploy

**Later Workstream-A items from meeting 1 (no docs yet — wait for his inputs per item):** newborn handling · insurance policy application (last) · cross-consultation UX · user-added investigations/item codes · LOS override guardrails · fallback handling · UI/UX manual refinement · IP-count match vs his 14k (ours: 14,202 — verify same cleaning) · "insurance logic reflects what the doctor writes" (needs his FC data drop).

## Workstream B — Due Mobilisation tool (PARALLEL, separate worktree)

New product in Hospital_OS: daily HIMS/insurance/FC report uploads → consolidated admitted-patient ledger → financial exposure → actionable worklists (collect ₹X / raise enhancement ₹X / resolve query / escalate). Cash goal: ~80% of expected cost collected across LOS, deposit never behind running bill. Insurance: running bill vs pre-auth, enhancement tasks.

- [ ] **B0 — worktree setup**: separate git worktree off Hospital_OS (feature branch `feat/due-mobilisation`), untouched main line.
- [ ] **B1 — our own PRD** (his instruction: write ours; his two PRD versions + product context + data mapping are vetted reference): ingest model for the 13 refcdata CSV report types, ledger schema, exposure calc, task engine, roles.
- [ ] **B2 — ingestion**: Excel/CSV upload → Hospital_OS DB (idempotent daily snapshots), mapping per `03_Data_Mapping.md`.
- [ ] **B3 — views**: 2–3 Hospital_OS screens (upload + worklist + patient ledger drill).
- [ ] **B4 — dashboard**: status tiles on Praful's dashboard.
- [ ] **B5 — handover doc** for Gautam (user-level refinements move to him after one-shot).

## Standing process
- Every topic's noisy raw inputs archived under `knowledge_inputs/` (searchable by the agent; never auto-implemented).
- Chronicle updated per topic implementation; ping manager on every logic push; EOD notes.

## Asks currently open with the manager (phase-2 specific)
1. Review-file sign-offs T1–T4 (the four documents above).
2. T1: which PF surface governs the FC estimate — LAN (25%) vs final-insurance (35% configurable)? And where do the rule tables live for OUR runtime (his `fc_curated`/`fc_clean` schemas are in HIS local project DB)?
3. His per-item drops promised in meeting 1: refined PF logic (checking with Gautam), doctor-fee logic from tariff data, newborn logic, positive/negative-NME case logic, FC data (Dec-24→) after cleaning.
4. Due Mob: confirm which PRD version is the better reference; ChatGPT chat link if shareable.
