# Package-Bill Actuals — What the 3 Excel Sheets Gave Us (14-Jul)

## What the sheets contained
| Sheet | Rows | What it is |
|---|---|---|
| May 2025 – Dec 2025 bills | 264,907 lines | Every billed line item of every package-billed IP patient in that window |
| Jan 2026 – 13-Jul-2026 bills | 249,692 lines | Same, for the current period |
| Pkg detail (May 25 – Jul 26) | 12,648 admissions | One row per IP admission: open-bill vs package-bill flag, tariff, payer, package amount, inclusion amount, defined/undefined exclusions, NME, admission/discharge dates |

Together: **12,648 real admissions with 514,599 billed lines**, telling us — for the first time — what package conversions *actually* cost, not what the rate cards say.

## What we did with them
1. **Loaded everything into the estimate database** (two new tables: per-admission summaries + per-line detail). The load runs in **51 seconds** and is one-click repeatable whenever a refreshed export arrives.
2. **Matched them to our existing admission history**: **10,802 of 12,648 (85.4%)** of these admissions are the same patients our estimate engine already learns from — so the actual package bills can sit directly beside our estimates.
3. **Computed the "converted actuals" benchmark**: for every treatment family, the P25 / P50 / P75 of the **final package bill (package + exclusions, food & beverage removed)**, split by payor group (Cash / GIPSA / Non-GIPSA).
4. **Put it where decisions happen**: the admin audit panel now shows, for any estimate, "Package bills (converted actuals): Cash · n cases · P25/P50/P75 …" with the rule of thumb that **a quoted package amount should sit inside P25–P75**.

## Why this matters — a live example (TKR Bilateral)
| Payor group | Real converted bills | P25 | P50 | P75 |
|---|---|---|---|---|
| GIPSA Insurance | 136 | ₹4.42 L | ₹6.35 L | ₹6.77 L |
| Non-GIPSA Insurance | 23 | ₹5.44 L | ₹6.33 L | ₹7.50 L |
| Cash | 16 | ₹5.05 L | ₹5.20 L | ₹5.51 L |

Before this, the builder's historic range came from IP *approximate* bills — which can overstate what a package patient finally pays (the Robotic-TKR case: approx range ₹5.2–5.9 L vs an actual converted bill near ₹4 L). Now every packaged quote can be sanity-checked against what the hospital genuinely billed for the same treatment and payor.

## What the sheets also revealed (data findings worth knowing)
- **The bills reconcile almost perfectly with the summary sheet**: the billed amount per line is `rate × excluded-quantity`, and summing it matches the declared package gross for **98.3% of admissions within 1%** (100% within 5%, one outlier: IPGB2627000521, ₹5.18 L declared vs ₹3.81 L from lines — worth a billing-team look).
- **Coverage is package-bills only, as expected**: 3,736 of the 12,648 admissions are package bills with full line detail; 8,912 are open bills (summary only). **40 package-billed admissions have no line detail** in the bill sheets.
- **1,846 admissions (14.6%) aren't in our system's history** — mostly dates before our data window (the sheet starts Jan-2025; our history starts later) — they still count in the benchmarks.
- **Food & beverage is negligible**: 11,158 lines but only **0.1%** of the ₹105.7 Cr billed — excluding it (as specified) barely moves the numbers, but it's cleanly flagged per line.
- The two bill sheets split by admission cohort, not by billing date (lines from a May-2025 admission continue into Feb-2026) — handled in the load.

## Where this goes next
1. **Package-amount difference report** — our package master vs what billing actually charged, now a straightforward query over the loaded tables.
2. The same actuals can later feed the quoted range itself (not just the audit view), once the benchmark is reviewed.
3. Re-run the one-click load whenever a fresh export lands — the pipeline is permanent.
