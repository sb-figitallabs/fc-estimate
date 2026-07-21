# Review — Treatment review (broad vs specific)

**Input reviewed:** `newinps_updated2.docx` → "Treatment Review" tab.
**What this tab decides:** make sure a **specific** treatment cohort is used over a **broad** one (broad = fallback only), label treatments broad/specific, and compare amounts at the right level. Verdict: our architecture already leans this way; the hierarchy + enforced fallback aren't complete.

## 1. ✅ Matches our engine
- The doc confirms the architecture "already follows the principle that clinical specificity should take precedence over raw case count, and broader cohorts should be fallbacks" — we have families/templates/variants, exact-first matching, payer/route/daycare/robotic dimensions, case thresholds, and fallback that exposes the relaxed dimension.
- The financial validation backs our separation of clinical vs commercial: same clinical scenario across payers differs mostly by **rates** (median gross diff 20.95%, quantity diff 0%); different **variants** within a payer differ by **utilisation** (gross diff 41.07%, service-rate diff 1.40%) — so variants can't be handled by repricing a broad cohort. Matches our uni/bi-separate, robotic-add-on design.

## 2. ⚠️ Could worsen currently-verified logic
- **A broad family must never beat a specific treatment because it has more cases / better payer coverage.** Enforce exact-first: deepest supported concept → remove its broader ancestors from primary competition → resolve variants → then payer/route → exact scenario → governed fallback ladder (each fallback disclosing the relaxed dimension). Cohort size sets confidence/range width **after** clinical matching — never the treatment meaning.
- **Label broad concepts `fallback_only`** — "general medical management", "chemotherapy", "arthroscopic surgery", "angiography" must not be picked when more-specific info exists (chemo family IQR ≈ its median; regimen medians ₹8k→₹74k).
- **Same treatment ≠ same amount** — compare *layered*: gross (validate the total/range), bucket (composition), **item quantity + target-tariff rate** for non-pharmacy, **sub-bucket amount** for pharmacy. Don't demand drug-brand matching for routine pharmacy (expensive drugs/implants are the explicit exceptions). Never let a broad cohort supply a **package price** (code+payer+room+date only).

## 3. ⛔ Blocked / data corrections (N13)
- **353 clean admissions missing a family selection** — add them.
- **3 missing canonical concepts** (88 admissions currently carrying misleading fallback refs like THR): Knee Ligament Reconstruction ACL/PCL (56), Knee Arthroscopy/Meniscal (18), Hip Hemiarthroplasty/Bipolar (14).
- Coverage reality: only **171/3,060 scenarios have ≥15 cases; 2,300 have 1–4** → governed fallback is unavoidable, but must preserve material clinical drivers.
- Adopt hierarchy fields: `clinical_concept_id / parent_concept_id / concept_level / specificity_rank / permitted_fallback_parent / fallback_requires_validation`, with variants (laterality/approach/robotic/regimen/vessel-count/implant-class/support-level/daycare) as **structured dimensions**, not separate treatment names.

## 4. Validation — to run
Audit our family→template selection to prove a **specific concept always outranks a broad family** (e.g. our `total_knee_replacement_unilateral` vs a generic TKR cohort); label the `fallback_only` concepts; add the 88 missing concepts + 353 family selections; run the layered gross/bucket/item/pharmacy comparison on our data.
