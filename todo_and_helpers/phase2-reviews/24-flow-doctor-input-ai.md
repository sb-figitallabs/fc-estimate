# Review — Flow, package codes & doctor-input / AI boundary

**Input reviewed:** `newinps_updated.docx` → "Flow" tab (your end-to-end thinking on package codes, doctor NLP input, and where AI belongs).
**What this tab decides:** the estimation flow and the AI/rules boundary. Verdict: your hypotheses are largely right — **package code (not name) is the anchor**, and **AI interprets while governed rules decide** — with specific refinements.

## 1. ✅ Matches / endorses your thinking
- **Code-first, not code-only.** Package code is the stronger anchor (606/607 codes keep the same surgery code across tariffs; names vary — 136 codes have multiple names; 3,655/4,184 admissions use multi-name codes). Keep name as supporting variant evidence. Production key = `tariff_code + package_code (+ org + room + effective period)`.
- **AI boundary = your model.** AI reads the doctor's text, decomposes treatments, extracts context (diabetes→GRBS etc.), ranks candidates, suggests optional items — governed rules decide payer/tariff/applicability/rates/inclusion/PF/GST/totals. The doc confirms our current resolver already does constrained AI matching, multi-treatment decomposition, deterministic payer/tariff, laterality/robotic, combined→component package search, and **readiness-refusal instead of fabricating** — the architecture is right.
- Four optional-item layers (mandatory deterministic / conditional deterministic / AI-suggested-confirm / manual) and the single confirmation screen are endorsed.

## 2. ⚠️ Could worsen currently-verified logic
- **Package code alone must never fetch an amount** — 237/238 multi-tariff codes have different amounts (`ORT5510` ₹1.25L–₹2.55L). Retrieve price only with `tariff + org + code + room + effective period`.
- **Cross-payer / cross-route history must never silently become the financial cohort** (140/237 codes appear in only one payer group) — it's comparison/context only.
- **Don't let historical prevalence auto-decide robotics too aggressively.** Current resolver auto-treats >90% robotic prevalence as robotic; refine to: dedicated package/explicit wording → robotic; >90% → preselect but confirm; mixed → ask (only 5 cells were 100% robotic). Same for surgical/medical and daycare/non-daycare (194/818 and 179/818 cells are mixed — ask when material).
- **AI must never** invent a code/rate/quantity/amount/eligibility, calculate PF/GST/totals, apply another payer's package, or infer laterality/robotic/implant as fact. (This slightly expands our current AI scope to include optional-item suggestions — record it as an explicit product decision.) **(N9)**
- A doctor-supplied package code is a **strong assertion, not truth** — validate tariff/active/org/room/concept/variant agreement; on conflict, block + confirm, never silent fuzzy replace.

## 3. ⛔ New work / decisions
- Consolidate duplicate historical templates into canonical scenario families (244 codes → 117 map to >1 template, one to 31) before code-based selection is clean.
- Extend the doctor-input contract (treatments, context, investigations, LOS, package/PF assertions, implants, drugs) with source-span provenance + confidence + override status per field; field-level override governance (privileged role for code/tariff/rate/inclusion/PF); never overwrite original doctor text.
- Mismatch tiers: **block** (code↔tariff/concept conflict, laterality conflict, medical→surgical package, inactive package, missing rate), **confirm** (side unknown, daycare/inpatient both material, PF differs from rule, LOS>package LOS, AI high-cost add-on, other-payer-only evidence), **inform** (spelling/alias where code+concept+variants agree).
- **N9** — approve the governed AI optional-item suggestion layer (constrained to approved candidates) as a product decision.

## 4. Validation — ✅ partial engine check done (21 Jul, read-only)
- **Robotic is a user selection in our engine, not force-set from prevalence** (cohort.js: "payor/tariff/room are user inputs"); robotic presence is shown as a hint. The doc's caution about >90%-prevalence auto-deciding applies to our **optional add-on inclusion** heuristic (`case_presence_rate > 90` → include) — the same "suggest/confirm" refinement is worth applying there.
- **AI boundary already constrained** — familyResolve's matcher is instructed "Never invent packages… return null when nothing genuinely fits"; the engine refuses (readiness warnings) rather than fabricating. The new ask is the *optional-item suggestion layer* (**N9**), a scoped expansion.
Still to do (per-topic): confirm package price keys on the full commercial identity (verified for TKR in file 22) and that cross-payer history never becomes the financial cohort; backtest doctor-language routing on a gold set.
