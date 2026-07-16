# Engine vs Reality — 35 historical FC counsellings vs 162 final bills (16-Jul)

Real-world validation of the FC estimate engine (`https://fc-estimate-dev.figitallabs.com`) against
KIMS Gachibowli's own paperwork: 35 historical Financial Counselling PDFs
(`~/Downloads/inputs/Old Financial Councellings/`) and their matching final bills
(`~/Downloads/inputs/Old Final Bills/`, 162 files; all 35 FCs matched an FB by name and IP number,
the other 127 FBs have no FC and were ignored).

**Method in one paragraph.** Each FC and FB PDF was extracted to structured JSON with Gemini
(`gemini-2.5-flash`, temperature 0, JSON mode); 4 extractions (2 FC, 2 FB) were hand-verified
against the raw PDFs before running the fleet. Per case the engine was driven exactly as a user
would: free-text treatment (surgery name + the truer counsellor-remarks wording) through
`POST /api/flow2/evaluate` for family + billing-route resolution (answering pending questions from
the FC's own fields: care type, setting, robotic), then `POST /api/estimate/build` with the FC's
opted room and planned LOS (`los_basis: Manual`), plus a default-LOS build and — where the actual
LOS differed — a **replay at the actual LOS/ward**. Insurers were resolved via
`/api/lookup/organizations` from the bill's Organization (preferred) or the FC's TPA
(e.g. New India/Oriental/National/United → GIPSA Insurance; Star/Care/Manipal/MD India → Non-GIPSA).
All bill comparisons use **net amount (after concession) minus Food & Beverages**, since engine
totals exclude F&B; gross-vs-net is flagged where it matters. Every number below is reproducible
from the run artifacts (paths at the end).

Two verdict rules follow the caution in the brief: bills whose treatment changed
(LOS jump, added procedures, multi-procedure "second procedure at 50%/25%" combos) are scored
**COURSE_CHANGED**, never as engine misses; and package-billed cases are judged on the engine's own
chosen billing route (its package identification), not only the itemized number.

---

## (a) Headline scoreboard

| Verdict | Cases | Meaning |
|---|---|---|
| **ENGINE_GOOD** | **12** | same treatment/LOS; engine quote within ±25% of bill-excl-F&B (or exact package call) |
| **ENGINE_OFF** | **12** | same treatment/LOS; engine still off — real engine misses, root-caused below |
| **COURSE_CHANGED** | **11** | LOS/procedures/billing structure changed vs the FC plan — scored separately |
| NO_MATCH | 0 | the deployed registry (30+ families incl. catch-alls) matched everything — but 3 of those matches were *wrong*, counted in ENGINE_OFF |

Accuracy on the 24 clean (non-course-changed) cases:

| Metric | Engine | FC human (same 24 cases) |
|---|---|---|
| Median abs % error vs bill (excl. F&B) | **26.4%** | **12.0%** |
| Mean abs % error | 70.5% | 40.7% |
| Cases within ±25% | 12/24 | 15/24 |
| Engine error ≤ human error | 9/24 | — |

**Honest bottom line: the engine is not yet as accurate as the human FCs overall (26% vs 12%
median), but its misses are concentrated in 5 specific, fixable causes (section d) — and on
structured surgical families it already matches or beats the humans.** On the 12 ENGINE_GOOD
cases the median error is **14.5%**, and on package identification it was *exact* (code and
rupee amount) on both cash robotic-TKR package bills.

Calibration context — the humans are not oracles either: the FC's quoted **range contained the
actual bill in only 11/35 cases** (bill below the range 13×, above it 11×). Median human error
across all 35 billed cases: 14.1%. The engine quote landed inside the FC's own range 9/35 times,
below it 18×, above 8×.

---

## (b) Full per-case table

Engine quote = the engine's number on its own chosen billing route (package amount where its route
was package *and* that is what it would quote; itemized `final_estimate` otherwise), at the FC's
planned LOS and opted room. Bill = net minus F&B. LOS = planned/actual. Eng% / FC% = engine and
FC-range-midpoint deviation from the bill. (R) = Recounselling (mid-treatment estimate).

| Patient | Treatment (FC) | Payor | FC range | Engine quote (route) | Bill xF&B | LOS p/a | Eng% | FC% | Verdict | Cause / note |
|---|---|---|---|---|---|---|---|---|---|---|
| Mr ABDUL HASEEB MOHAMMAD | LAP./VATS THORACIC SYMPATHECTOMY | Cash | 262,000–321,000 | 240,424 (non-pkg) | 279,340 | 2/2 | -14% | +4% | ENGINE_GOOD | thoracic_surgery_vats; bill gross was 329,640, hospital gave ₹50,300 concession |
| Master ARTH AGGARWAL | MEDICAL MANAGEMENT | GIPSA | 72,000–88,000 | 82,764 (non-pkg) | 111,619 | 2/3 | -26% | -28% | ENGINE_GOOD | stayed 1 day longer; replay@3 = 95,935 (-14%) |
| Baby of NIKHAT SHAMSI | MEDICAL MANAGEMENT (newborn) | Cash | 41,000–50,000 | 43,417 (non-pkg) | 36,605 | 1/2 | +19% | +24% | ENGINE_GOOD | within 25% despite LOS 1→2 |
| Mrs GUDURU LAKSHMI DEVI | TKR - LEFT (conventional) | GIPSA | 399,000–439,000 | 326,703 (pkg route) | 348,954 | 4/4 | -6% | +20% | ENGINE_GOOD | bill = pkg ORT5510 168,700 + implant excludes; engine itemized -6% |
| Mrs HEMALATHA THOTA | ROBOTIC TKR - UNILATERAL - RIGHT | Cash | 355,000–391,000 | 355,000 (package) | 369,220 | 3/3 | -4% | +1% | ENGINE_GOOD | package call exact: ORT5535 @ 355,000 = the bill's package |
| Master K CHARVIN (R) | ORCHIDOPEXY | GIPSA | 161,000–196,000 | 222,884 (non-pkg) | 200,680 | 1/1 | +11% | -11% | ENGINE_GOOD | paediatric_laparoscopic_surgery_major (medium conf) — right money anyway |
| K LAKSHMI DEVAMMA (R) | TKR BILATERAL (robotic) | GIPSA | 609,000–670,000 | 762,181 (non-pkg run) | 682,744 | 6/5 | +12% | -6% | ENGINE_GOOD | engine's robotic add-on ₹230,000 appears verbatim on the bill (ROBO (TKR) - BILATERAL) |
| Mrs Neeharika Gorla | MEDICAL MANAGEMENT | GIPSA | 70,000–85,000 | 82,764 (non-pkg) | 97,488 | 2/1 | -15% | -20% | ENGINE_GOOD | |
| Mrs PINNAMANENI VIJAYALAKSHMI | ROBOTIC TKR - BILATERAL | Cash | 690,000–760,000 | 690,000 (package) | 700,340 | 6/4 | -2% | +4% | ENGINE_GOOD | package call exact: ORT5536 @ 690,000; LOS 6→4 irrelevant under package |
| Mrs RAVULA PUSHYAMI | EXCISION SOFT TISSUE LESION - MAJOR | GIPSA | 69,000–84,000 | 61,014 (non-pkg) | 78,043 | 1/1 | -22% | -2% | ENGINE_GOOD | |
| Mr S RAMESH (R) | OTHER MAJOR SURGERY ORTHOPAEDICS | Cash | 282,000–345,000 | 242,160 (non-pkg) | 286,709 | 3/3 | -16% | +9% | ENGINE_GOOD | matched clavicle_fracture_fixation off generic wording — landed anyway (lucky; see d.5) |
| Mrs SHIVA KUMARI | ORIF CLAVICLE PLATING | Cash | 295,000–360,000 | 257,877 (non-pkg) | 209,920 | 4/2 | +23% | +56% | ENGINE_GOOD | replay@2 = 226,443 (+8%); human was +56% |
| Mr BANDANADAM NAVEEN IGNESIOUS | OTHER MAJOR SURGERY PLASTIC SURGERY | Cash | 442,000–541,000 | 118,019 (non-pkg) | 449,879 | 3/2 | **-74%** | +9% | ENGINE_OFF | vague wording → generic plastic family, *high* confidence |
| Baby Boy NAKKA TRIVED RAJ K. | MEDICAL MANAGEMENT (newborn) | Cash | 65,000–80,000 | 63,107 (non-pkg) | 30,555 | 2/1 | **+106%** | +137% | ENGINE_OFF | neonatal gap (human was +137%) |
| Baby of HARIKA | MEDICAL MANAGEMENT (newborn) | Cash | 60,000–73,000 | 63,107 (non-pkg) | 35,231 | 2/3 | **+79%** | +89% | ENGINE_OFF | neonatal gap |
| Baby of SOUNDARYA | MEDICAL MANAGEMENT (newborn) | Cash | 63,000–77,000 | 63,107 (non-pkg) | 26,007 | 2/1 | **+143%** | +169% | ENGINE_OFF | neonatal gap |
| G NAGAVENI | ACHILLES TENDON RUPTURE REPAIR | GIPSA | 252,000–307,000 | 164,978 (pkg?) | 256,866 | 3/2 | **-36%** | +9% | ENGINE_OFF | orthopaedic_management_procedure catch-all (medium conf) underprices; billing-id offered TENDON REPAIR pkg @27,500 (wrong scale) |
| Mr KRISHNA B R | ARCH BAR WIRING – DOUBLE JAW | Cash | 30,000–37,000 | 86,120 (non-pkg) | 18,282 | 1/1 | **+371%** | +83% | ENGINE_OFF | mis-resolved maxillofacial → general_plastic_surgery (medium conf) |
| Mr NARESH GURAJALA | MEDICAL MANAGEMENT (1 day) | Cash | 25,000–30,000 | 41,068 (non-pkg) | 7,887 | 1/1 | **+421%** | +249% | ENGINE_OFF | medical-mgmt template floor (₹20,790 P50 investigations etc.) swamps a trivial stay |
| Mr RAMULU GUNDI | CRIF CALCANEUS FRACTURE | Cash | 247,000–302,000 | 328,743 (non-pkg) | 258,837 | 4/3 | **+27%** | +6% | ENGINE_OFF | marginal; Investigations bucket ₹55,490 looks inflated |
| Mr SHOURYA SRIVASTAV | DAY CARE INJ STELMA 90 MG IV | Cash | 133,000–162,000 | 17,821 (non-pkg) | 136,548 | 1/1 | **-87%** | +8% | ENGINE_OFF | named biologic (₹~1.2L) not priced from treatment text |
| S RAJESWARI | TKR BILATERAL — "NON ROBOTIC" | GIPSA | 393,000–432,000 | 737,751 (as-run) | 406,505 | 6/5 | **+82%** | +2% | ENGINE_OFF | **bug: "NON ROBOTIC" text triggered the ₹230,000 robotic add-on** (robotic:auto); clean rebuild 507,751 still +25%; pkg route (224,600 + ~190k implants ≈ 415k) would have been ~+2% but the engine never emits that total |
| Miss VARSHITHA | injection day care procedure | Cash | 51,000–62,000 | 17,821 (non-pkg) | 50,000 | 1/1 | **-64%** | +13% | ENGINE_OFF | named drug not priced |
| Mrs Y CHANDRIKA | ENDOVENOUS ABLATION B/L + FOAM SCLERO | Non-GIPSA | 132,000–161,000 | 115,798 (non-pkg run) | 173,668 | 1/1 | **-33%** | -16% | ENGINE_OFF | right family (EVLT, high conf); bilateral + laser consumable underpriced; billing-id suggested pkg VAS0033 @280,000 while the bill was open |
| Master A JIVITESH SAI (R) | ADENOTONSILLECTOMY (coblation) | GIPSA | 137,000–168,000 | 129,354 (non-pkg) | 114,097 | 1/1 | +13% | +34% | COURSE_CHANGED | billed as combo: TONSILLECTOMY pkg 40,100 + ADENOIDECTOMY 50% + 2×EUM 25% + COBLATOR ₹16k; engine itemized was still +13% (human +34%) |
| Mr AKARAPU VISHWANATAHM | TKR - LEFT | GIPSA | 264,000–291,000 | 326,703 (pkg route) | 243,307 | 4/2 | +34% | +14% | COURSE_CHANGED | LOS halved; replay@2 = 297,788 (+22%); bill pkg ORT5510 @168,700 vs engine pkg master 149,900 (see data gaps) |
| Mrs ANITA KUMARI (R) | "d & c procedure" (medical recouns.) | GIPSA | 106,000–129,000 | 38,368 (non-pkg) | 144,512 | 4/4 | -73% | -19% | COURSE_CHANGED | bill = D&C package + discounted hysteroscopy combo; treatment text also mis-resolved to lscs_caesarean at *low* confidence (D&C family not onboarded) |
| Mr T HARANADHA BABU | PTCA - SINGLE VESSEL | GIPSA | 500,000–550,000 | 201,655 (non-pkg) | 1,019,024 | 3/13 | -80% | -48% | COURSE_CHANGED | 13-day stay, TWO packages (CAR5154 PTCA + CAR0122 CAG), IVUS, 2nd vessel, dialysis; replay@13 = 426,748 — still -58%, but the treatment genuinely multiplied |
| Mrs K ASHWINI | POEM - PC | GIPSA | 205,000–226,000 | 218,312 (pkg route) | 250,220 | 1/4 | -13% | -14% | COURSE_CHANGED | stayed 4 days not 1; replay@4 = 228,368 (-9%) — engine replay lands |
| Mr KRANTHI KUMAR | MEDICAL MANAGEMENT (AICU) | Cash | 307,000–376,000 | 102,488 (non-pkg) | 406,000 | 4/1* | -75% | -16% | COURSE_CHANGED | MICU + endoscopic sclerotherapy/EVL added; *FB extraction internally inconsistent (category sum ≠ gross) — LOS suspect |
| Baby MEENAKSHI VECHA | ADENOTONSILLECTOMY + EUM | GIPSA | 127,000–156,000 | 131,854 (non-pkg) | 143,368 | 1/1 | -8% | -1% | COURSE_CHANGED | billed as ADENOIDECTOMY pkg 50,000 + tonsillectomy 50% + 4 lines at 25% + COBLATOR ₹16k; engine itemized still -8% |
| Mr RAMBABU (R) | CYSTOSCOPY + URS LITHOTRIPSY | GIPSA | 421,000–464,000 | 128,677 (non-pkg) | 399,282 | 2/6 | -68% | +11% | COURSE_CHANGED | combo (CYSTOSCOPY URS + DJ STENTING pkg 64,400 + 50% lines) + LOS 2→6; replay@6 = 179,506, still -55% — urology combos are a real gap |
| Mr SARBESWAR MAITY | medical management | Non-GIPSA | 163,000–200,000 | 68,458 (non-pkg) | 495,516 | 3/16 | -86% | -63% | COURSE_CHANGED | LOS 3→16; replay@16 = 199,931, still -60% — long-stay escalation beyond the family cohort |
| Mr VUTKUR SURYA PRAKASH (R) | ENDOSCOPY | Cash | 171,000–208,000 | 104,605 (non-pkg) | 153,554 | 4/3 | -32% | +23% | COURSE_CHANGED | bill added colonoscopy + therapeutic endoscopy + fibroscan + 2D echo; bill sits inside the engine's (very wide) P25–P75 band 47,689–169,790 |
| Mrs YALABANDI K S L VALLIDEVI | LAP MYOMECTOMY | Non-GIPSA (Star) | 146,000–161,000 | 190,560 (non-pkg) | 166,213 | 3/1 | +15% | -8% | COURSE_CHANGED | billed as *Open* Myomectomy pkg 107,502 + HYSTEROSCOPY 50% combo, LOS 3→1; engine itemized still +15% |

---

## (c) Where the engine is CORRECT — patterns

1. **Package identification is the engine's strongest skill.** On both cash robotic-TKR package
   cases it produced the exact package the hospital billed, to the rupee: HEMALATHA ORT5535
   @355,000 (bill 369,220 incl. ₹14k extras, -3.9%) and PINNAMANENI ORT5536 @690,000
   (bill 700,340, -1.5%). The flow2 billing-identification step also correctly said "package" on
   every case the hospital actually billed as a package (8/8), and "non-package" on ABDUL,
   S RAMESH, SHIVA etc. that were billed open.
2. **The robotic add-on model is validated by reality.** LAKSHMI DEVAMMA's bill carries the line
   "ROBO (TKR) - BILATERAL ₹230,000" — exactly the contracted add-on amount and item the engine
   priced (OTI0099, tariff_contracted). Total +12%.
3. **GIPSA joint replacement, itemized route**: GUDURU -6%, LAKSHMI +12%, AKARAPU replay +22% —
   the insurer-tariff itemized totals track pkg+implant-excludes bills well, because implants
   (the money) are excluded from GIPSA TKR packages and the engine's pharmacy/implant history
   carries them.
4. **Clean-wording mid-size surgery, cash or GIPSA**: VATS sympathectomy -14%, orchidopexy +11%,
   clavicle ORIF +23%→+8% on replay, soft-tissue excision -22%. When the treatment text names a
   real procedure and a specific family exists, the engine is inside ±25% almost every time.
5. **Adult inpatient medical management (insured, 1–3 days)**: ARTH -26%→-14% replay,
   NEEHARIKA -15%, Baby-of-NIKHAT +19%. The general_medical_management family is decent at
   *adult-scale* short stays.
6. **LOS replay works.** Of the course-changed cases where only the stay length changed, replay
   at the actual LOS landed within ±25% in 3 of 4 (ASHWINI -9%, AKARAPU +22%, plus
   ENGINE_GOOD-side replays SHIVA +8%, ARTH -14%). This is direct evidence the driver model is
   right and the *input* (planned LOS) is what fails — same failure the humans have.
7. **ENT combos are absorbed by history.** Even though the engine prices a single family, its
   adenotonsillectomy cohort evidently contains combo bills: JIVITESH +13%, MEENAKSHI -8% vs
   real pkg+50%+25% combo bills — while the human FC was +34% on JIVITESH.

## (d) Where the engine is WRONG — root-caused (12 real misses)

**1. No "with-package" total on the package route — 2 cases directly, affects every package quote
(₹100k–330k per quote).** The engine identifies the package but `final_estimate` stays itemized
and `package_offer` carries no payable-extras/with-package total (both null in every response).
SURLA: itemized +82% (or +25% clean); the package math it already had (pkg 224,600 + ~190k
implant excludes) reproduces the ₹406,505 bill almost exactly. G NAGAVENI's billing-id offered a
₹27,500 TENDON REPAIR package with `not_ready` status while the itemized total was -36% — no
usable number either way. *The engine knows the route; it doesn't finish the arithmetic.*

**2. Robotic add-on false-trigger on negated wording — 1 case, ₹230,000.** Treatment text
"TKR **NON ROBOTIC** B/L" with `controls.robotic: "auto"` fires the `treatment_text_robotic`
detector (substring match) and injects the ₹230,000 add-on. `robotic: "no"` correctly suppresses
it (verified: 737,751 → 507,751). One-line negation guard in the robotic text detector
(`services.js isRoboticText`).

**3. Named high-cost drugs invisible to daycare infusion pricing — 2 cases, ₹32k–119k each.**
"DAY CARE INJ STELMA 90 MG" → engine ₹17,821 vs bill ₹136,548 (-87%); VARSHITHA -64%. The
drug name is in the treatment text and in the pharmacy master (MRP lookup exists via
`/api/lookup/pharmacy-items`), but the infusion family prices only the generic cohort. The human
FCs were within 8–13% on both — they looked the drug up.

**4. Neonatal coverage gap — 3 cases (+ the floor problem), +79% to +143%.** "Baby of …" cases
resolve to adult `general_medical_management` (high confidence) and quote ₹63,107 for what bills
at ₹26k–36k. Expected NO_MATCH per the brief; instead the engine confidently overquotes ×2. Note:
the human FCs were *equally* wrong (+89% to +169%) — the hospital systematically overquotes
newborn stays, so history-mining a "newborn" family from the FB corpus would beat both.

**5. Catch-all families match vague wording with unearned confidence — 3 cases, ₹68k over to
₹332k under.** BANDANADAM ("OTHER MAJOR SURGERY PLASTIC SURGERY") → generic plastic family at
*high* confidence, ₹118k vs a ₹450k reconstruction. KRISHNA (ARCH BAR WIRING, maxillofacial) →
same plastic family, +371%. G NAGAVENI (Achilles repair) → orthopaedic catch-all, -36%. When the
best match is a catch-all and the wording names no specific onboarded procedure, the gate should
stop with a question (flow2 already has the pending-question machinery), not quote.

**6. Trivial-stay floor — 1 case, +421%.** NARESH: 1-day observation billed ₹7,887; the
medical-management template's P50-backfilled rows (e.g. Investigations ₹20,790 "filled from
historical actuals") produce a ₹41k floor. Small absolute money, terrible optics.

**7. Laterality/equipment nuance — 1 case, -33%.** Y CHANDRIKA bilateral EVLT + foam: right
family, but bilateral consumables (laser fiber ×2) and PF underpriced; the payor-history package
suggestion (RF ABLATION @280,000) contradicted the open bill.

**8. Marginal overestimate — 1 case, +27%.** RAMULU CRIF calcaneus; Investigations bucket ₹55,490
alone is bigger than most whole-case investigation spends here.

**Data gaps observed (not scored):** engine package master amounts lag the billed GIPSA amounts —
ORT5510 engine 149,900 vs billed 168,700 (Oriental & New India); ORT5531 engine 224,600 vs billed
202,100 (SURLA) and 252,600 (LAKSHMI) — same code, two billed amounts, suggesting tariff-version
drift the master doesn't capture. HARANADHA's CAR5154/CAR0122 package codes were not verified
against our master. The engine's own "Package conversion check" warning fired on exactly the
packages whose converted totals are unreliable (AKARAPU, SURLA, ANITA) — the engine already knows.

## (e) Course-changed cases (11) — what actually changed

| Case | What changed between FC and bill | Engine replay at actuals |
|---|---|---|
| HARANADHA BABU | PTCA became PTCA+CAG (2 packages) + IVUS + 2nd vessel + dialysis; LOS 3→13 | 426,748 vs 1,019,024 — replay off; treatment multiplied, not just LOS |
| SARBESWAR MAITY | medical mgmt 3d → 16-day escalation | 199,931 vs 495,516 — off; cohort can't scale to outlier stays |
| RAMBABU (R) | URS became multi-procedure combo (pkg 64,400 + 50% lines); LOS 2→6 | 179,506 vs 399,282 — off; urology combo gap |
| K ASHWINI | POEM stay 1→4 days; FC said Package, billed open | 228,368 vs 250,220 (**-9%, replay good**) |
| AKARAPU | TKR LOS 4→2 (package bill insulated most of it) | 297,788 vs 243,307 (+22%, replay acceptable) |
| KRANTHI KUMAR | AICU medical plan → MICU + EVL/sclerotherapy; FB extraction inconsistent (sum ≠ gross) | replay not meaningful |
| ANITA KUMARI (R) | medical recouns. → D&C package + hysteroscopy combo | n/a (family mis-resolved anyway) |
| A JIVITESH SAI (R) | single-family plan billed as 4-procedure ENT combo + coblator | itemized already +13% |
| MEENAKSHI VECHA | same, 6-procedure ENT combo + coblator | itemized already -8% |
| YALABANDI | lap myomectomy billed as *open* pkg + hysteroscopy 50%; LOS 3→1 | itemized already +15% |
| VUTKUR (R) | "endoscopy" became UGI + colonoscopy + therapeutic + fibroscan | bill inside wide band; typical -32% |

7 of 35 FCs were **Recounselling** (mid-treatment) — 4 of them ended course-changed. Recounselling
inputs need consumed-to-date context; scoring them like initial estimates flatters nobody.

## (f) Fix list, ranked by money impact

1. **Emit the with-package total** (package amount + predicted payable extras/excludes) whenever
   `billing_identification` says package, and make it the headline quote on that route.
   Impact here: ₹300k+ error removed on SURLA alone; 8/35 real bills were package bills.
2. **Negation guard on the robotic text detector** ("NON ROBOTIC", "non-robotic", "without
   robot"). ₹230,000 per false trigger; trivial fix; also mirror it in any UI default.
3. **Price named drugs in daycare/infusion treatment text** via the existing pharmacy-item lookup
   (MRP × qty), added on top of the family cohort. ₹32k–119k per case; daycare infusion volume
   is high.
4. **Gate guard for catch-all families**: when the top match is a generic family
   (general_plastic, orthopaedic_management, general_medical…) and no specific procedure token
   matched, return a pending question instead of a high-confidence quote. Would have converted
   3 big misses (-74%, +371%, -36%) into questions.
5. **Neonatal family** (Baby-of/newborn detection → nursery/NICU cohort mined from bills like
   these: ₹26k–36k @1–3 days). Also fixes the medical-mgmt floor for trivial stays (NARESH).
6. **Refresh per-tariff package amounts** (ORT5510/ORT5531 drift of ₹19k–28k vs billed) and
   surface the engine's own package-conversion warning as a quote blocker, not a footnote.
7. **Combo quoting** through flow2 multi-path (the 50%/25% second-procedure ladder is mechanical:
   pkg + 50% + 25%×n). 5/35 bills were combos; ENT ones survive via cohort history, urology ones
   do not (-68%).

---

## Method notes & caveats

- Bill basis: **net (post-concession) minus F&B**. Cash bills carry discretionary concessions
  (ABDUL ₹50,300; MEENAKSHI's MOU discount ₹15,954) — engine-vs-gross would shift cash errors
  ~+10-18% upward; verdicts were checked against both and only ABDUL/ARTH sit near the boundary.
- Extraction: gemini-2.5-flash, temp 0; 4 documents hand-verified page-by-page (ABDUL FC+FB,
  HEMALATHA FC, MEENAKSHI FB — all exact). One known extraction inconsistency flagged (KRANTHI FB).
- Engine controls per case: opted room from the FC (remarks wording wins), planned LOS via
  `los_basis: Manual`, care type from the FC header, robotic only when the FC says robotic;
  coblation was tracked as an equipment flag (2 ENT cases; bills carry COBLATOR ₹16,000 +
  PROCISE wand ₹14,687 — present in the ENT cohort history, no crash, no explicit engine line).
- SURLA was re-run after fixing a harness-side robotic regex; the residual +230k trigger is the
  engine's own (`treatment_text_robotic`), verified by a controlled `robotic:"no"` rebuild.
- No engine/HO source was modified; nothing committed.

## Artifacts (all reproducible)

| File | Content |
|---|---|
| `/private/tmp/fc-eval/fc_cases.jsonl` | 35 extracted FC counsellings |
| `/private/tmp/fc-eval/fb_cases.jsonl` | 35 matched extracted final bills |
| `/private/tmp/fc-eval/engine_runs.jsonl` | per-case flow2 + build (planned-LOS, default, replay) |
| `/private/tmp/fc-eval/comparison.jsonl` | machine three-way comparison |
| `/private/tmp/fc-eval/adjudicated.json` | final hand-adjudicated verdicts used above |
| `/private/tmp/fc-eval/extract.mjs`, `run_engine.mjs`, `compare.py` | re-runnable pipeline (skip-done) |

Copies of the JSONL artifacts are alongside this report in
`todo_and_helpers/engine-vs-reality-16jul-data/`.
