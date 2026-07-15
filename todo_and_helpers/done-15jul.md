# 15-Jul — completed

All items below are **live on production** — engine dev→main deployed
(https://fc-estimate.figitallabs.com) and Hospital_OS feature→dev→main
deployed, both verified green. The engine now runs **Gemini 3.1 Pro at
temperature 0** (EC2 envs updated on both stacks).

## The matching layer (his flow doc, #1–#4 — "half the battle")
- [x] **Payor-aware FC-historic matching**: matches carry per-payor case counts; zero-case matches never win; robotic families with no payor history fall back to base family + robotic add-on. One shared brain (`familyResolve.js`) drives the gate, the resolver AND the builder
- [x] **His exact fallback ladder** returned by the gate (package: pkg-with-payor → family-with-payor → strong-match-without → no match; non-package 4-rung variant), rendered highlighted in the Flow view
- [x] **Package-code-first matching**: billed actuals match every name sharing the package CODE (same code = one package); candidates dedupe by code
- [x] **Gate drives the actual estimate build**: intake wording persists as `treatment_text` → package selection goes through the gate brain; cohort-dominant only as fallback

## Morning-call answers (Q1–Q7)
- [x] Q1: insurer PF priced from the cohort's historic P50
- [x] Q2: token ₹0/₹1 item list produced for his call (`token-rate-items-15jul.md` — 10 items with what they actually billed on insurer bills)
- [x] Q3: historical backfill for empty Investigations/Pharmacy on medical families
- [x] Q4: session-based room-charge suppression (dialysis, newborn care — priced per session, no LOS × ward rate)
- [x] Q5: FCs enter NME manually (interim, until the NME master decision)
- [x] Q6: robotic classification per payor group; sub-90% high presence → FC prompt, not silent inclusion
- [x] Q7: daycare/inpatient + surgical/medical ambiguity — answer is mandatory before build

## Verification harness (#7/#8)
- [x] 207 zero-input builds (Cash ×170 + GIPSA ≥15 cases), 0 crashes; out-of-band components clustered into 5 systematic causes (`verification-report-15jul.md`)
- [x] Conversion alert: converted with-package totals outside the actual billed band flagged on the estimate — fired on his exact GIPSA TKR demo number
- [x] Open-vs-package inversion root-caused: combo bills (concatenated package names) excluded from single-package bands
- [x] Preview range bracket rule, FC-history relabelling, ₹0 package rows struck through, cash-tariff note clickable (#14–#17)

## Evening review call (17:58) — all six findings closed same night
- [x] **Deterministic AI (#22)**: root cause = no temperature on Gemini calls (default 1.0). Now temperature 0 + **gemini-3.1-pro-preview** everywhere in the flow; his "Spine help for discectomy" demo input verified to resolve identically on repeated runs
- [x] **Flow AI prompts doc (#23)**: `ai-prompts-15jul.md` — all 3 prompts verbatim + input formats + post-call guardrails + flow diagram, ready for his refinement
- [x] **Package code in the UI (#24)**: `[CODE]` chip at every package display (offer banner, review box, bucket row, preview table, FC-history caption, related history, provenance)
- [x] **Robotic visibility (#25)**: status badge on workbench + preview — included / add-on available with per-payor presence % / absent. Found & fixed dead code: the sub-90% "convert to robotic?" prompt never rendered (checked `'auto'`, engine sends `''`)
- [x] **Procedure out of stage 1 (#26)**: Simple flow stage 1 = admission-note wording + patient; payor next; procedure resolved payor-aware from BOTH inputs, FC confirms; payer change re-resolves; stay/LOS derive only from the resolved cohort
- [x] **Robotic add-on charges (#27)**: the built estimate now includes the robotic add-on — priced from the payor tariff's contracted item (GIPSA TKR: OTI0098 ₹1,20,000; his demo went ₹3.12L → ₹4.32L itemized), fallback to cohort history; never swallowed by package inclusion clauses; cash parity suite 1042/1042
- [x] **DB robotic classification (#28)**: 4 new `fc.robotic_*` tables + idempotent backfill, RUN on the DB — 680 family×payor rows (15 robotic-capable families), 1,145 packages (905 capable), 16,048 admissions classified (911 billed robotic, ₹20.5Cr), 74 contracted rates across 14 tariffs; his per-payor table reproduced (0/61/69, 0/0/23)

## FC Scribe ↔ Estimate Builder (Daksh items)
- [x] Counselling session → 5-4-3 countdown → Estimate Builder opens prefilled; recording continues through the redirect; preview shows a live-recording banner linking back to stop/review
- [x] Estimate ↔ scribe-session link persisted with auto-reopen
- [x] **Public API for the dashboard (#20)**: `GET /api/public/fc-summary` — total FC sessions + per-staff {estimates created, sessions recorded, sessions with estimates}; filters ?date / ?from&to / ?range=today|yesterday|last7|last30 like daily-summary
- [x] **UHID → UMR** in every user-facing label (FC Scribe + the whole estimate flow: search bars, saved/deleted pages, exports, overlays)

## Feedback loop
- [x] Feedback dock on all three builder pages — message + page context + optional screenshot to `fc_feedback` (migration renumbered 088→095 for the dev merge); admin Feedbacks queue with status timeline
- [x] TPA dropdown from the master list; manual NME entry field

## Deploys
- [x] Engine: dev → main, GitHub Actions deploy green, prod health verified; `GEMINI_MODEL=gemini-3.1-pro-preview` set in both EC2 stack envs
- [x] Hospital_OS: feature → origin → dev (deploy green, 5m46s) → main; CI ran migrations before traffic swap
- [x] RDS security group updated for the new office IP; robotic backfill executed against the live DB

## Parked / waiting
- [ ] Multi-treatment combo detection (#10) — Pkg+Pkg vs Pkg+NonPkg at intake
- [ ] Token ₹0/₹1 items — awaiting his per-item call on `token-rate-items-15jul.md` (data says it's not one rule: MONITOR/TRANSFUSION bill ~cash, DMO/NURSING really bill ₹1)
- [ ] NME final design — after he sits with the hospital FC staff (manual entry live meanwhile)
- [ ] Package-tariff sync audit — DB vs package billing data vs Excel per tariff code/room type
- [ ] Harness re-run to prove the Q1–Q4 fixes shrank the 182 out-of-band builds
