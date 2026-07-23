# The ">₹1,000 drop" — what it actually does, and the proposed fix

**For:** manager review (his repeated concern from the 23-Jul call).
**TL;DR:** nothing is *deleted*. The rule decides which service add-ons are **pre-ticked in the default estimate** vs. shown as **optional (un-ticked) add-ons** the FC can add in one click. The concern is real for one band, and the fix is to make that band *prompt* instead of sit quietly in the optional list.

## The rule, exactly (`engine/services.js:73-76`)
A cleaned **service** row is auto-included in the default estimate when:

| Case-presence in comparable admissions | Item cost | Auto-added to default? |
|---|---|---|
| **> 90%** | any amount | ✅ yes |
| **75–90%** | **≤ ₹1,000** | ✅ yes |
| **75–90%** | **> ₹1,000** | ❌ **no — goes to *optional* add-ons** |
| 25–75% | any | optional |
| < 25% | any | not surfaced by default |

So the "drop" is really: *a service item seen in 75–90% of similar cases and costing more than ₹1,000 is not pre-ticked — it's parked in the optional add-ons list.* The FC can still add it; it just isn't in the headline number automatically.

**Two things to be clear about:**
1. **It's service items only, not pharmacy.** This gate runs on the cleaned *service* rows (`cleanServiceRows` → `splitCleanedRows`). Routine pharmacy and high-value pharmacy selection are separate paths and are **not** governed by this rule. (Your call in the meeting — "pharmacy items optional add-ons mein aate hain" — those come through the pharmacy path, not this one.)
2. **Nothing is lost — it's a default-vs-optional decision**, not a deletion.

## Why the 75–90% / >₹1,000 band is the real concern
- **> 90%** items are almost always present → safe to auto-add. ✔
- **≤ ₹1,000** items are small → auto-adding a cheap, fairly-common item barely moves the estimate and is safe. ✔
- **75–90% & > ₹1,000** is the awkward middle: common enough to matter, expensive enough that leaving it un-ticked can **under-state** the estimate — and it's easy for the FC to miss it in a long optional list. That's the leak you flagged.

## Proposed fix (doc D2 — for your sign-off; NOT shipped)
For the **75–90% & > ₹1,000** service band, change *silent optional* → **surface-for-confirm / AI-preselect**:
- Show it prominently: *"Seen in 82% of comparable cases · est. ₹X — include?"* — pre-selected or one-tap confirm, not buried.
- **Crucial anti-double-count rule:** when it's included, **do not add its full amount on top of the historical P50 bucket.** The P50 already reflects a mix of cases where this item was and wasn't billed — so we adjust the residual (move the bucket toward the right point between P25–P75, or replace part of the historical share) instead of stacking the full line on top. *"Never add a selected line on top of a historical bucket without residual adjustment."*
- Unchanged: > 90% still auto; ≤ ₹1,000 still auto; < 25% still not surfaced; routine pharmacy untouched.

## What we need from you
1. Confirm the band that should flip to *confirm/preselect* (we propose exactly **75–90% & > ₹1,000**, service items only).
2. Confirm the anti-double-count approach (residual adjustment, not additive-on-top-of-P50).
3. Any threshold change (the ₹1,000 line, or the 75/90% bounds)?

On your OK we implement it behind a single flag and re-review before it ships.
