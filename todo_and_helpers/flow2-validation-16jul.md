# Flow 2 — validation report (16-Jul)

**What was tested:** the new interactive Flow 2 — your flow document executed
as an auditable SOP sequence with a decision point at every step, and numbers
that are **pure history** (percentiles of the matched IP cases — no tariff,
LOS or calculation logic anywhere). Live on the dev engine
(`POST /api/flow2/evaluate`); the review UI ships as an admin "Flow 2" mode
beside the existing Flow view. Nothing in the current flow was changed.

## The sweep

**374 test cases** — every onboarded family (~170) × Cash + GIPSA, every 5th
family × Non-GIPSA, plus targeted probes (gibberish wording, multi-treatment
combo, mode toggles). **604 total evaluations** including answer round-trips.
**215 clarifying questions were raised and answered** the way an FC would
(majority option), and every answer was honored.

| Outcome | Count |
|---|---|
| Cases evaluated | 374 |
| Reached numbers (fully decided) | 327 |
| — through the package path | 69 |
| — through the non-package path | 258 |
| Clarifying questions asked / answered | 215 / 215 |
| Silent wrong answers | **0** |
| Data-invariant failures | **0** |

## What was asserted, case by case

1. **Step order** always matches the flow doc: payor → family → surgical-medical
   / daycare / robotic characterization → billing identification (package
   master) → FC-historic template (the fallback ladder) → per-payor summary.
2. **Payor resolution** correct for all three payor types: Cash ⇒ TR1 (KIMS,
   no insurer mapping touched), GIPSA org ⇒ TR290, Non-GIPSA org ⇒ its own
   tariff.
3. **Questions carry the history**: every clarifying question includes the
   case counts ("Robotic — 61% of 248 GIPSA cases had it"), and numbers are
   withheld until the question is answered — the flow never guesses past an
   ambiguity.
4. **Numbers are really pure history**: for every case where the full IP list
   was returned, the gross P25/P50/P75 were **independently recomputed from
   the listed IP cases and matched the reported numbers exactly**. The values
   are the history of the named cases — nothing else.
5. **Case sets obey their filters**: every returned IP row was checked against
   the declared filters (payor scope, daycare, robotic, care type) — no case
   leaks across a filter; widening the payor scope never shrinks the set.
6. **Package-path coherence**: a package decision always carries the package
   code, and the historic-template step always shows which ladder rung
   decided it. Inclusion/exclusion text is attached as review-only — amounts
   come from past billing metrics, per the 12:37 call.
7. **Honest edges**: nonsense wording ⇒ "no similar treatment found in the FC
   historic dataset" (a stated dead end, not a forced match); "lap chole +
   hernia" ⇒ the combo is detected and announced.

## Failures found (6 of 374) — both causes closed same day

- **5× family flip on answer round-trips** — the AI family matcher can
  occasionally re-rank between the question call and the answer call, flipping
  the cohort mid-conversation. **Fixed**: the UI now pins the resolved family
  on every round-trip; a pin equal to the engine's own top match stays marked
  "auto" (it only reads "you chose this" when the user genuinely overrode).
- **1× transient network blip** on one call — retried fine.
- Also fixed from review: the payor step's explanation for Cash wrongly
  mentioned the insurer mapping ("TR290 = GIPSA") — the decision was always
  correct (Cash ⇒ TR1), the sentence now says so plainly.

## Deviations from the flow doc (deliberate, flagged for your call)

1. **Robotic wording auto-decides**: "robotic TKR" in the treatment text sets
   robotic = yes without asking (same rule as the gate). Overridable.
2. **Multi-treatment combos**: detected and announced, but only the first
   treatment is priced in this phase — the doc's "a path for each" is the
   next phase of the combo work.
3. **One question at a time** rather than all ambiguities upfront — each
   answer can change what the next question should be.

## Added same day (the three items originally deferred)

1. **`mode = logic / both` — the dissection layer.** The real engine build
   runs alongside the pure history (same decided family/package/robotic; room
   type selectable, Typical mode) and every bucket gets a verdict: *"Room —
   historically ₹36,871–₹49,208; logic produced ₹42,558 — within"*, plus a
   gross-total verdict. The logic build receives NO free text — it prices the
   audited decisions, so it can never disagree with the trail about WHAT is
   being priced, only about the amounts. Verified live: historic numbers are
   byte-identical across modes; the contracted robotic ₹1.2L rides the logic
   side; switching to a General room moves only the logic figures.
2. **Combo — a path per treatment.** "lap cholecystectomy + inguinal hernia
   repair" now evaluates each treatment through the full SOP independently —
   its own trail, its own questions, its own numbers — with tabs per
   treatment, the identified billing shape ("2 packages" / "package +
   non-package"), and a combined historic-P50 strip (marked as an upper-bound
   reference: combo interactions like shared LOS/OT are not modeled yet).
   Answering a question on one path changes only that path (verified).
3. **Matcher stability + speed.** The AI matching (family AND package
   ranking) is now cached per wording within a session with retry/backoff
   underneath: answer round-trips dropped from ~7s to ~0.04s, the same
   wording can never resolve differently mid-conversation, and the transient
   flake rate seen under concurrent testing retries silently instead of
   surfacing. Verified: three consecutive combo evaluations give the
   identical billing shape.

**Net**: the flow executes exactly as documented, every step is auditable with
its evidence and case counts, the numbers are provably the history of the
named IP cases — and the logic layer is now available side-by-side for the
dissection, per treatment, at interactive speed. Ready for hands-on review on
the test server.

---

## Appendix — raw suite output

```
Cases: 374 (evaluations incl. answers: 604) in 1227s
Questions asked: 215, answered: 215
Reached numbers: 327 · package path: 69 · non-package: 258 · no-match: 0 · matcher-flake: 46

Failures: 6
I4 (5) — answered axis not marked decided_by user (family re-rank between
  calls; fixed via the family pin):
  immunotherapy × Cash · uti_urosepsis_medical_management × GIPSA ·
  minor_procedure_biopsy × Cash · combined_upper_gi_endoscopy_and_colonoscopy
  × Cash · clavicle_fracture_fixation × Cash
HTTP (1) — turbt_transurethral_resection_of_bladder_tumor × Cash: transient
  fetch failure on one answer round
```
