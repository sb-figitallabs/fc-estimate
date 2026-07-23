# FC Estimate Builder — Next-Actions Plan (2026-07-23)

Sources: the **23-Jul manager meeting** (3.7 min), the **manager-reviewed T1–T28 doc** (221K chars, read in full — decision extract in `manager-review-extract-23jul.md`), and the **frontend overlay-input gap** the manager hit in person.

**Process gate (manager's explicit ask):** *"pehle changes kar lo, phir final review karenge"* + *"AI se ek baar review kara ke phir implement karna better rahega."* → Nothing below is implemented yet. This is the plan to approve first; each engine change gets an AI re-review before it ships. Guiding principle (manager comment #6): **"important. keeps the tool simple."**

---

## STATUS (2026-07-23, end of session)
- **0A DONE + ON PROD** — overlay input UI on HO v3 form; verified e2e; promoted dev→main (HO `420b7b4`).
- **0B DONE + ON PROD** — emergency-token resolution fixed; verified live ("emergency craniectomy"→craniectomy); promoted to engine `main` (`570816e`).
- **0C DONE (awaiting manager)** — `explainer-1000-drop-rule.md` written; 3 questions for the manager; NOT implemented (his gate).
- **0D (awaiting manager)** — cohort-history flag correct; `missing-tariff-codes-per-TR.md` ready for hospital; awaiting his chip/no-port research.
- **GIPSA LOS ingestion DONE + ON PROD** — migration 004 applied (220 rows ward/ICU split), `withPackageLos()` wired, T10 per-setting-ledger verified (ORT5510 ward=3/icu=1), sanity 24/0+12/0, promoted to engine `main`.
- **Phase 1 = BUILT + VERIFIED (2026-07-23 end):** factor-adjusted combos ALREADY implemented (flow2.service.js:181-203 — 100/50/25, cash-never, GIPSA-always, Non-GIPSA-same-sitting, unadjusted_reference; factors the WHOLE path gross, not PF-only → manager confirm). T16 tax ✅ (5% non-ICU>5k full, ICU/NICU/HDU exempt, by-code, separate line, attendant off). T20 pharmacy ✅ (ladder user→sale→MRP→P50-flag, UOM, replace_family_baseline). T5 DNB ✅ (four-value metadata, FC shows only patient_payable, fc_hidden). T1 insurance PF ✅ (final-bill 35/25/35/25; cash LAN 25/15/25/25). "Remove GIPSA warning" = no-op. **Nothing to build in Phase 1** — only the combo PF-vs-whole confirm is open.
- **Phase 2/3**: not started (N8 rebuild, medical-mgmt/chemo semi-manual builders, template consolidation, N10/N11; held: A1, C1 open-bill lines, emergency-OT, hospital codes).

---

## PHASE 0 — The manager's live asks (do first)

### 0A. Wire overlay INPUT controls into the HO v3 estimate form  ← the #1 gap
**Why:** In the meeting the manager tried to build emergency/positive/etc. cases himself, **couldn't find where to enter them**, typed "emergency craniectomy" as the treatment, and it broke. The engine accepts all these controls; the HO form's `buildRequest` doesn't send them and there's no UI for them. Display is already shipped (`OverlaySection`, live on prod). This is the authoring half.
**Approved by:** doc Cross-Cutting §5 (Section D) — engine returns structured `estimate.*`; "UI must render" the emergency workflow, positive-case toggle, cross-consult picker, newborn picker, chemo form, labour-hours, GST line, blood-bank add-on, DNB, outside-LOS, medical-mgmt picker. Manager: *"Looks good."*
**Build:** add controls to `V3Inputs` + `buildRequest` + the Inputs/Advanced UI in `frontend/src/modules/estimate-builder-v3/`:
- Emergency: "Arrived via ER?" + ER-physician / initial-assessment / emergency-bed toggles (opt-in; ER-physician auto-on only when arrived-via-ER).
- Positive-case: single "Positive case?" toggle → status (HBsAg/HCV/HIV) + surgery-context; auto-select if in doctor's notes.
- Cross-consult: department + visits picker (placeholder-dept).
- Blood: transfusion yes/no (+ optional units).
- Attendant room: off by default, flag when selected.
- (Then newborn pathway, chemo regimen form, labour hours, medical-mgmt family/setting, manual add-ons, pharmacy high-value selection.)
**Decision needed:** full input UI for all 14 overlays, or a **first cut for the 5 the manager named** (emergency, positive, cross-consult, blood, attendant) then iterate. → *recommend first-cut-of-5, ship, then extend.*

### 0B. Fix "emergency <procedure>" procedure resolution
**Why:** Manager wrote "emergency craniectomy"; the resolver failed to match craniectomy because the "emergency" token was present.
**Fix:** treat "emergency" (and similar admission-context words) as a **modifier stripped before family matching**, not part of the treatment string — consistent with T3 (emergency = billing overlay on Treatment A, never part of the procedure identity). Re-test the exact case after the emergency-resolution changes already in flight (manager expects it may already resolve post-change → verify).
**Note:** engine AI is now `gemini-3.1-pro-preview`, temp changed (already done) — re-run resolution against it.

### 0C. ">₹1000 silent-drop" rule — explain + design the fix (implement on OK)
**Why:** Manager's repeated concern; still marked *"need more info to validate."* Live in `engine/services.js:75-76`: a **75–90%-present non-pharmacy service item costing >₹1,000 is silently excluded** from defaults.
**Action now:** send the manager a plain-language explainer + the proposed behavior; **do not flip silently.** Approved-in-principle correction (D2): **surface-for-confirm / AI-preselect**, and **never add the selected line's full amount on top of the historical P50 bucket — adjust the residual** (move toward P25–P75 or replace part of the bucket) to avoid double-count. Applies to **service items only, NOT routine pharmacy.**

### 0D. TR-code fallback — visibility + await manager's research
Already the approved behavior (B7): insurance missing-rate → **cohort-history price with a visible "based on billed history" flag**, never blanket TR1 (TR1 = flagged last-resort, cash only); ₹1/₹10 placeholder guard (`PLACEHOLDER_PRICE_MAX=1000`). **Action:** ensure the historic-cohort flag is actually surfaced in the UI; hand `missing-tariff-codes-per-TR.md` to the hospital; await the manager's Codex research on specific-chip/no-port fallbacks.

---

## PHASE 1 — Approved engine changes (re-review, then ship). Most modules already exist on `dev`; this is **apply-corrections + verify-against-final-decisions**, plus the few new ones.

**Corrections to already-built modules (manager overrode the original):**
- **T1** — remove the GIPSA combo `PROVISIONAL_POLICY` **warning** (*"No warning. This is the right rule."*). Confirm **insurance PF uses final-bill % (open 35/25/35/25; package GIPSA 20% / Non-GIPSA 25% of tariff-dataset package amount)**; historic P50 = reference only. Combos → **factor-adjusted headline** (100/50/25), keep old sum as `unadjusted_reference`; cash never reduces; Non-GIPSA same-sitting only.
- **T16** — GST as a **separate line** (A2 confirmed), full room-rent amount >₹5k/day, ICU/NICU/**HDU** exempt (HDU assumed untaxed for now); attendant room off-by-default flag.
- **T20** — keep the **lean** version: routine pharmacy unchanged (existing high-contributor method); add only high-value selection with source-mapped rate ladder (user→sale→MRP→P50-flagged), UOM dropdown, `replace_family_baseline` (no double-count).
- **T5** — UI shows **covered/non-covered only**; four-value model stays metadata; **hide items where denial doesn't touch the patient**; drug-admin/NME concern is moot on insurance.

**Verify-as-shipped (manager approved as built):** T3 emergency components (ER-physician D000806 ₹1,000 flagged, EME5060 ₹3,000 insurance-default-on, EME0065 ₹1,310 opt-in; **never infer/auto-apply emergency codes**; OT-E held); T4 positive-case (**OT surcharge +50%/+100% standard for GIPSA & Non-GIPSA, no MOU**; RNS0123 by context; HIV HSP5020-24); T9 cross-consult (**placeholder-DEPARTMENT by TR code**, one visit/consultant/day, TR201 excluded); T10 outside-LOS (**package PF never recomputed**; total-LOS fallback when no ward/ICU split; drug-admin on excess pharmacy = cash only); T15 labour (0–4h default, ROM0121 ₹9,900 / ROM5166 ₹15,000); T6 newborn (4 pathways, NICU days from ROM5015, 4 cash packages); T28 specific-over-broad (label broad `fallback_only`, package price from exact identity only).

**New / approved but not built:** T24 **N9 governed AI optional-item suggestion layer** (AI may only pick from approved candidates — no new codes/rates/PF/GST) + **doctor-input contract** (source-span provenance, confidence, field-level override) — both got explicit *"Go ahead."*

---

## PHASE 2 — Validate-first larger items (prove upside before cutover)
- **T21 N8 simplified rebuild** — manager/Codex endorsed the leaner 4-level evidence hierarchy (final billed package codes = commercial truth; exact positive billed procedure codes = clinical truth; absence ≠ not-performed; reject sentinel/cross-dept; review only genuine conflicts). Don't hand-inspect all 756 multi-treatment admissions.
- **T11 medical-mgmt** + **T13 chemo** — build the **semi-manual FC builder** fallback (auto-add calculable fields: room/PF/drug-admin by LOS+logic; user manually enters pharmacy + high-value drugs/regimen). Chemo triggers a structured regimen form; "therapy drug cost pending" when unknown; prior cycle repriced, never copied.
- **T24 template consolidation** (244→117) — **report-only mode first, prove routing/estimate parity, then cutover.**
- **T25 N10 / T26 N11** pharmacy & non-pharmacy reclassification — data-layer corrections (166 primary-class changes, split fields, quarantine review items; move "Remove/Needed" labels to a field; F&B explicit-exclude; service-tariff single-primary if all investigation items present).

---

## PHASE 3 — Held / awaiting external input (do NOT implement)
- **C1 open-bill service + pharmacy lines** — the single biggest unlock (NME Phase-2, full positive-case cohort, DNB ₹1-share, outside-LOS pharmacy). Manager: *"need more info."*
- **A1** GIPSA general instruments (OTI0014/0101/0018) → move amount to patient NME — **held, needs explicit confirm** (real number change; currently labelled only).
- Hospital-pending codes: ICU-isolation (C3), cradle (C4), labour slot→code (C5), attendant SAC/HDU (C6), manual-addon masters (C10), missing tariff codes (C11).
- **Emergency-OT** validation (A3/C2 — 0 historical occurrences; `ACTIVE_POLICY` held).
- Blood-bank 99.6% double-charge (C9) — ignore until hospital validates. **Note: T17 blood-bank is the one module built but not yet pushed — push after 0A.**

---

## Sequencing recommendation
1. **Phase 0A (input UI, first-cut-of-5) + 0B (emergency resolution)** — unblocks the manager testing overlays himself. Ship to dev, demo.
2. **0C explainer + 0D visibility** — async with the manager.
3. **Phase 1 corrections** (T1/T16/T20/T5) — quick, high-confidence; AI re-review each; ship.
4. **Phase 1 new** (T24 N9 + doctor-input contract).
5. **Phase 2** validate-first items, one at a time.
6. Phase 3 stays parked on the manager/hospital.
