# Review — Chemotherapy

**Input reviewed:** `newinps.docx` → "Chemo" tab.
**What this tab decides:** a dedicated systemic-therapy estimation engine — the drug/dose/brand/vial count explains most of the bill; default open-bill daycare; price from the exact regimen at current prices.

## 1. ✅ Safe / important
- **Default routine chemo to open-bill daycare** — none of 1,210 chemo/immunotherapy admissions were packages. Five routes: routine cytotoxic / immunotherapy-targeted / supportive-infusion-only / planned-inpatient / high-dose-BMT.
- **Prior same-patient, same-regimen cycle is the best anchor** (median bill change 5.4%; immunotherapy 2.4%) — but **rebuild at current prices, never copy** (reprice drugs + services, apply new dose/vial count, show what changed).
- Pharmacy dominates (0.97–0.99 correlation with the bill). Collect **structured** regimen/dose/vial/brand/cycle/access — the builder must **not** clinically compute the dose (height/weight/BSA are context only; dose comes from the treating team).
- Separate supportive infusions (hydration, iron, bisphosphonate, growth factor, transfusion) from chemotherapy; chemoport insertion is a separate component, never hidden in the administration basket.

## 2. ⚠️ Could worsen currently-verified logic
- **Never present a generic "chemotherapy" total** — the same label ranges ₹20k to several lakh (Paclitaxel ₹22k vs Atezolizumab+Bevacizumab ₹538k). If drug/dose is unknown, show base daycare + PF + "**therapy drug cost pending**", clearly low-confidence — not a reliable final estimate.

## 3. ⛔ Blocked
- **6,132 of 11,254 pharmacy items have no current price** (all 3,624 observed-only items included; e.g. high-value ENHERTU `ENHI02`). No silent zero — show last observed price as provisional and require confirmation. **(N3)**
- Needs a governed **systemic-therapy drug/regimen master** (code, molecule, brand, strength, aliases, class) and the **patient/UMR key for prior-cycle retrieval** (absent from the current reference snapshot; read from original `fc_clean`).

## 4. Validation we'll run first
Reproduce the routine-chemo daycare medians by payer and the regimen-median table on our data; audit our pharmacy-price coverage for the high-value oncology drugs before enabling regimen pricing.
