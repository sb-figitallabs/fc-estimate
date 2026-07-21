# Review — Handling variants

**Input reviewed:** `newinps_updated.docx` → "Handling Variants" tab (robotic / laparoscopic / left-right / unilateral-bilateral / revision).
**What this tab decides:** how variants attach to a treatment and drive historical matching. Verdict: store variants as **structured attributes on a canonical treatment**, payer-dependent, never as free-text names or universal multipliers.

## 1. ✅ Matches our engine / endorsed
- Variants as attributes (`approach` / `scope` / `side` / `episode` / `implant`) on a base concept — the doc notes our Builder **already has** `robotic_selection` + laterality fields and supports historical robotic modifier schedules. Architecture base is present.
- **Robotic is payer-specific and clear from history** (805 robotic admissions): Cash → dedicated robotic package (`ORT5535/5784/5536`, robotic charge included); GIPSA → ordinary TR290 package **+ separately billed** robotic (~₹1.2L uni / ₹2.3L bi); Non-GIPSA → org base package + robotic modifier (Da Vinci ~₹70k). Keep the exact rule org/tariff-specific.
- Two laterality dimensions: **Scope** (unilateral/bilateral) and **Side** (left/right) — derive both from "Right TKR", keep side even when it doesn't change price (it can change the package code).

## 2. ⚠️ Could worsen currently-verified logic
- **Never pool unilateral + bilateral** (TKR cash P50 ₹2.76L uni vs ₹5.20L bi; implants ₹81–100k vs ₹166–178k). If any cohort pools them, estimates are wrong.
- **No universal laparoscopic multiplier.** "Lap = open + 10%" is false — cholecystectomy differs by tariff (TR201/TR290 different; TR287/TR289 same). Resolve an exact approach-specific package; use a shared package only where the master explicitly combines open/lap.
- **Don't treat "robotic" as a mere approach label** (payer-specific inclusion/exclusion) and **don't treat unspecified approach as conventional** — store `unknown`, ask when material, show conventional-vs-robotic scenarios side by side (FC text detected only ~11% of final robotic package cases; robotics often decided after estimate).
- **Left/right pooling only when commercially equal** and distributions comparable — verified per treatment/tariff (some non-TKR left/right rates differ, e.g. breast). Never derive laterality from naive keyword matching ("Right Heart Catheterization" is not a side).
- Laterality conflicts exist (16.7% of stated cases) — don't silently pick a side/scope package when FC and final disagree; require confirmation.

## 3. ⛔ New work
- Canonical treatment-component **variant table** + backfill from package/bill codes and direct robotic evidence (not from every `surgery_master_names_jsonb` value — that overstated multi-procedure cases). Concept-specific allowed dimensions (TKR asks laterality/robotic/revision/implant, not vessel count). Payer-specific modifier schedules starting with robotics. Certify laterality/approach per high-volume family before auto-estimating.
- Unknown material variant → produce **scenarios, not an average** ("Conventional ₹X–Y / Robotic ₹A–B").

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**Our engine already keeps uni/bi separate.** `engine/cohort.js` defines distinct families — conventional TKR unilateral (`package_name ~* '^TOTAL KNEE REPLACEMENT' AND package_name !~* 'BILATERAL'`) vs bilateral (its own cohort), plus robotic uni-left / uni-right / bilateral — so **uni+bi are never pooled**, and there's no universal "lap = open +N%" multiplier (families are named cohorts, not multipliers). Robotic is priced as a payer-specific add-on (contracted tariff → cohort → TR1-flagged), matching the doc. Left/right are pooled only within unilateral (commercially equal for TKR) — as the doc endorses.
Still to do (per-topic): confirm variant backfill uses billed/package codes not the `surgery_master_names_jsonb` blob; reproduce the robotic payer-structure table on our data.
