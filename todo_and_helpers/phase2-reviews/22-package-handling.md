# Review — Package handling

**Input reviewed:** `newinps_updated.docx` → "Pkg Handling" tab (audit of all 4,184 confirmed package IPs).
**What this tab decides:** whether package names/mappings/amounts and package-vs-combo selection were correct historically, and how the Builder should decide them. Verdict: clinical names are reliable; **combos are understated and the clean package-rate source is not trustworthy yet.**

## 1. ✅ Strong / matches
- **Clinical names ~correct:** 4,166/4,184 (99.6%) have deterministic clinical support. Payer→tariff routing very strong (all 1,440 GIPSA on TR290; Non-GIPSA governed routes; Cash TR1).
- Package bills are internally coherent: primary package code present in 97.4%; component amounts reconcile to header in 93.8%; package-derived final within 1% of reported final for 94.2%.
- Our package runtime philosophy (exact current package → separately-certified historical schedule, **no generic TR1 package fallback**) is endorsed — retain it.

## 2. ⚠️ Could worsen currently-verified logic — flag hard
- **The clean package-rate view appears to under-price by ~half.** TR290 unilateral-left TKR historical ₹1,34,900 / ₹1,51,800 / ₹1,68,700 (Gen/Twin/Single) vs the clean rate view ~₹79,200 / ₹87,100 / ₹95,000. Clean rate differs from actual bill in **2,615** admissions; exact match only **840**. **`v_package_rates_current` must NOT be the definitive package-price source** until the hospital confirms the authoritative rate columns — otherwise package estimates are massively low. **(N7)** — this is the single biggest risk in this tab and worth checking against our engine immediately.
- **Combinations are understated:** name-counting gives 11.5%, but real definite combos are **21.9%** (potential 26.8%). Store the discount as a **commercial modifier** (Primary 100% / Secondary 50% / 25%), never inside the clinical name. Don't rely on the package-name field for structure.
- **FC's initial package flag ≠ final billing** (FC agreed only 72.6%; procedures change after admission — NDVD→LSCS, CAG→PTCA). Reconfirm package classification after final procedure/authorisation/room — never use the FC flag as the sole decision.
- `open_bill_amount` is positive in *every* package admission (it's the underlying itemised bill) — must **not** be used to classify a case as package-plus-open.
- Package amount is not the patient estimate — final/package ratio ~1.09× cash / 1.80× GIPSA / 1.67× Non-GIPSA; present base + exclusions + implants + NME + additional procedures + excess-LOS + room adjustments.

## 3. ⛔ Blocked / cleanup (N7)
- **Runtime coverage:** applicability 81.5%, runtime-ready 78.7% — but **Non-GIPSA is the big gap** (881/1,447) and **Corporate 0/14**. Never silently borrow another tariff's package rate.
- Immediate fixes: correct 4 delivery packages mis-classed as Medical Management (`GYN5013`); correct 2 SBI-General payer buckets (Corporate→Non-GIPSA, tariff TR240 already right); review 14 name exceptions; resolve 207 possible package-plus-open; reconcile 123 incomplete multi-component amounts; **correct the package-rate source before rate cutover**; rebuild the component resolver on billed codes + tariff-scoped aliases (326 unresolved / 498 ambiguous).
- Decision states, not a Boolean: `single_package` / `multi_package` / `package_plus_percentage_addon` / `package_plus_open_treatment` / `nonpackage` / `pending_authorization_or_review`.

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**N7 does NOT affect our engine.** Our FC Builder reads package price from `fc.package_master` / `fc.v_package_runtime_lookup`, **not** the flagged `v_package_rates_current` view. Live DB spot-check: TR290 TKR = **₹1,49,900 unilateral (ORT5510/5511) / ₹2,24,600 bilateral (ORT5531)** — the *full* commercial amounts (historical band ₹1.35–1.69L), not the halved ~₹79k. So the under-pricing is an upstream project-3 artifact; our package estimates are on the correct base.
Still to do (per-topic, when greenlit): reproduce the combo-rate 21.9% and final/package payer ratios on our 17k history; confirm the 4 delivery-package + 2 SBI payer fixes on our mart.
