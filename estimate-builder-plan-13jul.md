# Estimate Builder — Change Plan (from 13-Jul meeting + task PDF + Star-Health message)

Sources: `Subha __ Reyvant (1).pdf` (task list), `i11.md` (13-Jul 11:30 meeting), manager's Star-Health tariff message (13-Jul).
Manager's explicit priority: **"anything number-related is primary, UI is secondary"** — managers verify estimate accuracy over the next 1–3 days.
Process instruction: **do these in-depth on the feature branch; do NOT push straight to production.**

Status legend: 🔴 = blocked on an input · 🟡 = needs a small decision · 🟢 = can start immediately
**Progress markers:** `[.]` = completed (engine items live on the dev test server; HO items on the feature branch; prod promotion after his accuracy pass) · `[~]` = partially done

**Progress update (13-Jul evening):** #1–#6, #8, #9, #11, #12, #13 completed; #10 analysis done (awaiting his answers on the audit); #7 clarified via chat (Simple-form self-sufficiency: LOS/breakdown/OT-hours) and in progress — nothing blocked. Manager's i13 answers actioned: ₹1 tokens stay ✅, robotic suggestion approved & built ✅, TPA free-text confirmed ✅, incl/excl samples approved → bulk rewrite executed ✅.
**A dev test server now exists:** engine `dev` branch auto-deploys to `fc-estimate-dev.figitallabs.com` (same EC2/ALB as prod, second pm2 on :4200) — all engine items are LIVE there for his accuracy pass; prod (`main`) remains untouched per his instruction.

---

## P0 — Number correctness (manager tests these first)

### 1. [.] BUG: ward/room charges not multiplying by LOS — DONE
> **Done 13-Jul (engine `2c7a7e6`):** root cause was deeper than reported — manual LOS/ward/ICU updated the qty display but amounts stayed at P50-days × rate, and `los_manual` alone was silently dropped. All per-day rows now price at selected-days × rate; `los`-only override derives ward = max(0, los − icu); defaults verified byte-identical. Pending engine deploy + his repro to confirm.
- **He saw:** insurance case, ward charge ₹1200/day, LOS 3 days → total not multiplied ("tried FC and 2–3 others").
- **Where:** engine `lineItems.js` (room-charge rows: qty = ward/ICU days × tariff rate) + how a manual LOS override flows into room-row quantities.
- **Plan:** reproduce with an insurance org whose tariff HAS room rates (Aditya Birla TR285), with manual LOS=3 → verify Bed-Charges qty. Suspect: manual `los_manual/ward_manual` not reaching room-row qty, or insurance tariffs with token/absent rates masking the multiplication (overlaps with #3).
- **Extra input needed:** ideally his exact repro (treatment + insurer + room + LOS entered) — a screenshot would pin it in minutes. *Can start without it.*

### 2. [.] Package tariff identical for every room type (and per provider) — DONE (structure); data refresh pending his audit answers
> **Done 13-Jul (engine `cd0702e`, live on dev):** the DB already stored per-room tiers (`room_rates_jsonb`) — the engine just never used them. Packages now price PER ROOM (verified live: Star TKR Bilateral General ₹1,68,698 / Twin ₹1,87,443 / Single ₹2,08,622; scalar fallback when tiers absent). **Data side:** his Excel arrived → full 642-row audit in `excel-vs-db-package-report.md/pdf` — 24% fully match, 67% of tier cells stale/missing (Bajaj ✅, Star near-✅, Medi Assist ×1.18 behind, GIPSA old rate set ×0.90, HDFC absent, ICICI different contract). ⚠️ 13 drifted Star packages now quote stale-lower tiers until the data refresh (tier-wins by design). Awaiting his answers to the report's 9 questions → then the override/reload (#10).
- **He saw:** the package price shows the same for general/twin/single; real MOUs price packages per room tier (and they differ per provider).
- **Where:** `fc` package master (one `package_amount` per tariff+package today) → engine `coverage.js` / `packageBaseFor` → UI compare-rooms package row.
- **Plan (2 stages):** (a) check whether the raw billing/package data actually carries ward-wise package rates — if yes, extend the package master with per-room amounts and use them end-to-end (engine per-room coverage, UI, workbook, settlement); (b) where our data disagrees with his MOU extraction, the Excel becomes the override (see #10).
- **Extra input needed:** **the KIMS Insurance Packages Excel** (he said he'll share; column layout for room tiers). Stage (a) investigation can start now; final numbers blocked on the Excel. He explicitly wants DB-first, Excel-override last.

### 3. [.] Star Health (+ HDFC, Bajaj…) tariffs missing service rates → TR1 fallback — DONE (conservative)
> **Done 13-Jul (engine `2c7a7e6`):** per-item TR1 fallback in `tariffRateLookup` — missing/₹0 org rates filled from TR1, ₹1 tokens preserved, entries flagged `tr1_fallback`. Repairs Star/HDFC/Bajaj bed charges. Manager's ₹1-token decision (Q3) can flip the threshold later; MOU rate sheets remain the long-term fix.
- **Confirmed (my analysis, 13-Jul):** TR287 (Star), TR286 (HDFC), TR289 (Bajaj) have empty/₹0/₹1-token `service_tariff_rate_matrix` rows — even Bed Charges = 0. Aditya Birla (TR285) is the healthy exception. Org→tariff mapping itself works.
- **Plan:** per-item fallback in engine `tariffRateLookup()` — if the org tariff has **no rate or ₹0** for a service, use the TR1 (cash) rate; tag those rows `rate_source: 'TR1 fallback'`; quiet workbench note "N items priced at cash tariff" + a line in the admin Data-source panel.
- **Decisions needed from manager:**
  1. ₹1 token rates — leave as-is (conservative; they usually mean "inside package") or also fall back to TR1?
  2. Confirm fallback rows should be visibly marked (recommended — avoids settlement disputes).
- **Long-term input:** MOU rate sheets loaded into `service_tariff_rate_matrix` for these tariffs (data fix; fallback bridges until then).

### 4. [.] Payor-aware family/reference selection + robotic add-on path — DONE (approved & live on dev)
> **Done 13-Jul (engine `8f9025f` + frontend `26b86cb`):** he approved the suggestion UX in i13. Engine emits `robotic_redirect` when the robotic family has <5 cases for a GIPSA/Non-GIPSA payor and the base family has ≥5 (verified live: GIPSA robotic TKR → 0 robotic vs 248 base cases fires the suggestion); workbench shows the amber one-click "Switch to TKR + robotic add-on" banner (rebuilds base family + robotic=yes) with keep-as-is dismiss.
- **He saw:** GIPSA patient wants Robotic TKR → the "Robotic TKR" family contains only cash cases; GIPSA history prices it as **TKR family + robotic add-on**. The engine should resolve to that path for payors with no cases in the robotic family.
- **Where:** engine `cohort.js`/`payerBasis.js` (family resolution) + existing robotic logic (90 %+ presence → default robotic; <90 % → manual tick adds the robotic tariff charge — partially built already).
- **Plan:** when the selected family has ~0 cases for the target payor AND a sibling base family exists with a robotic add-on signal, either auto-redirect (base family + robotic=yes) or surface a one-click suggestion ("GIPSA prices this as TKR + robotic add-on — switch?"). Verify the robotic service charge actually applies against the org tariff when ticked.
- **Decision needed:** auto-switch silently vs. show the suggestion prompt (recommend prompt — FCs keep control; he said "handle that a bit", not full automation).

### 5. [.] Room charges / LOS auto-population correctness — DONE (verified live on dev)
> **Done:** past-LOS hint + typical placeholders in Simple mode (frontend `cebd872`); correctness delivered by #1 + #3 and **verified live on the dev server** — Star build: Room Charges ₹2,010 → ₹39,770 (typical stay) and manual days multiply (1 × ₹17,800 = ₹17,800).
- **He said:** "room charges should auto-populate properly; LOS and LOS breakdown should auto-populate."
- Largely the intersection of #1 + #3 (once rates exist and multiply, room rows populate). LOS/ward/ICU already auto-derive from cohort P50; verify after #1. Also **PDF item: show past-LOS hint in the Simple input too** (it's only in Detailed today) — small frontend addition, do together.

---

## P1 — The one "most critical" feature: NLP treatment matching

### 6. [.] Free-text → family matching (replace strict-dropdown-only) — DONE (incl. his D&C case)
> **Done 13-Jul (engine `2c7a7e6` + frontend `cebd872`/`26b86cb`):** new `POST /api/lookup/resolve-treatment` (Gemini-ranked top-3, server-grounded against the 170 families, live on dev — "Spine L4 L5 surgery" → Spinal Decompression high) + `TreatmentMatch` strip wired into BOTH input modes on the intake path AND into the dropdowns' zero-hit state (his "dnc dilatation" case: family + package existed but the substring filter missed them — now AI-matched inline with one-click select, 3-char threshold).
- **He said:** *most critical*. FCs type/paste anything ("Spine L4 L5 surgery", "herniated disc") — must map to the right family; the dropdown blocks anyone whose wording isn't in the list.
- **What exists already:** AI intake (admission note → family) matches only EXACT family list; `packages/resolve` endpoint does alias + Gemini ranking for packages. 170 families onboarded.
- **Plan:** new engine endpoint `resolve-treatment` (input: free text → Gemini + family labels + package aliases → ranked candidates w/ confidence); frontend: the family field accepts free text — top match auto-selected with "matched: Lumbar Spinal Fusion (PLIF/TLIF) — change?" + runner-up chips; wire the same resolver into the admission-note intake so unmatched procedure text goes through it instead of failing to a blank.
- **Extra input needed (nice-to-have):** his examples list ("I had provided a list… NLP input") — transcript implies a doc of sample phrases; ask him to share so we can test against it. Not blocking to build.

---

## P2 — Form/data plumbing

### 7. [~] Simple form self-sufficiency (was: "detailed-form carry-over") — CLARIFIED & IN PROGRESS
> **Clarified 13-Jul (chat):** not a data-loss bug — the Simple form must carry the fields FCs otherwise switch to Detailed for: **LOS, LOS breakdown, OT hours**. LOS + ICU breakdown already exist in Simple; **OT hours is a NEW input** (nowhere today) — "default should be there" (blank ⇒ cohort default, typical value shown). **In progress:** stay-stats gains `ot` percentiles; OT-hours input added to BOTH forms with "typically N" placeholder, mapped to the engine's manual-OT controls.

### 8. [.] TPA field in the input form (alongside Insurance Provider) — DONE
> **Done 13-Jul (frontend `cebd872`):** free-text "TPA (if any)" beside the Insurer select in both input modes (insurance only); flows to the saved payload + preview. Upgrades to a dropdown if he supplies a TPA master list (Q5).
- **He said:** "both Insurance Provider and TPA must be in the form" — today TPA is only in the preview's Add-details modal.
- **Plan:** add TPA to the Payor section of both input modes; flows into the saved payload + preview (already displays TPA when set).
- **Decision needed:** free-text or a TPA master list? (Does a TPA master exist in HIS data? If he wants a dropdown, need the list.) Default: free text with recent-values suggestions; upgrade later.

---

## P3 — Patient-facing polish (after numbers)

### 9. [.] Inclusion/exclusion text — AI refactor, patient-facing — DONE (approved; bulk run executed)
> **Done 13-Jul:** samples approved in i13 ("Looks good") → bulk Gemini rewrite executed on the EC2 (`scripts/rewrite-inclusions.js` via the new `maintenance.yml` dispatch workflow; resumable/idempotent; conflicting versions kept as Version A/B behind a DATA FLAG). Two clean columns on `fc.package_master`; engine serves them additively; the patient-facing preview prefers clean text (verified live: TKR already serving the cleaned format). Re-dispatch the workflow any time new packages land.
- **He said:** current text is messy (raw PDF extracts). Refactor via AI into clean customer-facing wording; keep **two columns**: `clean_text` (shown on preview) and the original document text (audit).
- **Plan:** add columns to the package master; one-time batch Gemini pass over all packages; UI prefers clean column, "view original" stays available (we already show variants).
- **Extra input needed:** approve 3–5 sample refactors before the bulk run (quality gate); needs fc-DB write access from wherever we run it.

### 10. [~] KIMS Insurance Packages Excel as override layer — ANALYSIS DONE, awaiting his answers
> **Done 13-Jul:** Excel received → full 642-row audit delivered (`excel-vs-db-package-report.md` + PDF for forwarding) — exactly the "how many times is it wrong" step he wanted first. Includes a versioned `package_room_rate` schema recommendation and 9 questions (GIPSA ×0.90 factor, ICICI contract identity, Star TR176-vs-TR287, …). **Remaining:** his answers → then build the override/reload ETL per insurer.

### 11. [.] Disclaimers on the FC estimate (preview/PDF) — DONE
> **Done 13-Jul (frontend `cebd872`):** input received (Old Financial Councellings scans) — 6-line Terms & Disclaimers block lifted near-verbatim from the printed FC footer (LOS/complications, estimate-not-final-bill, insurer/TPA discretion + rejection liability, 80% advance, refund rules, Sec 269ST cash cap), translation-wired, placed before the signature block.
- **He said:** copy the disclaimers from an existing/old KIMS FC document (insurance liability, pre-authorization, LOS-based variance, "information shared based on…").
- **Plan:** disclaimers block above the signatures on the preview/PDF, included in translations.
- **Extra input needed:** **a sample of the current/old FC printout** — he said "if you have an old FC lying around". We don't have one in the repo. *Blocked until someone shares a photo/scan.*

### 12. [.] Logo → KIMS Gachibowli — DONE
> **Done 13-Jul (frontend `cebd872`):** asset received and applied — estimate/PDF header now uses the Gachibowli logo with the "KIMS Hospitals / Gachibowli" wordmark (app sidebar untouched).
- Swap `/logo.jpg` on the preview/PDF for the Gachibowli-specific logo.
- **Extra input needed:** the Gachibowli logo asset (PNG/SVG). *Blocked.*

### 13. [.] Hide zero rows / "when ICU not present don't add zeros" — DONE
> **Done 13-Jul (frontend `cebd872`):** "0 ICU" fragments, ₹0 claimable/deposit rows and ₹0 alt-room deltas suppressed on the patient-facing preview (OOP box kept — ₹0 there is meaningful).
- He explicitly deprioritized ("ignore for now"). Small display filter (hide ₹0 stay/ICU fragments and empty buckets on preview + workbench). Do in the same pass as #9/#11.

---

## Deferred by the manager (do NOT start)
- **Estimated non-medical expenses rework** — "we will handle non-medical once, but later."
- **Reference-basis rework beyond the robotic case** — "ignore it for now… I couldn't get clarity" (only the robotic path in #4 is in scope).
- **Proportionate deduction for room-linked services (nursing etc.)** — from the 10-Jul review; he will document the exact logic and send it. Still pending.

## Carry-over open items (pre-existing, still waiting)
- `fc.service_item_mapping` 'remove' markers (bed-charges/suite/oxygen rows still offered as add-ons — engine filter deployed, data fix pending).
- Data quirks to include in his cleanup: MSC0900 "IP PHARMACY CHARGES" (₹50k historic vs ₹10 tariff), HBsAG-GENERAL missing rates on some org tariffs (subsumed by #3).

---

## Inputs still needed from the manager (see `inputs-needed-from-manager.md`)
| Item | Input |
|---|---|
| MOU rate sheets (Star/HDFC/Bajaj) | long-term fix behind the TR1 fallback — whenever available |
| Excel audit answers | the report's 9 questions (GIPSA ×0.90, ICICI contract, Star tariff code, …) → drives the #10 override/reload |
| PF on insurance open billing (NEW) | non-package insurance estimates show Professional Fees ₹0 (pre-existing engine rule) — include PF like cash? |
| TPA master list | field stays free-text until it arrives |
| Proportionate-deduction logic | his documented spec (deferred item, still pending) |

## Execution status — ALL WAVES COMPLETE
1. **Wave 1:** [.] #1 LOS fix · [.] #3 TR1 fallback (+visible "cash rate" marking) · [.] #5 verified live · [.] #4 robotic suggestion
2. **Wave 2:** [.] #6 NLP (endpoint + intake path + dropdown zero-hit) · [.] #8 TPA · [.] #2 per-room package pricing
3. **Wave 3 (UI):** [.] #9 bulk rewrite executed · [.] #11 disclaimers · [.] #12 Gachibowli logo (asset fix incl.) · [.] #13 zero-hiding
4. **Last:** [~] #10 — audit delivered, override ETL awaits his answers

**Where everything sits (13-Jul evening):**
- **fc-estimate `dev` @ `cd0702e`** → auto-deployed & verified on `fc-estimate-dev.figitallabs.com` (LOS fix, TR1 fallback + row flags, resolve-treatment, robotic_redirect, per-room packages, clean incl/excl). Prod `main` untouched.
- **Hospital_OS `feat/estimate-builder-v3` @ `b1e6caa`** (local app points at the dev engine) — NOT merged to dev/main yet.
- **Promotion path once he verifies accuracy on dev:** engine `dev` → `main`; HO feature → `dev` → `main`.
**Still open:** #7 (his example) + manager-input table above + the deferred items below.
