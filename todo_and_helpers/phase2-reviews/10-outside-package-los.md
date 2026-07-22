# Review — Outside package LOS

**Input reviewed:** `newinps.docx` → "Outside Package LOS" tab.
**What this tab decides:** beyond the package LOS the package stays as the base charge; only incremental excess-day care is added at actuals — the package and its PF are never recalculated.

## 1. ✅ Safe / strongly supported
- Package = base; per excess day add: ward/ICU room, extra surgeon visit, primary-physician visits (1 ward / 2 ICU per day), DMO (ward only), intensivist (ICU), **net** IP pharmacy (range), medically-necessary investigations, continuing cross-consults. 966 package admissions exceeded LOS; **97%** had post-package consultant charging.
- **Never recompute the 20/25/35% package PF because the stay grew** — add only excess-day visits. This aligns with our extended-LOS visit design (T1).
- **"Outside package ≠ collect from patient"** — apply insurer eligibility / NME / do-not-collect *afterward*. **(N5)**

## 2. ⚠️ Could worsen currently-verified logic
- Entitlement is **per setting** — unused ward days cannot offset excess ICU days (or vice-versa). Needs a **day-by-day ward/ICU ledger**, not a single `excess_days` number. **(N5)**
- A new procedure during the excess stay = **separate treatment logic**, not an automatic excess-day charge.
- Avoid double-charging: an item that's already a package exclusion from day 1 must not be added again as a post-LOS charge — label `PACKAGE_EXCLUSION` **or** `POST_PACKAGE_LOS`, not both.
- Do **not** auto-add a drug-administration charge on excess pharmacy (conflicts with the DNB guidance) unless the payer/package explicitly approves.

## 3. ⛔ Blocked
- **743 of 4,223** package admissions have no governed LOS. Never default to the common 3-day; require a reviewed LOS value first (retain the override source).

## 4. Validation we'll run first
Reproduce the 966-overstay cohort (median 1 excess day per payer) and the 97% post-package consultant rate on our data; confirm our packages carry governed LOS before enabling the logic per-package.
