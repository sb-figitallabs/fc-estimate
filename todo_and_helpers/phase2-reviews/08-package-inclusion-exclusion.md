# Review — Package inclusion / exclusion

**Input reviewed:** `newinps.docx` → "Pkg Inclusion/Exclusion Bill Analysis" tab.
**What this tab decides:** how the builder handles what a package absorbs vs bills extra — and whether a hidden pharmacy/investigation threshold exists (it doesn't).

## 1. ✅ Strongly aligns with our engine
- **Start from the governed package rate and add only source-supported extras** — never reconstruct the package by subtracting includes from a detailed gross until you reach the price. This is already our approach; the doc explicitly endorses it as the most important design rule.
- The "threshold" you observed is a **reconciliation residual**, not a contractual cap: `gross = package + defined-exclusions + undefined-exclusions + NME` reconciles to ₹0 in all 1,283 cash cases. `UNDEFINED_EXCLUDES` is a balancing field.
- Keep **four independent decisions per item**: package-inclusion / outside-package-billable / insurer-admissible / patient-collectable. Explicit **cash caps are real and honoured** (CAG ₹5k, PTCA ₹5k+₹10k, neonatal ₹2.5k — the ones we ingested).

## 2. ⚠️ Could worsen currently-verified logic
- Do **not** invent a GIPSA/Non-GIPSA pharmacy or investigation cap from historical exclusion frequency. GIPSA default is **all-inclusive**; historical "excluded" lines must **not** auto-become patient-payable (they may be internal allocation, implant carve-outs, non-admissibility or pending approvals).
- "Above pharmacy limit" with **no number** → `rule_status = cap_amount_missing`, `runtime_action = conditional_extra`; show a labelled historical contingency, never an invented figure.
- Unused capacity in one component (room/OT/pharmacy/investigation) **cannot offset** another's overage.
- Non-GIPSA is not one rule — resolve `organization → agreement/tariff → package → rule` (Star ≠ ICICI ≠ Bajaj ≠ Medi Assist).

## 3. ⛔ Blocked / new work
- **N2 — package rule schema.** Approve `rule_action` (`included` / `excluded_billable` / `excluded_not_collectable` / `included_up_to_amount` / `…_quantity` / `…_days` / `conditional_approval` / `do_not_bill` / `unresolved`) + `limit_bucket` (`ip_pharmacy` / `ot_pharmacy` / `cath_pharmacy` / `investigation` / `ot_time` / `ward_days` / `icu_days` / `blood_units` / `implant` / `equipment`) + the runtime resolution hierarchy.
- **Data not runtime-ready:** only **114 cash + 45 Non-GIPSA rows are runtime-ready; 0 GIPSA** — universal package compilation isn't possible yet. Line-level included/excluded amounts also currently mis-reconcile (a line can carry both In- and Ex-quantity); use exclusion *frequency* + header totals, not line totals, until fixed.

## 4. Validation we'll run first
Reproduce the cash reconciliation-to-₹0 and the pharmacy/investigation exclusion-frequency tables on our data; confirm our runtime-ready package counts match.
