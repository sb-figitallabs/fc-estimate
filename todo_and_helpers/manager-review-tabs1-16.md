# FC Estimate Builder — Manager Review: Open Confirmations & Decisions (Tabs 1–16)

**Purpose:** everything from Tabs 1–16 that needs your input to proceed — decisions that change numbers, interpretations to confirm, and data/codes pending from the hospital/Finance. Grouped so you can go through it in one pass and reply inline.

**Status of the build:** all 16 tabs are implemented and deployed to **dev** (fc-estimate). Every module is **additive** — it does not change any previously verified estimate number (sanity 24/0 + 12/0 on every tab). The items below are what would let us move from "policy-first / interim" to "confirmed", or unblock the held pieces.

---

## A. Decisions that change numbers or need your explicit go-ahead

| # | Tab | Item | What we did (interim) | What we need from you |
|---|-----|------|-----------------------|-----------------------|
| A1 | 5 — DNB | **GIPSA general-instruments as patient NME.** Your spec says general instruments (OTI0014/0101/0018) are patient-payable NME for GIPSA. | We **label** the line `PATIENT_PAYABLE_NME_GIPSA` in metadata but **do NOT move the amount** to the patient (that changes verified insurance totals). | Confirm we should actually move the GIPSA general-instrument amount onto the patient (real number change), or keep it as a label only. |
| A2 | 16 — Tax | **Where GST sits.** 5% room-rent GST is computed. | We show it as a **separate "GST on room rent @ 5%" line**, NOT rolled into the headline total (to preserve parity). | Confirm: keep GST as a separate line, or roll it into the patient-payable headline too? |
| A3 | 3 — Emergency | **ER-physician price.** D000806 has **no tariff row** — only history. | Priced from the validated history median **₹1,000**. | Confirm ₹1,000 as the ER-physician reference (or supply a tariff rate). |
| A4 | 2 — NME | **International open-bill outlier.** The global International/open-bill cohort P50 is **₹150,409 from only 2 positive cases** (prob 0.6%, so it rarely triggers). | Left as-is (rarely used; falls back). | OK to winsorize/quarantine tiny-sample extremes, or leave it? |

---

## B. Interpretations / approaches to confirm (my judgment calls)

| # | Tab | Item | My interpretation / recommendation | Confirm? |
|---|-----|------|-----------------------------------|----------|
| B1 | 8 — Pkg Incl/Excl | You said "need more info" on 4 points. | I clarified them: (1) "above pharmacy limit, no number" → show a labelled **historical contingency**, never invent a cap; (2) **unused ward capacity can't offset ICU overage** (each included bucket is independent); (3) **Non-GIPSA = resolve org→agreement→package→rule** (Star≠ICICI≠Bajaj); (4) data-readiness is **now much better** (176 cash + 570 Non-GIPSA + 259 GIPSA runtime-ready vs the doc's 114/45/0). **N2 heavy schema NOT built** — your instinct was right, the four-status coverage model already covers it. | Confirm these clarifications + that we skip N2. |
| B2 | 11 — Medical Mgmt | You said "need more info" on **"the 28-admission general-medical template is not universal."** | It means: our current *generic* medical-management template was built from only 28 cash admissions, so it must **not** be used as the default estimate for every medical case. We instead route by **family × setting** and fall back to the **semi-manual builder** when there's no strong template — so the 28-case template is never the universal answer. | Confirm this is the intended behaviour. |
| B3 | 12 — Daycare | You asked "do you also need the non-strict daycare cases?" | Recommendation: for the **estimate** (forward-looking, strict-daycare default), **no** — non-strict (extended/cross-midnight) cases are only **extension/conversion evidence**, not part of the base strict-daycare estimate. We model on strict and use the rest only for the conversion contingency. | Confirm we can leave non-strict out of the core estimate. |
| B4 | 13 — Chemo | You asked to first validate "are chemo FC estimates even created?" | **Validated from the FC data: yes** — 1,624 chemo/oncology admissions have an FC counselled amount (P50 ₹44.5k, range ₹27k–₹627k), and the Procedure Name is mostly blank (no structured regimen field today). So the conservative chemo shell (base daycare+PF + structured user drug input + separate form) is warranted. | Confirm we proceed with the conservative shell; the deep work stays held (see C). |
| B5 | 15 — Labour room | You asked "thoughts on 0-4 as default?" | Agreed — defaulting to the 0-4h slot means labour-room charge is **off unless the FC projects ≥4h**, matching the hospital's "auto-bill at ≥4h" without over-charging at estimate time. | Confirm the 0-4h default. |
| B6 | 17 — Blood bank | You said FC should "only decide if transfusion is needed or not, not units — unless significant impact." | Built minimal: a **transfusion yes/no** doctor-inputted flag → transfusion service (EME0088) + 1 component (PRBC default). **No unit-states / reversal.** Units default to 1; the doctor can override for a significant count. | Confirm this minimal shape (transfusion flag + optional units). |
| B7 | 19 — Tariff fallback | You asked **"what to use instead of a TR1 fallback?"** (leaning to "use TR1 for now, diff is small"). | **We already do better than a blanket TR1 fallback**, and don't leave anything blank: our engine prices line items from **cohort HISTORY** (what these cases actually billed — `amount_cash_typical`, quartiles), not raw TR1 rates. TR1 is only a **flagged last-resort for cash**. So for insurance with a missing exact rate, we use the historical billed amount (more accurate than TR1) + a "rate not in tariff, based on billed history" flag. **Recommend: keep this; don't switch to blanket TR1.** | Confirm we keep cohort-history (not blanket TR1). |
| B8 | 19 — Tariff fallback | You asked (service vs investigation, 386 conflicts) **"use service tariff as primary — your thoughts?"** | Agreed as the **default**, with one guard: flag the **386 conflicting codes for per-code review** rather than silently taking service everywhere (a few may legitimately be the investigation rate). Governed precedence per code/tariff/period; `rate_domain` stays *evidence*, not identity. | Confirm service-primary + per-code review of the 386. |
| B9 | 19 — Tariff fallback | You asked the **7-step hierarchy: "packages or items?"** and flagged **median-of-room** ("need info"). | Two separate things: the **7-step hierarchy is for ITEMS** (service-line pricing), the **stricter package fallback is for PACKAGES** — both are already handled (items → cohort history; packages → never Non-GIPSA→Cash, never borrow another org, PLACEHOLDER guard). **Median-of-room:** when a code has different rates per room type, never average across rooms — require the room category. Our `rateOf` is already **room-specific** (no median-of-room). | Confirm (mostly FYI — already handled). |
| B10 | 27 — Stage-2 logic | You asked (pharmacy) **"we use context to pick a value between P25–P75, no item-level drill-down — do you agree?"** | **Yes, agreed** — that's exactly our engine: pharmacy is estimated from cohort P25/P50/P75 (context/controls pick within the band), not item-by-item. Item-level only for the specific high-value selections (T20). | Confirm (already how we work). |
| B11 | 28 — Treatment review | You wanted clarity on **"never let a broad cohort supply a package price (code+payer+room+date only)."** | It means a **package** price must come from the **exact package identity** — `package_code + payer/tariff + room + effective date` in the package master — **never** by averaging a broad treatment cohort's historical bills. Our engine already does exactly this (lookup priority tariff+package_code → package_name → alias, room-specific). A broad cohort (e.g., "arthroscopic surgery" in general) only informs the **open-bill** range/confidence, never a package price. | Confirm (already how we work). |

---

## C. Data / codes pending from the hospital or Finance (you said you'd ask)

| # | Tab | Missing data | Interim handling |
|---|-----|--------------|------------------|
| C1 | **Cross-cutting** | **Open-bill service lines + pharmacy lines** (ingestion-guide §9). Our line-level table is package-bill only (4,906 IPs); the 12,033 open-bill admissions have no line detail. | Blocks **NME Phase-2**, the **full positive-case cohort (67 of ~124 visible)**, the **DNB ₹1-share**, and exact **outside-LOS pharmacy/investigation** figures. Everything is built policy-first meanwhile. **One export unblocks all four.** |
| C2 | 3 — Emergency | Emergency-OT has **0 historical occurrences** to validate; package emergency-% needs a per-org agreement table; public-holiday calendar owner. | Emergency-OT marked `ACTIVE_POLICY` (not history-validated); package-% flagged `requires_agreement`; no holiday auto-apply. |
| C3 | 4 — Positive cases | Blocked #1 ICU-isolation service code; #2 rates effective date; #3 MSC2816 (₹10 placeholder vs ₹10k/₹5k) conflict; #4 whether RNS0116 is still valid. | All carried as flags (`CONTEXT_REQUIRED`), treated as rare. |
| C4 | 6 — Newborn | **No cradle service code** (a baby-warmer code must not substitute). | Flagged for the FC meanwhile. |
| C5 | 15 — Labour room | Tariff has **no explicit 4-8h / 8-12h codes** — only ROM0121 (≤4h ₹9,900) and ROM5166 (₹15,000). | Used those two; exact slot→code mapping flagged for the billing head. |
| C6 | 16 — Tax | **Attendant-room** code / SAC / daily rate / effective date (18% GST); **HDU** tax status. | Attendant room off-by-default (flag only); HDU assumed **untaxed** for now. |
| C7 | 13 — Chemo | **Systemic-therapy drug/regimen master**; **pharmacy-price coverage** (6,132/11,254 items unpriced); **prior-cycle UMR** retrieval. | All **held** per your call; drug cost is a structured user input meanwhile; unpriced items would show last-observed provisional + confirm. |
| C8 | 5 — DNB | The ₹1 "non-show" share (DMO/monitor/etc.) — you noted "need more info". | It's an open-bill/LAN behaviour; our package-only lines can't reproduce the doc's 43–50% (we see ~0–4%). Ties to C1. |
| C9 | 17 — Blood bank | The history's **99.6% component+cross-match double-charge** — you said "I'll validate with the hospital, don't act on it." | Not reproduced and **not acted on** in the estimate. Just tracking your hospital validation. |
| C10 | 18 — Equipment/add-ons | **Missing catalogue masters** — codes/rates for cradle, arthroscopy major/minor, microscope >3h, NIV duration variants, retropositive amount, external PF, hospitality, and other editable services. | Engine mechanics (basis pricing, four-column split, mutex/location checks) are **ready**; add-ons priced from tariff, unknown codes flagged `CONTEXT_REQUIRED`. We'll try to fetch codes from past IPs + the tariff (per your note); anything still missing, please supply. MRD/MRT is handled as a **positive** charge as you said. |
| C11 | 19 — Tariff fallback | **Missing insurance tariff extracts per TR code** (you asked for the list to give the hospital). | **Delivered:** `todo_and_helpers/missing-tariff-codes-per-TR.md` — the missing/placeholder frequently-billed codes per TR (TR290 ~640 missing; **TR292 & TR274 have no usable pricing**; TR215 728; TR289 631; TR286 560; TR287 519). Hand this to the hospital for the real rates. |
| C12 | 21 — Non-package | The "sounds serious, need details" items — surgery-master contamination, single-vs-multi, insurance reconstruction ~10% low, N8 rebuild. | **Details delivered:** we reproduced the contamination — **RT0006 "100 MCI THERAPY DOSE" maps across 34 departments / 1,629 admissions**; **2,514 procedure admissions** run through codes spanning ≥5 departments (sentinel mis-maps). Our engine is partly insulated (family-based, ≥15-gated, not raw surgery_cd), but the raw surgery-master can still pull contaminated cases. **Held for your evaluation:** the N8 rebuild (clean surgery-master, revalidate the 756 multi-treatment, component-verify combos, governed medical master, hierarchical fallback). We already: never copy old FC estimates; keep the strong financial data; no blanket 10% insurance uplift. **Please review the contamination evidence and tell us whether to proceed with the N8 clean-up.** |
| C13 | 24 — Flow / effective period | You asked whether **effective period** exists in our tariff. | **Answer:** `package_master` HAS `effective_from`/`effective_to` (package price can key on effective period ✓); but `service_tariff_rate_matrix` has **no effective-date columns** — service-line rates can't key on effective period. If you want effective-dated service rates, that's a hospital data addition. |

### D2. Approved-but-scoped work (Tab 24 — for the "call")
You Agreed/aligned on these, and noted "we agreed on a call how to handle" the doctor-input contract. They touch verified add-on logic / expand AI scope, so we've **scheduled, not silently built** them:
- **>90%-prevalence add-on → preselect-but-confirm**, and **75–90%-present item >₹1,000 → surface-for-confirm instead of silently dropped** (T27; `services.js:75-76`). Both change the default add-on set → verified-number-adjacent. The >₹1000-drop can *underestimate* today (a common-ish, high-value add-on disappears); you said "need more info to validate" — the impact is exactly this: mid-frequency (75–90%) high-value add-ons are excluded from defaults. Confirm and we'll switch them to a confirm-prompt carefully.
- **N9 governed AI optional-item suggestion layer** (constrained to approved candidates) — a scoped expansion of AI scope.
- **Doctor-input contract** with source-span provenance + confidence + field-level override governance (privileged role for code/tariff/rate/inclusion/PF) — per your call.
- **Mismatch tiers** (block / confirm / inform) and **template consolidation** (validate upside first).

---

## D. Frontend follow-ups (engine returns the data; UI needs to render it — not blocking)

The engine now returns structured fields for each of these; the estimate-builder UI needs to display them:
- **Advisory expected-NME** line (T2), **Emergency overlay** + decision workflow (T3), **Positive-case** toggle + section (T4), **DNB** covered/non-covered + insurer/audit view (T5), **Newborn** 4-pathway picker (T6), **Cross-consult** suggest-and-confirm picker (T9), **Outside-LOS** excess-day breakdown (T10), **Medical-management** family/setting picker + semi-manual builder (T11), **Daycare** status + conversion (T12), **Chemo** structured regimen form (T13), **Labour-room** projected-hours input (T15), **GST-on-room-rent** line + attendant-room flag (T16), **Blood-bank** transfusion-needed add-on (T17).

*(Logged separately as the NME-frontend TODO; the rest follow the same pattern.)*

---

## How to reply
The fastest path: answer **A1–A4** (number-affecting), tick **B1–B11** (confirm my interpretation), and let us know which of **C1–C13** you're chasing with the hospital/Finance. **C1 (open-bill lines) is the single highest-value unlock** — it moves four items from policy-first to fully certified.

*(Covers Tabs 1–28 (complete); updated as tabs are reviewed.)*
