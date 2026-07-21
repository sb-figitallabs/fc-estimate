# Review — Blood bank

**Input reviewed:** `newinps.docx` → "Blood Bank" tab (hospital notes + Codex).
**What this tab decides:** three events — reserve → cross-match; issue → component charge (remove that cross-match); transfuse → per-unit charge. History does **not** show cross-match reversal being followed.

## 1. ✅ Safe / follow the documented rule
- Bill **components when issued** (`BLD0024` PRBC 1,360 admissions, `BLD0027` FFP 188, SDP, etc.), **transfusion per unit transfused**, **cross-match on reserve** — cross-match **revoked** once the component for that unit is issued/billed.
- Maintain **unit-level states** (reserved / issued / transfused) to drive the reversal.

## 2. ⚠️ Could worsen currently-verified logic
- History keeps **both** component + cross-match in **99.6%** of cases (1,570/1,577), and cross-match qty = red-cell qty in 1,054. This is **probable double-charging** — do **not** reproduce it. Follow the documented reversal rule and **flag** any actual bill that retains both for the same issued units.

## 3. ⛔ Blocked
- Our dataset has **bill lines but no reservation/issue register** — so at estimate time the unit-level state must be an **FC input** (expected units to reserve / issue / transfuse). Can't derive the reversal automatically from historical lines. **(N3)**
- This rule applies only to the **transfusion service charge** (`EME0088`) and components — it must not suppress blood components, cross-matching *as a distinct service*, blood-bank investigations, processing charges, or products under separate codes.

## 4. Validation we'll run first
Reproduce the 2,379-admission blood cohort and the 99.6% both-charges-retained figure on our data; confirm we can capture reserve/issue/transfuse counts as inputs.
