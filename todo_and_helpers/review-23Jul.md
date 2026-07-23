**1 — ">₹1,000 add-on drop" (your call to validate)**

> On the ">₹1,000 drop" you flagged — it's not a delete, it's a *default-vs-optional* gate, and it's **service items only, not pharmacy**. A service item seen in 75–90% of comparable cases and costing >₹1,000 isn't auto-ticked; it sits in the optional add-ons list. Proposed fix: for that band, **surface it for one-tap confirm / AI-preselect** instead of leaving it buried, and adjust the bucket residual so we don't double-count on top of the P50. 3 confirms before I build it:
> 1. Flip **only the 75–90% & >₹1,000 band** to confirm/preselect (service items only, pharmacy untouched)?
> 2. OK with **residual-adjustment** (move the bucket within P25–P75, never add the full line on top of the P50)?
> 3. Keep the **₹1,000** line and the **75/90%** bounds, or change them?

---

**2 — TR-code fallback research**

> For the TR-code fallback — you were going to research the specific-chip / no-port cases (e.g. no tariff row for a specific implant). Whenever you have it, send it and I'll wire the fallback. Current behaviour is already the safe one: missing insurance rate → cohort-history price with a visible flag, never blanket TR1.

---

**3 — Combos: PF-only or whole procedure?**

> Combos are live (your Q4): factor-adjusted headline — highest treatment 100%, 2nd 50%, 3rd+ 25%; cash never reduces; GIPSA always; Non-GIPSA only same-sitting; old 100% sum kept as reference. One confirm: right now it factors the **whole secondary procedure** (its full P50). Did you mean **PF-only** — i.e. only the secondary procedure's professional fee reduces 50/25, not its implants/pharmacy? PF-only is the standard insurance rule; whole-procedure reduces more. Tell me which and I'll show a before/after.

---

**4 — GIPSA instruments → patient NME (real ₹ change, needs your OK)**

> One number-changing confirm (A1): GIPSA general instruments (OTI0014 / OTI0101 / OTI0018) — should their **amount actually move to the patient as NME**, or just be labelled? Right now I've labelled them `PATIENT_PAYABLE_NME_GIPSA` but haven't moved the ₹. Say yes and I'll move it.

---

**5 — Open-bill lines (biggest unlock — hospital data)**

> Biggest unlock: can we get the **open-bill service + pharmacy line items** exported? Our line-level data today is package-bills only. Those open-bill lines unblock four things at once — NME Phase-2, the full positive-case cohort, the DNB ₹1-share, and outside-LOS pharmacy.

---

**6 — Proposed enhancements (on the 3 things you usually ask)**

You usually ask: (a) does HO support multi-procedure/multi-package fully, (b) are add-on services transported into the estimate, (c) is there a method besides the FC writing procedure + extra services in the note. Here's where we stand + enhancements we can add. **✅ = safe to build now (additive, no number change); ⚠️ = needs your OK (changes numbers/logic).**

**(a) Multi-procedure / multi-package**
> Today: multiple procedures ARE priced (a path per procedure, combined at 100/50/25). Gaps: shared LOS/OT across procedures isn't modelled (upper bound), and combo detection from history is still improving.
> - ✅ **"Add another procedure" in the form** + show the combo math (each at 100/50/25 + the un-reduced reference) — so multi-procedure is an explicit action, not just note-parsing.
> - ✅ **Same-sitting / different-sitting toggle** (Non-GIPSA) so the FC controls whether the reduction applies.
> - ⚠️ **Shared LOS/OT de-duplication** — collapse the shared room-days/OT so a same-sitting combo doesn't double-count. Number-changing → your call (ties to "verify real combos first").

**(b) Add-on services transported into the estimate**
> Today: yes — automatically from cohort history, and explicitly via the new "Add-ons & overlays" input panel.
> - ✅ **Search-by-name pickers** for manual equipment add-ons and high-value pharmacy (instead of typing the service code / item code).
> - ✅ **Show optional add-ons with "seen in X% · ~₹Y"** so the FC can one-tap add them.
> - ⚠️ The **">₹1,000 surface-for-confirm"** (item 1 above) — flip that mid-band from silent-optional to preselect.

**(c) Method besides writing services in the note**
> Today: the FC can also pick the procedure from the dropdown, tick extra services in the "Add-ons & overlays" panel, upload the note as a photo/PDF, or use the semi-manual builder.
> - ✅ **Auto-pre-fill the overlay panel from the note** — the AI already reads the procedure; extend it to also detect the added services (arrived via ER, positive status, cross-consults, transfusion…) and pre-tick them for the FC to confirm (suggest-and-confirm, never silent). This is what you asked for on positive-case ("if written in the notes, auto-select").
> - ✅ **A "here's what we understood" confirm summary** before build (procedure(s) + services detected).

> **Recommended safe set to build now:** search pickers, note→overlay auto-pre-fill, and explicit multi-procedure + combo-math display. Tell me which you want, and the two ⚠️ items (shared-LOS de-dup, >₹1,000 preselect) are yes/no from you.
