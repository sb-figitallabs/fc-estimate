# Edge Cases: Robotic, Implants, Emergency, And MLC

This document captures non-package edge-case logic that is present in reviewed builder scripts and tests.

## Robotic Charge Detection

Reviewed robotic logic identifies robotic rows by searching for markers such as:
- `ROBO`
- `ROBOTIC`

Detection can consider:
- item code
- item name
- grouping
- FC bucket

This allows robotic-charge rows to stay distinct from generic OT rows.

## Robotic Default Selection

Reviewed robotic defaulting supports:
- `yes`
- `no`
- `auto`

Behavior:
- `yes` => always select `Yes`
- `no` => always select `No`
- `auto` => select `Yes` only when `presence_rate > presence_threshold`

Reviewed default threshold in the robotic builder:
- `presence_threshold = 90.0`

So a high-presence robotic row can auto-enable, while lower-presence robotic rows remain unselected by default.

## Robotic Presence Rate

Reviewed helper behavior computes robotic presence rate using the maximum presence rate among qualifying robotic rows.

This is a conservative “strongest available signal” approach, not an average.

## Procedure Row Preference

Reviewed surgical logic can prefer a standard non-robotic candidate over a robotic procedure candidate when resolving the primary procedure row.

The handoff should therefore treat “robotic present” and “base procedure row” as related but not identical concepts.

## OT Consumables Advanced Thresholds

Reviewed OT consumables advanced-control logic uses piecewise thresholds based on selected expected shortlist share:
- if share `<= 0.30`, use `P25`
- if share `<= 0.50`, use `P50`
- otherwise use `P75`

This is the canonical reviewed threshold model for OT-consumables shortlist interpolation.

## Default Included Vs Optional Service Rows

Reviewed builder logic marks service rows as default included when:
- presence rate `> 90%`
- or presence rate `>= 75%` and typical amount `<= 1000`

Rows outside that default-included rule become optional add-ons.

## Add-On Prioritization

Reviewed optional-service ordering prioritizes:
1. highest expected add-on contribution
2. then higher presence rate
3. then higher rate
4. then grouping / name / code stability

Expected contribution uses:
- quantity p50
- rate context
- case presence rate

## Grouped Residual Thresholds

Reviewed grouped residual behavior distinguishes:
- `auto`
- `optional`

Observed thresholds:
- `auto`: presence rate `> 90%` and positive residual
- `optional`: presence rate between `75%` and `90%` inclusive, with positive residual

Additional reviewed promotion rule:
- some investigation groups can be promoted to `auto` if:
  - bucket is `Investigations`
  - presence rate `>= 50%`
  - residual p50 `>= 1000`
  - positive left-out amount exists
  - at least one optional child exists

## Grouped Residual Interaction With Exact Add-Ons

Grouped residuals are not independent.

Reviewed logic reduces grouped residuals when exact child add-ons from the same grouping are selected.

The UI should therefore:
- show grouped residuals after subtracting selected exact child contribution
- explain that grouped residuals are a common-case completion layer
- avoid double counting grouped and exact rows from the same grouping

## Implant Handling

Reviewed implant-aware surgical builders preserve implant selection at multiple levels:
- implant family
- brand family
- specific item

Observed implant columns include:
- implant-family distinct IP count
- implant-family presence rate
- implant-family quantity p25 / p50 / p75
- implant-family rate p25 / p50 / p75
- brand-family presence and rate
- item-level code, name, quantity, rate, and presence

Implementation expectation:
- do not flatten implants to a single opaque bucket when the family exposes implant hierarchy
- preserve traceability from family to brand to item

## Emergency-Origin Rules

Reviewed main-table logic sets emergency-origin flags from service evidence, not merely from any “Emergency” wording.

Examples of positive evidence:
- `ER Physician`

Examples of reviewed non-trigger behavior:
- generic `Emergency Investigations` group labels alone do not trigger emergency-origin
- support-only `EME` rows can remain non-triggering

This means emergency-origin should be a signal-based rule, not a blanket text contains `Emergency` rule.

## MLC Detection Rules

Reviewed MLC rules can trigger from:
- explicit MLC service code such as `HSP0047`
- service text
- department-level signals such as `MLC Desk`

The reviewed context payload preserves:
- matched MLC signals
- match type
- summarized MLC charge amount

## No-Show / Non-Trigger Guidance

A dedicated canonical “no-show item” implementation rule was not strongly evidenced in the reviewed non-package builder sources examined for this pass.

So the strengthened handoff should state:
- implement only the non-trigger and support-only edge behavior that is explicitly evidenced
- do not invent a generic no-show rule unless a reviewed family source clearly requires it

## Source Evidence

Primary source-of-truth references:
- `scripts_reference/export_robotic_tkr_fc_estimate_builder.py`
- `scripts_reference/test_surgical_workbook_logic.py`
- `scripts_reference/test_main_table_fc_actuals.py`
