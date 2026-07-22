# 17-Jul evening — meetings summary, TODO & asks

**Sources:** meeting recordings `2026-07-17 15-48-17.mov` (15 min) + `2026-07-17 17-21-05.mov` (7 min), `17_july_inp.pdf` (data spec after his 3–4 hr hospital sitting with Billur & Satya), `17_jul_feedbacks.pdf` (4 annotated screen feedbacks).

**Deadline signal:** manager asked for wrap-up of these items in **2–4 days**. Vetting order after that: manager → Satya → 3–4 more people over 2 days. He also asked to be **pinged on every model/logic push** so he can review.

---

## Executive summary

1. **Package layer gets re-grounded in the hospital's own masters.** Package LOS must come from the **package master** (`PKGDURATION` — 0 = daycare — plus `PREDAYS`/`POSTDAYS`; do NOT use pre/post-days for LOS). Package tariff per room category must come from the **Service-All tariff** already in our DB (per tariff code + package code + room), **not** from MOU. Inclusions/exclusions: Cash & non-GIPSA from MOU (already extracted), GIPSA arriving from Billur/Satya as Excel; plus a new **common-exclusions sheet** (e.g. cross-consultation) that applies to every package even when not written at package level.
2. **Matching becomes transparent and user-controllable.** For every package candidate the gate shows, display **match / no-match per option with the reason** (TKR right → "TKR-RIGHT" match, "ROBOTIC TKR UNILATERAL" match *because user chose robotic*, "Revision TKR" match, but BILATERAL options are NOT matches). When several same-surgery-different-commercials packages exist (THR 1/2/3, Revision TKR 8/9/10), the AI picks best but the **user must be able to switch** the package. Also: after the robotic follow-up question, the system should offer the robotic package (or robotic add-on) — today it stays on conventional.
3. **New "clinical vs commercial" split view.** Clinical part = treatment identification, LOS + breakdown, OT/cath-lab hours, surgical/medical, daycare, emergency, robotic, service-wise amounts, pharmacy bucket breakdown (IP drugs/day, IP consumables/day, OT drugs, OT consumables, implants), investigations, bedside, cross-consults — i.e. the IP-approximate-bill level with **no package/PF confusion**. Commercial part = payor-tariff mapping, packages + combos, inclusion/exclusion, GIPSA business rules, PF. He wants a flow diagram of the two parts too.
4. **Totals:** wherever we show the IP-approximate gross, also show the **package-bill gross total** next to it (his flow-2 screenshot: ₹4,88,933 approx vs ₹2,86,294 package — both must be visible at estimate level too).
5. **PF from logic, not absolutes;** cross-consultations (diet etc.) handled separately from the operating surgeon's PF.
6. **LOS sanity:** conventional TKR flow-2 showed LOS 5 (p50 of 4–5) — he believes 3 is right and suspects we take the larger value; robotic TKR already shows 3 correctly. Verify the cohort LOS pick logic (p50 vs max) and, for packages, prefer package-master duration.
7. **Audit/visibility everywhere:** he wants clear source labels (their HIMS data vs our derived data) for surgery naming, open billing, GIPSA/non-GIPSA/cash tagging — and an **AI-feedback button** on the admin/test portal (FC Estimate, Flow 2, Flow 3) that captures the exact inputs so any bad AI answer can be recreated.
8. **Data refresh:** updated **GIPSA + MOU sheet** supersedes the old one; a new dataset (IP numbers earlier than our 2024-start) is coming to backfill history; PF and package amounts are confirmed present in the tariff dataset.

---

> **Status 18-Jul (evening):** all unblocked items DONE and deployed to engine `dev` + HO `feat/estimate-builder-v3`.
> ✅ A1 package LOS from master (engine `1250c28` — TR1 TKR duration = 3, matching his expected LOS; provenance in `drivers.los_source`) · ✅ A2 Service-All matrix authoritative per-room package price (`d07e81a`) · ✅ A5 core (incl/excl exceptions await sheets) · ✅ B1 per-candidate match verdicts w/ laterality reasons (`a623a74`+`d550baa`) · ✅ B2 pick-any-package in flow-2 + dock chips · ✅ B3 robotic answer re-biases gate/build/flow-2 · ✅ C1 Clinical/Commercial split strip · ✅ C2 dual grosses side by side · ✅ C3 diagram (`clinical-commercial-flow.md`) · ✅ D1 LOS audit (root cause: p50 over CEILED billable stays + tiny robotic subset) · ✅ D3 cross-consult PF separated from surgeon PF (`5e42196`) · ✅ E1 flow-2/3 feedback with exact recreation bundle · ✅ E2 HIMS-vs-derived source legend.
> Still blocked on his files: A3 (GIPSA/common-exclusion sheets), A4 (updated GIPSA+MOU + pre-2024 data), D2/D6 (PF doc), D4/D5 partials.
>
> **18-Jul feedbacks (section F below):** ✅ F1 placeholder pricing fixed + verified (URO5443 hint ₹10 → ₹70,000; quote unblocked) · ✅ F3 answered — yes, package LOS comes from the pkg master since today · ✅ F4 Audit view shipped on the workbench · ⏭ F2 GIPSA reclassification is next (unblocked, in progress).

## TODO (deduped across all four sources)

### A — Package layer re-grounding (P1)
- [x] Package LOS from package master `PKGDURATION` (0 = daycare), expose `PREDAYS`/`POSTDAYS` separately; stop deriving package LOS from cohort/pre-post days. *(18-Jul, engine `1250c28`)*
- [x] Package tariff per room category from Service-All tariff (tariff_cd × package_cd × room) — replace MOU-derived amounts. *(18-Jul, engine `d07e81a`)*
- [ ] Inclusion/exclusion wiring: Cash + non-GIPSA from extracted MOU; GIPSA from Billur/Satya Excel (pending); layer in the common-exclusions sheet (pending) as always-excluded items. **⏳ waiting on manager's sheets**
- [x] ~~Updated GIPSA+MOU sheet~~ (dropped by him 18-Jul) · **historical dataset INGESTED 18-Jul night** — Dec-24→Apr-25 window: admissions +34% (17,002), lines 690k, coverage to Aug-2024, metrics rebuilt.
- [x] Default LOS applies unless inclusion/exclusion rules say otherwise. *(core done with A1; incl/excl exceptions slot in when the sheets arrive)*

### B — Package matching & choice UX (P1)
- [x] Per-candidate match verdict + reason in the gate list (match / not-a-match, laterality-aware: unilateral ask ⇒ bilateral options marked not-a-match). *(18-Jul, engine `a623a74`+`d550baa`)*
- [x] User can override the AI-picked package to any listed candidate (THR 1/2/3, Revision TKR 8/9/10 — same surgery, commercially different) — flow-2 "use this" per candidate + dock chips. *(18-Jul, HO `d374f1a`)*
- [x] Robotic follow-up: when user answers "robotic", re-run the gate so the robotic package (e.g. ORT5535) or robotic add-on is offered instead of staying on the conventional pick. *(18-Jul — verified: robotic answer promotes ORT5535)*

### C — Clinical vs commercial split (P1/P2)
- [x] New view separating the clinical estimate from the commercial layer. *(18-Jul, HO `29636ad` — Clinical/Commercial strip on flow-2)*
- [x] Show package-bill gross total alongside the IP-approximate gross wherever totals appear. *(18-Jul — both grosses side by side on the strip + case-set panel)*
- [x] Flow diagram documenting the two parts. *(18-Jul — `clinical-commercial-flow.md`)*
- [x] Treatment directory view *(closed by G3, 18-Jul — `/treatments.html`: 309 treatments, counts per payor, care/daycare/robotic/emergency flags, LOS/OT/cath typicals, Flow-2 drill)*

### D — Correctness checks (P1)
- [x] LOS pick audit: conventional TKR showing 5 — root cause found (p50 over CEILED billable stays + tiny robotic subset); package-master LOS now supersedes (TR1 TKR duration = 3, matching his expectation). *(18-Jul)*
- [ ] PF from logic (percent/rule-based), not fixed absolutes; keep cash-fallback rule as-is. **⏳ waiting on his PF doc (promised 18-Jul); medical interim = historic P50**
- [x] Cross-consultation PF separated from operating surgeon PF. *(18-Jul, engine `5e42196`)*

### E — Audit & feedback tooling (P1)
- [x] AI-feedback button for FC Estimate + Flow 2 + Flow 3 — captures all inputs for recreation. *(18-Jul, HO `4d7367e` — flow request bundle rides the Feedback dock)*
- [x] Source-of-data labels (HIMS vs derived) for surgery names, open-billing amounts, payor classification. *(18-Jul — case-set legend; more surfaces as needed)*
- [ ] Ping manager on every push that changes model/logic behaviour. **(standing process — ongoing)**

---

## Needed FROM the manager to proceed

| # | Item | Status per meeting |
|---|---|---|
| 1 | Written notes of the 3–4 hr hospital discussion | promised "within 30 min" — `17_july_inp.pdf` may be it; confirm nothing more is pending |
| 2 | ~~Updated GIPSA + MOU sheet~~ — **dropped 18-Jul evening**: "the new pdf is waste; GIPSA package rates come from the Service-All tariff master (done, A2), incl/excl we already have, LOS is in the package master (done, A1)" | closed |
| 3 | GIPSA inclusion/exclusion — **narrowed**: only the incl/excl DELTA beyond what the previous MOUs already gave us; he's waiting on the hospital for it | pending (delta only) |
| 4 | Common-exclusions sheet (cross-consultation etc.) | pending |
| 5 | Historical dataset (older window) | ✅ **RECEIVED + INGESTED 18-Jul night** — his two files (`PKG DTL 01-12-2024 TO APRIL 2025` + `DEC 1 2024 TO APRIL 2025`) loaded: package-bill history **12,648 → 17,002 admissions (+34%)**, 690k bill lines, coverage back to **Aug-2024**; reconciliation 98.6% within 1%; bucket metrics + robotic classification rebuilt. *(If even older data pre-Dec-2024 exists, that's a separate future drop.)* |
| 6 | Surgery master sheet (+ how/when to use it) | ✅ **RECEIVED 18-Jul** — `Surgery Master _SSG.xlsx` (14,886 rows, 7,938 distinct SURGERYCD; see section G) |
| 7 | GIPSA business-rules JSON ("JSON wala document") | we asked; he acknowledged |
| 8 | Confirmation of THR 1/2/3 assignment rule (hospital's own logic) — or confirm it's purely user's pick | open |
| 9 | Data-source classification for audit (what's from their HIMS vs generated by us) — his ask, but needs his sign-off on our labeling | open |

---

## 18-Jul morning meeting — additions (`2026-07-18_10-47-30.mov`, 11 min)

**New / changed direction:**
1. **Historic metrics become reference-only for PF** — with the improved PF logic, the historic matrix must no longer *override* PF; **historic PF is the only override that remains**, every other discrepancy is flagged, not silently replaced. He will document proper PF handling with samples + validation ("will sort PF today").
2. **Data prep flips to him**: he will clean the noisy sheets, compare against our DB, and tell us which fields to take — we focus on execution. Incoming: **surgery master from Sattar** (all surgeries/procedures, for doctor-wording ↔ canonical-name matching) and **FC data from Dec-2024 onward** (doctor remarks, billing tags, financial estimates, actual bill amounts).
3. **Read-only DB access agreed** — he'll query our RDS himself (via CodeX) for comparisons; no edit risk. → *done 18-Jul: `fc_readonly` role, SELECT-only on public/fc/mart.*
4. He rated the project **80–85% complete, logic ~90%** — remaining work is "minor refinements, auditing, validation".

**New TODO items (append to section D/B):**
- [x] **D4 — DJ-stenting gate ranking** ✅ **resolved 18-Jul** (by F1 + G2, verified on flow-2): for "DJ STENTING (DOUBLE J STENTING) - UNILATERAL" (Cash) flow-2 now decides `billing_type: package, [URO5443] ₹70,000` with the ladder citing "similar package NAME in the FC-historic Cash cohort" — no longer a bare minor-procedure answer. The family cohort label stays "Minor Endourological Procedure" (correct 6-case history bucket); the billing/package decision is the one he expected. (The blank steps he may see mid-flow are just the pending daycare/inpatient question — by design.)
- [x] **D5 — case-count discrepancy (45 vs 26)** ✅ **reconciled 18-Jul** (`scripts/d5-reconcile-djstenting.js`): **no data is missing — our DB holds exactly his data** (42 distinct cash admissions mentioning DJ stenting, identical in his extract and our `fc.package_bill_admissions`; his 45 ≈ row-count incl. multi-row/name variants). The difference is **denominator scope**: his count = ANY admission mentioning DJ stenting (30 of 42 are URSL+DJ combos, most of the rest bilateral); our displayed counts are scoped per exact package — URO5011 (URSL+DJ combo) = 30 cases, URO5443 (DJ unilateral) = 0 billed package cases, family cohort = 6 cash cases. Every number on our screens is one of these scoped subsets; their union matches his umbrella count. *(His PR292 note, if it comes, should slot straight into this mapping.)*
- [x] **D6 — PF override semantics** ✅ **verified compliant 18-Jul** — audit of every history-driven replacement in the engine: the ONLY silent overrides are the sanctioned **historic-PF** paths (insurer token-PF → billed P50, 15-Jul Q1; medical physician-visits PF); cash-surgical PF shows the deviation banner with an explicit **"Use historic PF" button** (flag, user decides — exactly his rule); Q3 backfill only fills EMPTY buckets (additive, warned, never replaces a computed value); historic metrics/bands are display-only reference. One history-consulting heuristic noted for his review: the with-package quote's band sanity-check can prefer the scalar over the room-tier price (both real tariff values; F1 reduced its role). **His PF doc remains wanted only for validation samples, not for implementation.**
- [ ] **E4 — progress notes:** send him short notes on progress + next steps at each milestone (standing process ask).
- [x] **E5 — read-only DB URL** — `fc_readonly` created, verified, shared 18-Jul.

**New asks from him (append to the table):**
| 10 | Cleaned data sources + field mapping suggestions (surgery master from Sattar, FC data Dec-24→) | he does the cleaning, then sends |
| 11 | PF handling document with samples + validation | promised "today" (18-Jul) |
| 12 | His side of the 45-vs-26 case-count query (incl. what PR292 refers to) | he is checking |

## 18-Jul feedbacks (`feedback_jul18.pdf`) — TODO section F

1. **[x] F1 — stage-1 package hint showed the ₹10 placeholder.** ✅ **Fixed 18-Jul evening** (engine `87e1a98`+`79216d2`, live on dev). The hint and every gate candidate now price from real per-room amounts (Service-All matrix → jsonb → tariff-info rescue), and a quote priced from a real room tier is no longer withheld by master "not ready".
   *Verified live: DJ stenting URO5443 hint now ₹70,000 with rooms ₹70k/74k/83k; with-package quote ₹1,42,866 (component ₹83,000, room-tier), unblocked.*
   - His data note confirmed and guarded: the tariff matrix itself carries **duplicate TR1 rows at ₹10** (URO5443's matrix rows are ALL ₹10 — the real prices live in the package master's tariff info). Charges ≤ ₹1,000 are now treated as non-prices everywhere, so the placeholders can never override real amounts. **The dup ₹10 workbook rows still deserve cleanup on the data side.**
2. **[x] F2 — GIPSA/non-GIPSA reclassification — CLOSED 18-Jul, no change needed.** Verified against the mart: our classification already follows his exact rule with **zero violations** — all 3,396 GIPSA-bucket admissions are TR290, and no non-GIPSA admission carries TR290 (insurers spread across TR287/TR201/TR285/TR288…). The gap he saw was only in the raw dataset he shared, which the engine never uses for payor buckets (we derive from the org→tariff mapping). Manager 18-Jul evening: *"no gipsa changes for the moment"* — parked accordingly. (`scripts/check-gipsa-classification.js` re-runs the proof.)
3. **[x] F3 — "Are we now fetching the package LOS days from the pkg master?"** ✅ **Yes — since 18-Jul** (A1, engine `1250c28`): the package resolves before the stay drivers, `package_duration` is the LOS default (0 = daycare), pre/post days exposed, provenance visible (`los_source: package_master` + a warning line on the estimate). *TR1 TKR duration = 3 — matching the LOS he expected.*
4. **[x] F4 — Excel-like audit view in the app.** ✅ **Done 18-Jul evening** (HO `d1d2759`, feature branch). New **"Audit view"** button on the workbench opens the workbook's "Estimate Breakdown" sheet as an in-app table: Line Item · Bucket · Sub-Bucket · Source · How Calculated · Included? · Qty · Rate · Amount at the selected room — FC edits flagged as "FC edit" with the corrected amount highlighted; custom items and excluded rows shown.

## 18-Jul (late) — surgery master received → TODO section G

Manager (chat, with `Surgery Master _SSG.xlsx`): *"This is all the surgery procedure master list… given from the hospital side. It should have all the surgeries or procedures that doctors suggest. Apart from this it's just medical management, which doesn't have a proper name/list. Can you check for our past IP patients if we can clearly map our IP patients with this list? These service/pkg codes should ideally be present in their bill. This should help with our initial flow selection also — it's what the FC currently uses to map what the doctor has written on the admission note to which dropdown to select."*

Sheet shape: 14,886 rows (one per SURGERYDESIGNCD = tariff × surgery), **7,938 distinct SURGERYCD**, columns: SURGERYDESIGNCD · TARIFFCD (TR1, TR136, TR139, TR147, TR160, TR171…) · SURGERYCD · SURGERYNAME · SURGERYTYPE · DEPARTMENTCD · EFFECTFROM/EFFECTTO.

- [x] **G1 — IP-patient mappability check** ✅ **done 18-Jul** — `fc.surgery_master` ingested (14,885 rows / 7,938 codes / 38 tariffs); report: `g1-surgery-master-coverage-18jul.md`. **Verdict: yes — 97.7% of billed surgical admissions map (code 86% + name 12%); 95.2% of ALL surgical IP admissions map via OT/package/bill-line codes; medical maps 1.6% (expected).** Gaps: ~159 billed codes missing from the master (export available) + legacy 2024 OT names.
- [x] **G2 — surgery master as the stage-1 matching corpus** ✅ **done 18-Jul** (engine `ccb440e`): SURGERYNAME word-match (resolved tariff first) → surgery_cd → package on the tariff, unioned with alias/master-name candidates before AI ranking; `master_match` provenance on candidates. **Verified: DJ stenting surfaces URO5443 at the real ₹70,000 for both the exact wording and "cystoscopy with DJ stenting"; TKR verdicts unchanged.**
- [x] **G3 — treatment directory** ✅ **done 18-Jul** (engine `5695a30`): `/treatments.html` on the engine — all 309 treatments with case counts (total + per payor), surgical/medical, daycare/robotic/emergency rates, LOS p25/50/75, ICU/OT/cath typicals, department; searchable/sortable; every row drills into Flow 2 prefilled. Closes C4's doable core too.

## Cross-references
- Feedback PDF page 1 ↔ TODO B (match verdicts + user override).
- Feedback PDF page 2 ↔ TODO C (package gross beside IP gross) + LOS=3 confirmation on robotic.
- Feedback PDF page 3 ↔ TODO D (LOS 4–5 too high) and A (PKGDURATION/POSTDAYS/PREDAYS).
- Feedback PDF page 4 ↔ TODO B (THR is a package but flow-2 took non-package history) + "Pkg - Tariff, Pkg LOS, Pkg Inclusion" = TODO A.
- `17_july_inp.pdf` "Clinical Part" ↔ TODO C treatment directory; "For our Pkg" ↔ TODO A items 1–3.
