# Payer Basis And Payor Selection Rules

This document captures the finalized payer-basis selection model used by the reviewed non-package FC builders.

## Canonical Basis Labels

The canonical basis options are:
- `Auto (Recommended)`
- `Cash`
- `GIPSA Insurance`
- `Non-GIPSA Insurance`
- `Corporate`
- `Insurance All`
- `All Payers`

The builder resolves basis separately for:
- service basis
- pharmacy basis
- PF basis

## Auto Resolution Model

The reviewed resolver follows a threshold-driven fallback model.

Target buckets considered exact-match candidates:
- `Cash`
- `GIPSA Insurance`
- `Non-GIPSA Insurance`
- `Corporate`

If the target exact cohort is large enough, the builder uses that exact basis.

If not, the builder falls back in this order:
1. exact target basis
2. `Insurance All` for `GIPSA Insurance` and `Non-GIPSA Insurance`
3. `All Payers`
4. `Cash`

The resolver records:
- selected basis
- selected case count
- recommended status
- confidence
- selection reason

## Exact Threshold And Fallback Threshold

Current reviewed rules from `scripts/fc_payer_basis_resolution.py`:
- exact threshold for `surgical` families: `15`
- exact threshold for `daycare` families: `15`
- exact threshold for other families: `20`
- fallback threshold for broader fallback cohorts: `25`

Meaning:
- if target cohort count meets the exact threshold, use the exact target basis
- if target is GIPSA / non-GIPSA but exact cohort is too small, use `Insurance All` if it has at least `25` cases
- if that still fails, use `All Payers` if it has at least `25` cases
- otherwise fall back to `Cash`

## Recommendation Statuses

Current reviewed statuses are:
- `recommended_exact`
- `recommended_fallback_insurance_all`
- `recommended_fallback_all_payers`
- `recommended_fallback_cash`

The UI should preserve these statuses for debugging or an advanced explanation panel.

## Confidence Semantics

Current reviewed confidence labels are:
- `high`
- `medium`
- `low`

Typical meaning:
- `high`: strong exact evidence
- `medium`: acceptable fallback or modest exact evidence
- `low`: weak fallback or materially sparse cohort

For insurance fallback, confidence also depends on spread vs broader aggregates.

## Insurance-All And All-Payers Rules

`Insurance All` is only the direct next-step fallback for:
- `GIPSA Insurance`
- `Non-GIPSA Insurance`

`All Payers` is the broader stability fallback after insurance-specific fallback fails.

`Cash` is the last fallback basis when broader cohorts are still too small.

## Component-Specific Resolution

The same resolution framework applies independently to:
- `service_basis`
- `pharmacy_basis`
- `pf_basis`

This matters because the same payor may have:
- enough service evidence
- weak pharmacy evidence
- PF that is only partially modeled or only review-grade in some families

The developer should not force one selected basis across all components unless the product intentionally chooses to simplify the reviewed workbook behavior.

## Cash And General Cases

Cash-facing estimate logic remains separate from basis resolution:
- `Cash` cases use `TR1 / KIMS`
- `General Patients` and `GENERAL` also resolve to `TR1 / KIMS`

That tariff rule determines pricing context.
Basis resolution determines which historical cohort supplies percentile-driven evidence.

## Family Notes

The reviewed repo logic uses `family_kind` when choosing thresholds.
Relevant family groups for the handoff are:
- surgical non-daycare
- surgical daycare
- medical non-daycare
- medical daycare

The handoff should treat the threshold model as canonical, with family kind changing only the threshold rule and the available artifact set.

## Implementation Expectations

The developer should:
- expose `Auto (Recommended)` as the default basis mode
- store the resolved basis separately for service, pharmacy, and PF
- preserve the resolver explanation and confidence
- show warnings when a sparse-cohort fallback is used
- avoid silently rewriting an explicitly chosen manual basis

## Source Evidence

Primary source-of-truth references:
- `scripts_reference/fc_payer_basis_resolution.py`
- `scripts_reference/build_general_medical_management_cash_fc_estimate_builder.py`
- `scripts_reference/build_chemotherapy_cash_fc_estimate_builder.py`
- `scripts_reference/export_robotic_tkr_fc_estimate_builder.py`
