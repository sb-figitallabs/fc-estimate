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

- [ ] **1. Payor-aware FC-historic matching in the gate + builder** — the robotic example: family/template selection must prefer matches that HAVE cases for the payor group; high-confidence-or-nothing (never low-confidence); multiple high-confidence → specificity first, then case count for that payor group.
- [ ] **2. His exact fallback ladder** — package treatment: pkg-with-payor → non-pkg-with-payor → any strong match without payor → "no match in FC historic dataset". Non-package: non-pkg-with-payor → non-pkg-without → pkg-with → pkg-without → no match. Surface which rung was used.
- [ ] **3. Package-code-first matching + code-level dedupe** — match FC history by package CODE before name; treat same-code-different-names as one package everywhere (gate, offers, actuals).
- [ ] **4. Wire the gate into the actual estimate build** — package/non-package categorization should drive template selection in the build flow, not just the admin Flow view.
- [ ] **5. Clarifying questions on ambiguity** — treatment seen historically as both surgical/medical or daycare/non-daycare ⇒ ask the user, then build ONLY from that cohort.
- [ ] **6. Package-bill quartile set** — P25/50/75 for the excluded buckets, the package amount itself, and gross, per package (we have gross; excluded-bucket + package-amount sets are new).
- [ ] **7. Auto-verification report (the "AI checking" replacing manual checks)** — for every treatment: build the estimate with zero manual input, compare gross + each bucket against historic P25–P75 at BOTH open-bill and package-bill level; flag out-of-range rows into a report showing exactly where to look.
- [ ] **8. Conversion alert** — when the open→package conversion (via incl/excl) lands far from the actual-bill P50 / outside P25–P75, raise "check the inclusion/exclusion for this package".
- [ ] **9. Robotic variance report** — presence rate per treatment at overall vs Cash/GIPSA/Non-GIPSA level, to decide which level the 90% classification runs at.
- [ ] **10. Multi-treatment combo detection** — at intake, tell whether it's Pkg+Pkg or Pkg+NonPkg combo (detection first; pricing later — still the parked multi-procedure work).
- [ ] **11. Deploy to production by EOD** — engine dev→main, HO feature→dev→main, after the 12:00 review.

## Explicitly paused / replaced by him

- Packages-Excel override ETL (the 9 questions) — **paused**; replaced by #7/#8:
  `fc.package_bill_lines` is the single source of truth to verify historical
  bills (base package + multi-package + extras + exclusions → gross).

## Reading of priorities

#1–#4 are one body of work (the matching layer) and unblock his "half the
battle" milestone; #7+#8 are the verification harness he wants before trusting
prod; #11 is the hard deadline. #5, #6, #9, #10 can follow the deploy.
