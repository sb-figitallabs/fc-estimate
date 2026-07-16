# Problems register — from the 35-case engine-vs-reality validation (16-Jul)

Source: `engine-vs-reality-16jul.md` (35 real FC↔final-bill pairs). This register
exists so every fix is designed **not to create ten new failures**: each problem
carries its root cause, the safe fix, what the naive fix would break, and the
regression gate that must stay green before the fix ships.

## FIX STATUS (17-Jul batch, engine dev 059c4f5 — all verified against the frozen suite)

| Fix | Result | Key verification |
|---|---|---|
| P2 negation guard | ✅ SHIPPED | "TKR NON ROBOTIC B/L": add-on optional not injected (₹5.02L); genuine robotic unchanged (₹7.32L); 10 wording unit cases |
| P1 with-package quote | ✅ SHIPPED | SURLA quote ₹402,860 vs bill ₹406,505 (−0.9%, was +82% read); AKARAPU −5%; G NAGAVENI blocked(not_ready); exact package calls intact; non-package builds field-identical; band gate self-caught a contaminated Cash quote |
| P3 named drugs | ✅ SHIPPED | SHOURYA −87%→−10.9% (STELMA→STELARA fuzzy+dose corroboration, sale_rate flagged); chemo double-count proof (+₹232 not +₹9,972); VARSHITHA frozen input names no drug → guard path correct, −21.8% once confirmed; controls byte-identical; kill switch both ways |
| P4 catch-all guard | ✅ SHIPPED | BANDANADAM/KRISHNA/G NAGAVENI (−74%/+371%/−36%) now mandatory labeled question; ARTH/NEEHARIKA/S RAMESH unchanged; 20-family label sweep zero new questions; composes under P5's newborn question |
| P5 newborn question | ✅ SHIPPED | 3 neonates stop at the cohort question (NICU answer −5.5% vs one bill); naive silent routing measured and REJECTED (would flip a GOOD case to −81%); JIVITESH(10y)/ARTH byte-identical; sick-newborn cohort has only 5 mart cases — mining blocked by data (tell the manager) |
| P6 LOS-banded residuals | ✅ SHIPPED | NARESH 41,068→25,048 (Investigations 20,790→4,770); extra tightening: trigger requires P25 < P50 so typical-stay cohorts never band (verified both directions); surgical byte-identical; kill switch both ways. Residual gap = PF/room/per-day machinery (scoped out) |
| P7 package-amount drift | queued | routes through the package-tariff sync audit (billed data as truth, per room tier) |
| P8 combo pricing / P9 recounselling | scoped future phases | — |

New register entries FROM the fixes:
- **P10 — session-based families lose their per-day load**: sessionBased room
  suppression (15-Jul Q4) removes room/bedside rows but nothing adds a
  per-session charge — newborn/jaundice builds underquote their own cohort
  P50s (13.3k vs 25.5k). Fix belongs in the session-row logic (a per-session
  charge mined from the cohort). Found by P6, deliberately not forced there.
- **P11 — bucket_extras can contain the package's own billed line** (billed
  under a different service name, e.g. ROBO equipment / Cash PF), inflating
  the extras rung; P1's band gate contains it (proved live); the durable fix
  is the P7 sync audit's line classification.
- **P12 — pharmacy catalog MRP coverage**: only 1,641/7,630 rows carry MRP
  (STELARA priced via sale_rate, flagged price_source) — an MRP backfill will
  move named-drug figures; auditable via the flag.

## The guardrail infrastructure (applies to every fix below)

1. **The 35-case set is now a frozen regression suite.** Extractions + verdicts
   live in `engine-vs-reality-16jul-data/`; the pipeline is re-runnable
   (`extract.mjs` skip-done, `run_engine.mjs`, `compare.py`). Rule: a fix ships
   only if the 12 ENGINE_GOOD cases stay within ±25% and no case's verdict
   worsens. The fix's own target cases must improve — measured, not assumed.
2. **Existing suites that must stay green**: cash parity 1042/1042 (TKR figure
   is pinned to the paisa), flow2 374-case sweep (zero data-invariant
   failures), verify-estimates harness (207 zero-input builds).
3. **Additive-only response policy**: no fix changes the meaning of an existing
   field (`final_estimate` stays itemized). New behavior arrives as new fields
   with a `source`/flag so the UI and the audits can attribute every number.
4. **One flag per behavior change**, so a bad fix can be turned off without a
   rollback of unrelated work.

---

## P1 — Package route computes the right total but never quotes it
**Cases/money**: SURLA +82% (₹330k phantom error), G NAGAVENI (no usable number
either way); touches every package-billed quote — 8/35 real bills were packages.
**Why**: `final_estimate` is always the itemized figure. When billing
identification says "package", `package_offer` carries the package and even the
conversion machinery — but no `with_package` headline ever reaches the quote.
The engine's own arithmetic (pkg 224,600 + ~190k implant excludes) reproduces
SURLA's ₹406,505 bill almost exactly. *The engine knows the route; it doesn't
finish the sentence.*
**Safe fix**: additive `package_offer.quote = { with_package_total, basis }`
computed from package amount + predicted payable extras (the
`bucket_extras` history built 16-Jul is exactly the "predicted excludes"
source). Surfaces as the headline **only on the package route AND only when**
readiness is `can_generate_estimate` AND the conversion check does not flag the
band — otherwise the itemized figure stays headline with the package quote as
secondary. Never touch `final_estimate`.
**Naive fix would break**: replacing `final_estimate` with the package total →
every parity pin, saved-estimate payload, PDF, and settlement calculation
shifts; quoting packages with ₹10 placeholder amounts or failed conversion
checks → confident garbage (G NAGAVENI's ₹27,500 tendon package is exactly
that trap — its `not_ready` status must keep blocking).
**Regression gate**: parity suite unchanged (cash TKR is itemized-route);
35-case replay — SURLA/GUDURU/AKARAPU improve, HEMALATHA/PINNAMANENI stay
exact; verify harness unchanged (additive field).

## P2 — "NON ROBOTIC" wording triggers the ₹230,000 robotic add-on
**Cases/money**: SURLA (+₹230k on one case; any negated-wording GIPSA TKR).
**Why**: the `treatment_text_robotic` detector is a substring match (`/ROBOT/i`)
— "TKR **NON ROBOTIC** B/L" contains "ROBOT". Verified: `robotic:"no"` rebuild
drops 737,751 → 507,751.
**Safe fix**: negation guard in ONE place (the wording detector used by both
build and flow2): treat as robotic only when the robot token is NOT immediately
preceded by a negator (`NON[- ]?`, `NOT `, `NO `, `WITHOUT `). Nothing else in
the robotic ladder changes — presence rules, gate flag, explicit
`robotic:"yes"/"no"` all keep their current precedence.
**Naive fix would break**: a broad "any negation word anywhere in the text"
rule would suppress genuine robotic on wordings like "robotic TKR, non-weight-
bearing post-op". Anchor the negator to the token, not the sentence.
**Regression gate**: flow2 sweep robotic questions unchanged; the robotic
matrix repro (tmp-repro-robotic-matrix) — explicit robotic wordings still
include ₹1.2L/₹2.3L; 35-case replay — SURLA improves, HEMALATHA/PINNAMANENI/
LAKSHMI (genuinely robotic) unchanged.

## P3 — Named high-cost drugs invisible to daycare infusion pricing
**Cases/money**: SHOURYA -87% (₹119k missed), VARSHITHA -64% (₹32k). Humans
were within 8–13% — they simply looked the drug up.
**Why**: the infusion family prices the generic cohort; the drug name sits in
the treatment text AND in the pharmacy master (MRP lookup exists), but no path
connects them.
**Safe fix**: for daycare-infusion-class families ONLY (explicit family
whitelist), attempt a high-confidence pharmacy-master match on the treatment
text; on a hit, add a `named_drug` line (MRP × qty) and **replace** the cohort
pharmacy figure with `max(cohort pharmacy P50, drug line + non-drug pharmacy
residual)` — replace, not add, so the drug isn't double-counted where the
cohort already partially carries it. Line flagged `source: named_drug_mrp` +
a warning asking the FC to confirm the drug/qty.
**Naive fix would break**: plain addition double-counts (cohort pharmacy P50
already includes some drug spend); running the text-match on ALL families
would bolt drug lines onto surgical estimates from stray brand names in
remarks. The whitelist + replace-not-add + visible flag prevent all three.
**Regression gate**: 35-case replay — SHOURYA/VARSHITHA improve; every
non-infusion case byte-identical (whitelist guarantees it); chemo/immuno
families in the verify harness re-checked for double-count.

## P4 — Catch-all families match specific wording with unearned confidence
**Cases/money**: BANDANADAM -74% (₹332k under), KRISHNA +371%, G NAGAVENI -36%.
**Why**: when the wording names something we have no family for (maxillofacial
arch-bar, complex plastic reconstruction, Achilles repair), the AI matcher
falls to a catch-all (general_plastic, orthopaedic_management, …) and reports
medium/high confidence. The estimate inherits a cohort that has nothing to do
with the case.
**Safe fix — the distinction that prevents collateral**: generic wording →
generic family is CORRECT ("medical management" → general_medical_management
scored -15%/-26% GOOD and must not regress). The failure is **specific wording
→ generic family**. Guard: top match ∈ catch-all list AND the wording contains
specific procedure tokens with no overlap against that family's label/aliases
⇒ cap confidence at `low` + set `needs_confirmation: true`; flow2 renders its
existing pending-question machinery ("we only have a generic match — confirm
or pick"), the Simple flow shows its existing confirm step with a visible
generic-match warning. No new blocking anywhere else; explicit user confirm
proceeds exactly as today.
**Naive fix would break**: demoting catch-alls wholesale → NO_MATCH storms on
the (correct) generic-wording majority; asking a question on every catch-all →
question fatigue and a broken 374-sweep. The specific-tokens-without-overlap
condition is what scopes it.
**Regression gate**: 35-case replay — ARTH/NEEHARIKA/Baby-of-NIKHAT (generic
wording, GOOD) still auto-resolve; BANDANADAM/KRISHNA/NAGAVENI now stop at a
question (counted as converted-to-question, not as a miss); flow2 sweep re-run
— no new pending questions on families whose label matched the wording.

## P5 — Neonatal coverage gap (and the humans share it)
**Cases/money**: 3 "Baby of…" cases +79% to +143% (quotes ₹63k vs bills
₹26–36k). Human FCs were +89% to +169% — a mined newborn family beats both.
**Why**: no newborn/nursery family exists; "Baby of X, medical management"
resolves confidently to ADULT general_medical_management, whose cohort floor
is adult-priced.
**Safe fix**: data work first — mine a `newborn_care_nursery` family from the
billed corpus (the FB set itself shows the ₹26–36k @1–3d shape). Routing:
"Baby of"/newborn/neonate token OR age < 30 days ⇒ prefer the newborn family.
Age check prevents the 10-year-old ENT case from routing to nursery.
**Naive fix would break**: keyword-only routing ("baby") without the age check
grabs paediatric surgical cases (JIVITESH is "Master", age 10 — verify the
token list against all 35). NICU escalations must not be forced into the
nursery cohort — keep NICU wording routing to its own path.
**Regression gate**: 35-case replay — the 3 neonates land near ₹26–36k;
JIVITESH/CHARVIN (paediatric surgical) unchanged; flow2 sweep unchanged (new
family = new registry entry, additive).

## P6 — Trivial-stay floor on medical management
**Cases/money**: NARESH +421% (₹41k quote vs ₹7.9k bill; small money, terrible
optics).
**Why**: template rows backfilled from historical P50s (Investigations ₹20,790
etc.) are stay-independent — a 1-day observation inherits the full cohort's
median diagnostics load.
**Safe fix**: LOS-conditioned residuals for medical-management families: when
the requested LOS sits at/below the cohort's P25 stay, compute backfilled
bucket residuals from the SAME-stay-band sub-cohort (enough cases exist:
1-day medical admissions are common); fall back to today's behavior when the
sub-cohort is thin (<15 cases). Never applies to surgical families (their
costs are procedure-driven, not stay-driven).
**Naive fix would break**: scaling buckets linearly by LOS ratio would gut
correct 2–3 day estimates (ARTH -14% replay, NEEHARIKA -15% must not move) and
mis-model fixed per-admission costs. Sub-cohort quartiles, not scaling.
**Regression gate**: 35-case replay — NARESH shrinks toward ₹8–15k;
ARTH/NEEHARIKA/SARBESWAR-replay unchanged (their LOS ≥ cohort P25); verify
harness medical families re-run (this touches the same residual machinery as
15-Jul Q3 — its report must not regress).

## P7 — Package-master amounts lag the billed tariff (data drift)
**Cases/money**: ORT5510 master 149,900 vs billed 168,700; ORT5531 master
224,600 vs billed 202,100 AND 252,600 (two amounts, same code — likely tariff
version/room-tier variants). ₹19–28k per package quote.
**Why**: the master was loaded once; the hospital's contracted amounts moved.
The engine's own conversion-check already fires on exactly these packages —
the knowledge exists but reads as a footnote.
**Safe fix**: this IS the already-queued package-tariff sync audit (manager's
own design, 15-Jul): billed package data as source of truth, per tariff code ×
room type, documenting nominal-vs-significant variances — then a reviewed
master refresh. Until then: promote the conversion-check warning to quote-level
prominence on the package route (ties into P1's gating), never silently.
**Naive fix would break**: bulk-overwriting master amounts from bills conflates
room-tier price variants (the two ORT5531 amounts are probably both correct
for different tiers) and destroys the audit trail. Audit → review → refresh.
**Regression gate**: P1's gate covers the display side; the sync audit itself
produces the diff sheet before any master row changes.

## P8 — Combo quoting (urology-class) — known, scoped, not a regression risk
**Cases/money**: RAMBABU -68% even at actual LOS; 5/35 bills were 50%/25%
multi-procedure combos. ENT combos are already absorbed by cohort history
(+13%/-8%) — fixing combos must not disturb that.
**Why**: the engine prices one treatment; the hospital's combo ladder is
mechanical (pkg + 2nd procedure @50% + others @25%) but unmodelled. Detection
+ per-path evaluation shipped 16-Jul (flow2 + intake announcement); combined
pricing was explicitly deferred.
**Safe fix (when taken up)**: a `combo_quote` composed from flow2's per-path
package identifications through the 50/25 ladder, offered as a labeled
secondary quote — never replacing single-treatment pricing, and NOT applied to
ENT-class families whose cohorts already contain combo bills (that would
double-count; the family's own billed history tells us which class it is:
compare cohort P50 vs single-procedure package price).
**Regression gate**: JIVITESH/MEENAKSHI (ENT combos, already good itemized)
must not move; RAMBABU-class gets the new secondary quote.

## P9 — Recounselling scored as initial estimates
**Cases**: 7/35 FCs were recounsellings; 4 ended course-changed.
**Why**: a mid-treatment estimate needs consumed-to-date context the engine
never receives; comparing it to the full final bill misjudges everyone.
**Safe fix**: not an engine change — a scoring/product note: recounselling
quotes should eventually take "billed so far" as an input (future feature);
until then the regression suite tags them (R) and weighs them accordingly.

## Watch-list (not fixed deliberately)
- **RAMULU +27%** (Investigations bucket ₹55,490 looks inflated) — single
  marginal case; folded into the routine bucket audit rather than a targeted
  change that could nudge other ortho cases.
- **Y CHANDRIKA bilateral EVLT -33%** — laterality/consumable modeling; needs
  bilateral sub-cohorts. Deferred: low case volume, medium complexity, and a
  wrong generic "×2" rule would damage unilateral estimates.
- **KRANTHI FB extraction inconsistency** (category sum ≠ gross) — data-entry
  or extraction issue on the bill side; excluded from scoring, flagged.

## Order of execution (money × safety)
P2 (one-line, zero-risk) → P1 (biggest money, additive) → P3 (whitelisted) →
P4 (converts misses to questions) → P5 (data mining) → P6 (sub-cohort work) →
P7 (the queued sync audit) → P8/P9 (scoped phases).
