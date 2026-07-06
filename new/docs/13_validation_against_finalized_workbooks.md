# Validation Against Finalized Workbooks

This document explains how the builder-control docs were aligned to finalized workbook behavior.

## Validation Sources

Primary validation/reference sources:
- `scripts_reference/validate_surgical_non_daycare_cash_variants.py`
- finalized builder scripts in `scripts_reference/`
- generated builder artifact families under `output/`

## What To Validate

Another engineer should be able to validate all of these:
- selected controls
- resolved payer basis
- selected room type
- estimate mode
- historical driver bands
- selected driver values
- low / typical / high estimate bands
- add-on selections
- grouped residual inclusion behavior
- estimate-vs-actual comparison bands where available

## Workbook Snapshot Concepts Already Present

The current validation path already reads workbook-facing snapshots such as:
- builder snapshot
- summary snapshot
- comparison snapshot

Those expose concepts like:
- selected room type
- estimate mode
- resolved payer basis
- resolved tariff/basis fields
- LOS / ICU / ward / OT driver p25/p50/p75 values
- selected controls
- final estimate
- estimate-vs-actual deltas against p25 / p50 / p75

## Recommended Review Checklist

### Control Names
- confirm docs use the same user-facing control names as finalized builders
- confirm `Low / Typical / High` semantics match workbook behavior
- confirm `P25 / P50 / P75 / Manual` semantics match workbook behavior

### Driver Logic
- confirm historical drivers documented in the handoff match builder formulas
- confirm selected-value behavior matches the workbook logic

### Advanced Controls
- confirm advanced pharmacy controls in docs match the actual shortlist/interpolation behavior
- confirm grouped-adjustment logic matches the workbook formulas conceptually
- confirm service add-on inclusion behavior matches the finalized builder

### Summary And Comparison
- confirm final estimate bands align with workbook summary sections
- confirm estimate-vs-actual references use p25 / p50 / p75 framing where applicable

## Acceptance Standard

The documentation is considered faithful when a reviewer can answer the following from the handoff plus curated references without repo-wide searching:
- how the estimate modes work
- how driver selectors work
- how advanced controls modify estimate outputs
- how grouped adjustments avoid double counting
- how service add-ons are organized and selected
- how workbook sections map to UI sections
