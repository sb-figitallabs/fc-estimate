# 15-Jul plan — from the morning call + the flow document

Sources: call recording/transcript (i18) + the 5-page flow note. Every factual
claim in the note was checked against the dev database before writing this.

## Fact-check of the document (what held up)

| Claim | Verdict |
|---|---|
| "Robotic TKR exists but not a single GIPSA case inside it" | **Correct** — robotic TKR right/left/bilateral are Cash-only (26/31/65); plain TKR unilateral has GIPSA 248 / Non-GIPSA 376. GIPSA + robotic must go: unilateral cohort + robotic add-on. |
| "Same package code with different names = one package; code defines identity" | **Correct** — e.g. URO5011 appears as "URSL + DJ STENTING - G I", "…AND DJ STENTING - PA" etc. across tariffs. |
| Robotic ≥90% presence ⇒ robotic surgery, else add-on | **Already implemented** — the engine's threshold is exactly 90%, with the add-on + one-click redirect suggestion live since 13-Jul. |
| Package master keyed by payer→tariff is THE package-existence source | **Correct & already how the new gate works.** |
| "Very rare to have no FC historic match" | Plausible — the 20-admission-note test found a family for 17/19. |
| Minor | "p50, p35, p25" is a typo for P75; the "FC historic + family cohort" step he didn't follow is our gate's step 4/5 — his real critique (payor-blind family pick) is fair, see §2. |

## Already done from his document (tell him — most of Phase 1 exists)

- [x] Package-first gate: payor → payor group → tariff → package master → details (room-wise tariff + incl/excl) → route — the Flow view he reviewed
- [x] "No similar treatment found" said plainly when history has nothing
- [x] Bucket + gross P25/50/75 excl. F&B, pharmacy returns deducted (the mart total)
- [x] Package-bill gross quartiles from actual converted bills (the actuals band on estimates)
- [x] Robotic 90% rule + add-on + payor-driven redirect suggestion in the workbench
- [x] Package ingestion against IP numbers + P25/50/75 (confirmed on the call)
- [x] Surgical/Medical + Daycare/Inpatient cohort narrowing controls (explicit options show per-cohort case counts)
- [x] FC Q&A ("later stage" in his note) — Ask AI already live on all three pages, DB-backed

## TODO (his asks, ordered)

- [x] **1. Payor-aware FC-historic matching** — DONE 15-Jul: matches carry per-payor case counts; zero-case matches never win; robotic families with no payor history fall back to base family + robotic add-on (verified live: GIPSA + Robotic TKR → TKR Unilateral, 248 GIPSA cases, "+ robotic add-on"). One shared brain (`familyResolve.js`) drives the gate, the resolver AND the builder.
- [x] **2. His exact fallback ladder** — DONE 15-Jul: the gate returns `fallback_ladder` (package: pkg-with-payor → family-with-payor → strong-match-without → no match; non-package: 4-rung variant) with the used rung; the Flow view renders it highlighted.
- [x] **3. Package-code-first matching** — DONE 15-Jul: billed actuals match every name sharing the package CODE (same code = one package); candidates dedupe by code.
- [x] **4. Gate drives the actual estimate build** — DONE 15-Jul: intake wording / AI-match text persists as `treatment_text` on the build request → package selection goes through the gate brain (`package_offer.source: gate_match`), cohort-dominant only as fallback; resolve-treatment also returns the gate's `package_hint`.
- [x] **5. Clarifying questions on ambiguity** — DONE 15-Jul eve (HO `37700e5`): mandatory inline prompt when a family is seen as both daycare/non-daycare or surgical/medical; the answer locks the cohort before build.
- [x] **6. Package-bill quartile set** — DONE 15-Jul eve: `billed_actuals.this_tariff` now carries three sets — gross final bill, the package amount itself (`package_amount`), and what rode on top (`exclusions_over_package`) — per package, combo bills excluded.
- [x] **7. Auto-verification harness** — DONE + first run complete
  (`verification-report-15jul.md`): 207 zero-input builds (Cash ×170 +
  GIPSA where ≥15 cases), 0 crashes, 25 fully in-band, 182 with
  out-of-range components clustering into 5 systematic causes — headline:
  GIPSA PF priced at token ~₹740 (34 rows), token ₹0/₹1 OT on medical
  families (54), Investigations ₹0 on medical families (31), infusion
  Pharmacy ₹0 (6). Re-run:
  `gh workflow run maintenance.yml --ref dev -f script=verify-estimates.js`.
- [x] **8. Conversion alert** — DONE: engine flags converted with-package
  totals outside the actual billed band (≥5 cases, 75%/125%) via
  `package_offer.conversion_check` + an estimate warning. Fired correctly on
  its first run: GIPSA TKR ₹1.84L vs ₹2.61–3.85L (his exact demo number),
  Lap Chole ₹50.9k vs ₹1.16–1.80L, LSCS ₹39.6k vs ₹93k–1.05L.
- [x] **9. Robotic variance report** — DONE. 12 families show robotic
  presence. Robotic families sit at 95–100% across ALL payors (the 90% rule
  holds at any level for them); THR is a consistent ~37–42% add-on
  everywhere. **But the classification must run PER PAYOR GROUP**: the
  conventional cohorts diverge — TKR Bilateral (Conventional) is 0% robotic
  for Cash but **61% GIPSA / 69% Non-GIPSA**, and TKR Unilateral
  (Conventional) 0/0/23% — because robotic families are Cash-only curations,
  so insurer robotic cases live INSIDE the conventional cohorts. Overall-
  level classification would call these non-robotic and underquote insurer
  robotic cases. Full table:

  | family | cash | gipsa | non-gipsa |
  |---|---|---|---|
  | Robotic TKR Uni R / L | 100% | 100% | 100% |
  | Robotic TKR Bilateral | 95% | 95% | 95% |
  | THR / Hemiarthroplasty | 39% | 42% | 37% |
  | TKR Bilateral (Conventional) | 0% | **61%** | **69%** |
  | TKR Unilateral (Conventional) | 0% | 0% | **23%** |
  | Ventral / Inguinal Hernia, Hysterectomy, others | 0–7% | 2–4% | 0–6% |
- [ ] **10. Multi-treatment combo detection** — at intake, tell whether it's Pkg+Pkg or Pkg+NonPkg combo (detection first; pricing later — still the parked multi-procedure work).
- [ ] **11. Deploy to production by EOD** — engine dev→main, HO feature→dev→main, after the 12:00 review.
- [x] **12. Feedback dock** — DONE 15-Jul: orange tab below Ask AI on all three pages; message + page context + optional screenshot stored in the new `fc_feedback` table (migration 088, applied to Neon dev) with status timeline; reading/resolving the queue is admin-only.

## Extras from the 11:53 review (General Doc 6 + call)

Where we already stand: his robotic-TKR finding ("should have chosen conventional
TKR Unilateral + robotic add-on, not the robotic family") was **fixed this
morning before the doc landed** — verified live. The "Feedback to AI" ask is
**built** (task #12 above) — message + screenshot + page JSON stored per concern.
"Up till step three it's perfect" — the gate chain itself is approved.

- [x] **13. Open-vs-package inversion — ROOT-CAUSED + fixed** (15-Jul eve):
  the billed table stores multi-package admissions as ONE row with
  concatenated names ("CAG - CAT - 1,PTCA…" P50 ₹2.97L) — these inflated
  single-package bands. Single-package actuals now exclude combo rows;
  related history keeps them flagged "multi-package bill". The residual
  TKR-GIPSA gap is REAL data: ~₹1.24L of billed exclusions (implants) ride
  on top of ₹2.38L inclusions (final P50 ₹3.62L) — for the manager: the
  package price ≠ the package bill; the verification harness (#7/#8) is
  where out-of-band bills get flagged, not smoothed.
- [x] **14. Preview range bracket rule** — DONE: the actuals band is used
  only when it CONTAINS the quoted figure; otherwise the synthetic capped
  range returns. No more ₹1.84L→₹2.16–3.85L jumps.
- [x] **15. FC-history labelling** — DONE: captioned "Actual FINAL package
  bills (package + billed exclusions, excl. F&B) — not the package price,
  not this estimate's total".
- [x] **16. ₹0 package rows** — DONE: struck-through itemized amount +
  "in package" tag (display only; totals/edits untouched).
- [x] **17. Cash-tariff note clickable** — DONE: expands to the exact item
  list (name, bucket, cash rate used).
- [x] **18. NME derivation — traced + documented** (`nme-derivation.md`):
  NME is a hardcoded 7-item name regex (drug admin, medical records, ward
  consumables, dressing, diet consultation, MLC, warmer — the "KIMS NME
  list"), NOT data-driven; gloves/kits/pharmacy consumables are currently
  treated as insurer-payable; the historical `nme_amount` column we ingested
  is loaded but unused; drug-admin (12.5% of pharmacy) is itself one of the
  7. Flag to the manager — likely needs a real NME master or the billed
  nme_amount wired in.
- [x] **19. (Daksh) FC Scribe ↔ Estimate Builder joining** — DONE 15-Jul:
  counselling (not re-counselling) session starts recording → 5-4-3 countdown
  overlay ("Go now" / "Stay on FC Scribe") → Estimate Builder opens with
  patient name/age/gender/UHID prefilled; the app-global recorder keeps the
  session recording through the redirect; the estimate preview shows a
  live-recording banner linking back to /fc-scribe/sessions/:id to stop the
  session and review the report.
- [ ] **21. Harness follow-ups (from verification-report-15jul.md)** — the
  ranked fix list the first run produced: (a) GIPSA Professional Fees priced
  at token ~₹740 — one rule, 34 rows, the biggest insurer-path money error;
  (b) token ₹0/₹1 OT rows on medical families (54 rows) — policy call:
  TR1-fallback or accept+annotate; (c) Investigations ₹0 on medical families
  (31 rows) — needs a historical residual; (d) infusion Pharmacy ₹0
  (Immunotherapy/Chemo, 6 rows); (e) Hemodialysis/Newborn room-charge
  cohort quirks. Re-run the harness after each fix to prove it.
- [x] **20. (Daksh) Sessions-with-estimates in the public API** — DONE 15-Jul
  eve (HO `6ffacad`): `GET /api/public/fc-summary` — total FC sessions +
  per-staff {estimates_created, sessions_recorded, sessions_with_estimates};
  filters `?date | ?from&to | ?range=today|yesterday|last7|last30` (same IST
  semantics as daily-summary); bare call → most recent day with FC activity.

## From the 17:58 review call (bugs he demoed + new asks)

- [x] **22. AI matching must be deterministic** — DONE 15-Jul eve: root cause
  was `geminiJson()` sending no `temperature` (Gemini default 1.0). Fixed:
  `temperature: 0` on all flow-path JSON calls, and the engine moved to
  **gemini-3.1-pro-preview** (code defaults + .env). Verified live with his
  exact demo input — "Spine help for discectomy" returns the identical
  family list on repeated runs. NOTE: the EC2 deploy env still has
  GEMINI_MODEL=gemini-2.5-flash — update it when deploying (#11/#29).
- [x] **23. Send him the flow AI prompts + input format** — he wants to refine
  them himself ("prompt de do, input batao kaise jata hai, main refine karta
  hu"). Doc prepared: `todo_and_helpers/ai-prompts-15jul.md`.
- [x] **24. Show the package code in the UI** — DONE 15-Jul night: PkgCode chip on every package display (offer banner, review box, bucket row, preview table, FC-history caption, related rows, provenance); engine gate/lookup responses carry package_code.
  Original ask: — package matches display name
  only (his NES5011/NES 5281 check needed the DB); show `[code] name` on the
  Flow view, package offer and historic panels — code, not name, is package
  identity.
- [x] **25. Robotic visibility in the UI** — DONE 15-Jul night: RoboticBadge on workbench + preview (included / add-on available with per-payor presence % / absent). Also fixed dead code: the sub-90% convert prompt checked selection==='auto' but the engine sends '' — it never rendered before.
  Original ask: — "how do I even tell if robotic is
  included? it's shown nowhere". Surface the robotic state (included /
  add-on available / not applicable) + presence % on the estimate & Flow
  views without needing a trigger.
- [x] **26. Drop Procedure from stage 1 (Simple flow)** — DONE 15-Jul night (HO e26c2ed): stage 1 = note wording + patient; payor next; then payor-aware resolution (family + payor cases + payor_note + [CODE] package hint) confirmed by the FC; stay/LOS derive only from the resolved cohort; payer change re-resolves.
  Original ask: — stage 1 currently
  forces a pick from ~170 families BEFORE payer context, and LOS/stay derive
  from that too-early pick; changing payer later doesn't re-derive it. His
  ask: stage 1 captures ONLY admission-note text + payer; the payor-aware
  gate resolves the procedure at the next stage (both inputs first, then the
  flow decides — matches the flow doc philosophy).
- [x] **27. Robotic add-on charges missing from the built estimate** — DONE 15-Jul night: robotic rows now render as line items; gate robotic_addon flag threaded (clinical.robotic_addon); pricing tariff_contracted→cohort_history→tr1_fallback; never clause-swallowed. GIPSA Robotic TKR: ₹3.12L→₹4.32L with contracted OTI0098 ₹1,20,000; parity 1042/1042.
  Original ask: — GIPSA +
  Robotic TKR: gate correctly resolved base TKR + robotic add-on, but the
  estimate applied NO robotic charge anywhere (implants present, add-on
  absent; ₹6.11L total). GIPSA tariff carries a contracted "CHARGES FOR
  ROBOTIC TKR" ₹1,20,000 under Other Services — the add-on must price from
  the payor's contracted rate, and default per the per-payor 90%/flag rule
  (#9), not stay invisible.
- [x] **28. DB-level robotic classification** — DONE 15-Jul night: migration 001 + backfill RUN on dev: 680 family×payor rows (15 robotic-capable families), 1145 packages (905 capable), 16048 admissions (911 billed robotic, ₹20.5Cr), 74 contracted (tariff,item) rates. #9 parity table reproduced (0/61/69, 0/0/23). Note: robotic families show 0% for insurers because those cohorts have zero insurer cases — read with cohort_cases.
  Original ask: — persist per package/surgery
  whether a robotic add-on exists (and the contracted rate), and per IP
  admission whether robotic was actually billed. He is sending a review doc
  from his side; align with it.
- [ ] **29. Deploy prep (with #11)** — push current state to prod so feedback
  dock etc. reaches users; Flow view stays HIDDEN for normal users
  (admin-only); after deploy, revisit the robotic documentation gaps (#27/#28).

## Explicitly paused / replaced by him

- Packages-Excel override ETL (the 9 questions) — **paused**; replaced by #7/#8:
  `fc.package_bill_lines` is the single source of truth to verify historical
  bills (base package + multi-package + extras + exclusions → gross).

## Reading of priorities

#1–#4 are one body of work (the matching layer) and unblock his "half the
battle" milestone; #7+#8 are the verification harness he wants before trusting
prod; #11 is the hard deadline. #5, #6, #9, #10 can follow the deploy.
