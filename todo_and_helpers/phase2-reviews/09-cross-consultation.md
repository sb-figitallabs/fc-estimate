# Review — Cross consultation

**Input reviewed:** `newinps.docx` → "Cross Consultation" tab.
**What this tab decides:** hybrid detect-and-confirm selection; a separate subtotal under Professional Charges; excluded from the surgeon-PF denominator; diet consult is NOT a cross-consult.

## 1. ✅ Matches / safe
- Cross-consults are **already excluded from our surgeon-PF base** (shipped 18-Jul, D3). This tab confirms it.
- **Diet consultation `DIE0001` stays a normal service** (Hospital/Allied), never a cross-consult, never in the PF cap. (Your interpretation, confirmed.)
- **Package rule:** excluded for **GIPSA (96.5%)** and **Non-GIPSA (91.7%)** — charge separately at the applicable doctor visit tariff. Open bills bill normally. This aligns with the hospital position and the data.
- Group under **Professional Charges → Cross Consultations** as a separate component; visit tariffs, not PF %.

## 2. ⚠️ Could worsen currently-verified logic
- **Never auto-include a cross-consult** — that would inflate estimates. Auto-include only when a note/referral explicitly names it (and still show for confirmation); otherwise **suggest-and-confirm**. **(N4)**
- Cap at **one visit / consultant / day** (room or ICU) — not one per LOS day; a room→ICU move doesn't grant two same-day visits.
- Don't classify a different-department doctor as a cross-consult if they're assistant-surgeon / assistant-physician / anaesthetist / DMO / intensivist / ER physician / co-manager. Role must be attached to the line, not inferred from department.

## 3. ⛔ Blocked
- **ICICI / `TR201`** documentation says *included*, but its bills mostly *exclude* (53/78 outside package). Treat as an **agreement-review exception** until the hospital confirms — don't assume inclusion. **(N4)**
- **`v_consultation_rates_current` has `tariff_code` null for all 35,372 rows** — exact automatic pricing isn't safe until a governed tariff-code mapping is supplied; use specialty-level ranges meanwhile (placeholder `CROSS:CARDIOLOGY`, replaced by the real doctor code before billing). **(N4)**

## 4. Validation — ✅ engine check done (21 Jul, read-only)
**Already implemented.** `engine/buildEstimate.js` (D3, 17-Jul) marks `cross_consult` rows, splits them from the PF rows, and prices surgeon PF on the non-cross-consult rows only — i.e. cross-consults are **already excluded from the surgeon-PF base**, and grouped as their own "Cross Consultations" sub. Matches this tab.
Still to do (per-topic): the ~92% outside-package reproduction + GIPSA/Non-GIPSA split; supply the consultation `tariff_code` mapping (**N4**) before exact auto-pricing.
