# 13-Jul — changes shipped today (one-liners)

## Engine + estimate correctness
- [x] LOS × ward-charge multiplication fixed (manual days now price correctly; LOS-only override works)
- [x] TR1 cash-rate fallback for insurer tariffs with missing service rates (₹1 token rates kept as-is; fallback rows flagged)
- [x] "Cash rate" badges + "{n} items priced at cash tariff" note in the estimate workbench
- [x] Per-room package pricing from the stored room tiers (General/Twin/Single now differ — verified live)
- [x] Robotic-by-payor one-click suggestion ("GIPSA prices this as TKR + robotic add-on — switch?") — live
- [x] OT hours input in BOTH forms, with the cohort default shown ("typically N")
- [x] Room-charge / LOS auto-population verified end-to-end on the test server

## NLP / treatment matching
- [x] AI treatment matcher (free wording → correct family, ranked with confidence) on the admission-note path
- [x] AI match also fires when the dropdown search finds nothing — e.g. "dnc dilatation" → D&C / Surgical Evacuation, one click

## Patient-facing estimate (preview/PDF)
- [x] KIMS Gachibowli logo on the estimate header
- [x] Terms & Disclaimers block taken from the printed FC forms (LOS/complications, pre-auth, 80% advance, refunds, Sec 269ST) — included in translations
- [x] TPA field beside the Insurer in both forms (free-text for now; shows on the estimate)
- [x] Zero values hidden (no "0 ICU", no ₹0 rows)
- [x] Typical-stay hint + placeholders in the Simple form

## Package inclusions / exclusions
- [x] Patient-friendly rewrite format finalised from the approved sample
- [x] Bulk AI rewrite executed across the full package catalog (clean text now shown on the estimate)
- [x] When a package has 2 source variants: pick Source 1/2 on the estimate page → preview shows that variant's clean version (verified on ORT5535)

## Workbook (Excel export)
- [x] "Robotic Data" provenance block — "robotic charge seen in 26 of 26 Cash cases (100%) · applied · value", on both generation paths

## Data / audits
- [x] KIMS Packages Excel vs database — full 642-row comparison + PDF report (24% full match; per-room tiers existed in the DB but were unused — now used; 9 questions listed in the report)
- [x] Package-bill actuals (3 record Excels): loaded 14-Jul via S3 → streaming loader — 12,648 admissions / 514,599 lines live; per-payor P25/50/75 in the admin Data-source panel
- [x] Estimate range from actual package-bill amounts (excl. F&B) — done 14-Jul: package offers carry billed actuals; workbench shows "actual bills ₹X–₹Y · N converted cases"; patient preview range uses the actuals band (≥5 cases) with a source footnote
- [ ] Packages-Excel override ETL — starts once the report's 9 questions are answered (still with manager)

## Infra / process
- [x] Dedicated test server: `https://fc-estimate.hospitalos.figitallabs.com`

**Everything above is live on the test server for accuracy verification.**
