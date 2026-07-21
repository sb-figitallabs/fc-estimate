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

- [x] **B0 — worktree setup** ✅ `feat/due-mobilisation` off origin/main, isolated from the estimate line.
- [x] **B1 — our own PRD** ✅ `Hospital_OS-due-mob/docs/due-mobilisation-prd.md` (grounded in the real refcdata report shapes).
- [x] **B2 — ingestion** ✅ (`e8495b7`) migration 098 + header-signature schema detection + merge-by-UMR/IP snapshot commit; verified on real bundle (75 patients).
- [x] **B3 — exposure/task engine** ✅ (`939880e`) cash 80%/phased + insurance util/enhancement/deposit + query, dedupe/escalate/auto-close; verified (19 cash tasks).
- [x] **B4 — UI screens** ✅ (`488511a`) worklist + daily upload + patient ledger + 5 summary tiles; route + sidebar; typecheck clean.
- [ ] **B5 — dashboard tiles** on Praful's dashboard (the summary tiles component is ready to embed).
- [ ] **B6 — handover doc** for Gautam (user-level refinements move to him after the one-shot).
- [ ] **B7 (open questions to manager, from the PRD):** which PRD version is canonical · staff-mapping source · is the report's FC-estimate our builder's figure · business-date authority · ChatGPT chat link.

## Workstream C — standalone data ingests (no review gate; unblocked)

- [x] **C1 — Neonatal cash packages (i22, 20-Jul)** ✅ **done 20-Jul** (engine `9c8d4b1`): 4 packages ingested into `fc.package_master` + `package_room_rates` + `package_organization_applicability` (TR1/cash), enriching the clinical `surgery_master` codes. Verified live: "well baby 2 days"→PAE5049 ₹18k, "phototherapy double surface"→PAE5061 ₹23k, "photo therapy newborn jaundice"→PAE5055 ₹22k as top gate candidates. **Open: confirm the neonatologist/paediatrician PF role label with manager before assigning a doctor.** Original scope — add 4 packages to the engine's FINANCIAL package layer (rate + inclusion + exclusion + documentation + runtime), enriching the existing clinical-master codes, NOT duplicating them:
  - `PAE5048` Postnatal Well Baby – 1 Day ₹11,000 (MOTHER_BED; PF ₹5,000; pharmacy ≤₹2,500; TCB, lactation, med-records; eff 17-Jun-2026)
  - `PAE5049` Postnatal Well Baby – 2 Days ₹18,000 (MOTHER_BED; PF ₹7,500; +blood group/Rh, OAE; eff 17-Jun-2026)
  - `PAE5055` Phototherapy – Per Day ₹22,000 (WARD; PF ₹5,000; CBP/TCB/retic; single-surface; ward consumables; eff 17-Jun-2026)
  - `PAE5061` Phototherapy Double Surface – Per Day ₹23,000 (WARD; same as 5055 + double-surface; explicitly excludes HIV/HBsAg/HCV kit; eff 18-May-2026)
  - Normalization: "Surgeon Charges" → `professional_fee` (label = neonatologist/paediatrician, **confirm role with manager before assigning doctor**); blank room-cat → MOTHER_BED (5048/49) / WARD (5055/61); Cash, tariff TR1; beyond package days → actuals; register + fingerprint the source doc.
  - Builder impact (per i22): healthy baby 1d→PAE5048, 2d→PAE5049; phototherapy single→PAE5055×days, double→PAE5061×days; NICU stays a separate flow (these don't cover NICU); phototherapy during a well-baby package = separate package (excluded from well-baby). Feeds the pending **newborn handling** item in Workstream A.
  - Source: `~/Downloads/Neonates Phsio Package Detailed pdf June 26 (1).parse.md`; spec: `knowledge_inputs/i22.md`.

## Standing process
- Every topic's noisy raw inputs archived under `knowledge_inputs/` (searchable by the agent; never auto-implemented).
- Chronicle updated per topic implementation; ping manager on every logic push; EOD notes.

## Asks currently open with the manager (phase-2 specific)
1. Review-file sign-offs T1–T4 (the four documents above).
2. T1: which PF surface governs the FC estimate — LAN (25%) vs final-insurance (35% configurable)? And where do the rule tables live for OUR runtime (his `fc_curated`/`fc_clean` schemas are in HIS local project DB)?
3. His per-item drops promised in meeting 1: refined PF logic (checking with Gautam), doctor-fee logic from tariff data, newborn logic, positive/negative-NME case logic, FC data (Dec-24→) after cleaning.
4. Due Mob: confirm which PRD version is the better reference; ChatGPT chat link if shareable.
