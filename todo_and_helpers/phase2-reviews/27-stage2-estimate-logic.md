# Review — FC Estimate Builder stage-2 logic

**Input reviewed:** `newinps_updated2.docx` → "FC Estimate Builder stage 2 logic" tab (the whole estimate-building approach: pharmacy IP/OT split, service grouping, threshold add-ons, how the number is built).
**What this tab decides:** whether our estimation logic is sound. Verdict: **the architecture is validated** — with a few concrete fixes and a long-term direction.

## 1. ✅ Endorsed — our approach is right
- The doc explicitly says the **overall approach is correct** and our engine "already implements much of the first two layers well."
- **Gross P50 + bucket-share allocation** is called "statistically sounder than adding the independent P50 of each bucket" — i.e. our headline method is the correct safety anchor. ✅
- **Package construction** (base + separately-billable exclusions + verified modifiers + outside-LOS + tax, *without* adding package-included utilization to the base) — "that is correct." ✅
- **Mixed-route / multi-treatment** uses the combined-admission historical total rather than summing unrelated medians — "the right approach." ✅
- Pharmacy split (IP/OT × drugs/consumables/implants + per-day) is "appropriate"; presence bands (>90 default / 75–90 confirm / 25–75 optional / <25 manual) endorsed.

## 2. ⚠️ Could worsen currently-verified logic
- **The ">₹1000 optional item gets dropped" rule is bad** — a 75–90%-present item worth >₹1,000 should never silently disappear; show a prominent confirm ("seen in 82% of comparable cases; est. ₹X — confirm"). ✅ **engine-check: this rule IS in our engine** (below) → a real thing to change.
- **Double-count is the top risk set:** adding deterministic lines on top of a P50 that already contains them; adding package-included utilization to the base; adding **both** an item and its group residual; applying IP-per-day logic to OT pharmacy; scaling fixed procedure/OT/implant costs by LOS; removing an implant from general pharmacy before adding the selected one. Our current P50+allocation model mostly avoids these — but the long-term **deterministic-components + historical-residual** method must be adopted *family-by-family after backtest*, never bulk (else it flips verified numbers).
- Don't sum independent bucket P25/P75 for the range (ignores correlation) — our engine already calibrates at admission level; keep it.

## 3. ⛔ Not-yet-built (direction, N12)
- **General add-on compiler** — `explicit_addons` exists in the contract but only **robotic** is well-developed; emergency/isolation/blood/cross-consult/labour/attendant/newborn/implant add-ons need the compiler.
- **Insurer-vs-patient allocation stage** — coverage fields exist but the gross→(package allowable / insurer-payable / copay / deductible / sublimit / NME / DNB / patient-payable / deposit) split isn't fully implemented. "Never mix expected hospital bill and expected patient-payable."
- Certification reality: **3 of 14 estimable scenarios pass the financial gates (227/1,280 admissions); 0 fully certified** (routing lacks domain approval). Architecture strong, not production-certified hospital-wide.

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**Confirmed the ">₹1000-drop" rule is live in our engine:** `engine/services.js` includes an add-on only when `case_presence_rate > 90 || (case_presence_rate >= 75 && amount_cash_typical <= 1000)` — so a 75–90%-present add-on worth **more than ₹1,000 is excluded from the defaults** exactly as the doc warns. Recommend changing it to *surface for confirmation* rather than drop. Everything else (P50+bucket allocation, admission-level range) matches the endorsed design.
Still to do (per-topic): audit for deterministic-on-top double counting before any family moves to the residual method.
