# Review — Billing training Excel

**Input reviewed:** `newinps.docx` → "Billing Training Excel" tab (8-sheet hospital billing checklist workbook).
**What this tab decides:** whether the workbook is useful in the FC Builder — yes, as a **rule-enrichment source** (billing units, OT slots), **not** a rate master or complete policy.

## 1. ✅ Safe use
- **133 of 135 codes already exist** in our tariff — join to canonical codes, don't duplicate. Only `ROM0013` (Triple Sharing) and `MSC1891` (Cadaver) lack coverage; keep inactive.
- Real incremental value: **billing-unit rules** (per-event / 24h / half-day / per-eligible-day / oxygen hourly-to-6 then daily), the **OT half-hour slot ladder** (normal `OTC0005–0020`, emergency `OTC0054–0069`), ward/ICU companion-service candidates, cath-lab duration (`CAT5117`/`CAT5036`), and generic instrument tiers (minor <30m / medium 30m–2h / major >2h).
- **Confirms our LAN PF rules**: open surgeon 25%, asst 15%, anaesthetist 25%, GIPSA pkg 20%, Non-GIPSA pkg 25%, corporate 16%, cardiology 20%.

## 2. ⚠️ Could worsen currently-verified logic — do NOT import blindly
- **Material conflict:** the workbook's **final-insurance** columns say surgeon **35–40%**, assistant surgeon **35%**, anaesthetist **45%**, assistant anaesthetist non-billable — which conflicts with Policy 2.0 / our spec (35 / 25 / 35 / 25) and our LAN 25%. **Do not activate these percentages.** This is **D1** — ask the billing head to confirm the four final-insurance roles + effective date.
- **Monitor code error:** the workbook labels `EME0019` "Monitor Half Day" (Bedside sheet) but "Monitor Per Day" (Ward sheet); our master says `EME0019` = Per Day, `EME5047` = Half Day. Treat as a workbook error — don't import as an alias.
- The workbook has **no effective dates, payer applicability, package treatment or rates** — it can't be executable logic as-is; it enters `fc_curated` as reviewed training evidence, promoted rule-by-rule.

## 3. ⛔ Resolve before its rules go executable
- Final-insurance PF % (D1); emergency-OT timing & payer window (workbook 8PM–8AM vs some MOUs 6PM–7AM); DMO/intensivist/monitor collectibility (ties to DNB tab); urology-instrument threshold base (below/25k–50k/above ₹50k — unclear whether the instrument itself is in the base; `OTI0058/0059` absent from history). **(N3)**

## 4. Note
This tab mostly **confirms and enriches** existing logic; its danger is purely the final-insurance PF block, which is the same D1/D2 decision as the PF tab.
