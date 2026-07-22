# Review file T1 — PF, Multi-Treatment & Extended Stay

**Inputs reviewed:** `FC_PF_MULTI_TREATMENT_IMPLEMENTATION_SPEC.md` (v1.0, 20-Jul), `Reyvant - General Doc 6 (6).docx`, `i21.md` (your validation) — checked against our current engine logic and our billed history.
**Purpose:** per our agreed workflow — you approve/correct this file BEFORE we implement anything.

## 1. What already matches our engine (no change needed)

| Spec rule | Our current state |
|---|---|
| Cash/LAN open surgeon 25%, asst 15%, anaesthetist 25% of surgeon, asst-anaesth 25% of anaesthetist | ✅ exactly our cash cascade today |
| Cash multi-treatment: everything at 100% | ✅ our combos already price each path at full value |
| Payer routing Cash/GIPSA/Non-GIPSA/Corporate via org→tariff (TR290 = GIPSA) | ✅ verified 18-Jul, zero violations |
| Cross-consults excluded from surgeon-PF base | ✅ shipped 18-Jul (D3) |
| No universal 10% assistant-physician | ✅ we never had it |
| Medical management ≠ surgeon cascade | ✅ shipped 17-Jul (single physician row) |

## 2. What is NEW and additive (low risk — we propose to implement as spec'd)

- **Non-GIPSA same-sitting factors 100/50/25/25** (validated 70/70 historically) + different-sitting 100% each.
- **GIPSA same-sitting default 100/50/25/25 as `PROVISIONAL_POLICY`** with visible warning (your i21: only 3 comparable cases, median 25% — so provisional is right).
- **Package surgeon PF: GIPSA 20% / Non-GIPSA 25% of the ADJUSTED package amount** (validated).
- **Extended package-LOS visits** (97% historical support): surgeon 1 visit/excess day; physician 1 ward / 2 ICU visits per excess day; built from a projected stay-day ledger.
- **Mixed package+open**: package-primary → open secondary at factor with cap `min(open_full, primary_pkg × factor)`; open-primary → open bill only.
- **DMO = eligible billing days** (not raw LOS) — matches your data finding (70–76% exact-or-one-short).
- **Anaesthesia-type gate** (verified-LA ⇒ no anaesthetist PF; unknown ⇒ unresolved, never inferred).
- **Component ledger + rule trace tables** (treatment_components, professional_fee_calculations, stay_day_ledger, rule_trace) — deterministic, versioned rules; no hardcoded percentages.

## 3. ⚠️ CONFLICTS with currently-verified logic — need your explicit call

**3a. Insurer PF: spec percentages vs our historic-P50 override.** Today (your 15-Jul Q1 + 18-Jul "historic PF is the only override that remains"): insurer estimates re-price the PF bucket to the cohort's **billed P50** because insurer tariffs carry token PF (₹740-style). The spec instead computes insurer PF from **rules** (package 20/25%; open LAN 25% / final-insurance 35%). These will disagree case-by-case (our 17-Jul verification showed historic P50 often ≈ what rules would give, but not always).
**Question 1:** for the FC ESTIMATE (LAN surface), do rule-based percentages now REPLACE the historic-P50 override, with historic shown as reference only? (That reading is consistent with your 18-Jul "reference-only" direction — but it retires the Q1 mechanism, so we want it explicit.)
**Question 2:** the FC estimate is the LAN surface, so open-insurance surgeon = **25%**, and 35% only if we ever produce a FINAL_INSURANCE view — correct?

**3b. Same-sitting evidence at ESTIMATE time.** Spec §4.3 requires OT-session evidence for the 50/25 reduction — but an FC estimate happens BEFORE surgery; no OT transaction exists yet. We propose: a **planned-sitting input** (FC asks "same sitting or separate sittings?", default same-sitting for a single anaesthesia event, recorded as `MANUAL/PLANNED` evidence) — factors apply from that answer, with the provisional flag.
**Question 3:** confirm this planned-sitting input satisfies the session-evidence requirement for estimates.

**3c. Combo totals will DROP.** Our current combo view sums each path at 100% and labels it "upper bound". Implementing factors will reduce insurance combo totals by up to ~37% (e.g. 3-package case). That's the intended fix, but it changes numbers reviewers have already seen.
**Question 4:** confirm you want the factor-adjusted total to become the headline (with the old 100% sum retained as "unadjusted reference").

**3d. Gen-Doc-6 items your own i21 rejects.** We will NOT implement: universal assistant-physician 10% (history: tariffed ~50% of visit rate), physician 10%-of-total-bill as default (doctor-specific config only), automatic 35–40% multi-surgeon cap (soft warning + override only), LA inference from procedure names. Listed here so it's on record.

**3e. Rule-table location.** The spec mandates rules in `fc_curated.guideline_rules` / `fc_curated.professional_fee_rules` at `127.0.0.1:54322` — that's YOUR local project DB, not our engine RDS.
**Question 5:** do we (a) create `fc_curated`-equivalent tables in our RDS and you supply the seeded rule rows, or (b) you export snapshots we ingest, or (c) point our engine at a synced copy? (We need versioned rule rows either way — never hardcoded.)

## 4. Validation we will run BEFORE implementation (our data)
- Reproduce the 70/70 Non-GIPSA 50% secondary pattern on our `fc.package_bill_lines` (now 17k admissions incl. your Dec-24→Apr-25 drop).
- Package-PF distribution check: 20% GIPSA / 25% Non-GIPSA centring on our bills.
- Overstay-consultation presence on our cohort (spec: 97%).
- DMO units vs eligible-day rule on our data.

## 5. Proposed implementation shape (post-approval)
Component ledger (treatment components + sessions + factors) → PF calculator (rule table + trace) → stay-day ledger → estimate/flow-2/audit-view surfaces show per-component factors, PF lines with rule IDs, and provisional/review flags. Acceptance tests = spec §16 + our historical regressions. No numbers change for single-treatment cash cases (regression-pinned).
