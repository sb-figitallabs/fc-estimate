# FC Estimate Builder Developer Handoff

This handoff pack is for rebuilding the finalized non-package FC Estimate Builder using the clean FC database plus the finalized workbook-control logic.

This pack is intentionally scoped to:
- FC Estimate Builder
- UI-based implementation
- clean DB-backed logic

This pack is intentionally not scoped to:
- bill auditing
- Excel workbook reproduction as runtime architecture
- package-master-backed estimate flows in Phase 1

## What To Start With

Read in this order:
1. `docs/01_overview.md`
2. `docs/02_database_schema.md`
3. `docs/03_fc_estimate_flowchart.md`
4. `docs/04_core_logic_rules.md`
5. `docs/05_item_level_logic.md`
6. `docs/06_input_output_contract.md`
7. `docs/07_reference_scripts.md`
8. `docs/08_known_gaps_and_future_extensions.md`
9. `docs/09_builder_controls_and_percentile_logic.md`
10. `docs/10_service_addons_and_grouped_adjustments.md`
11. `docs/11_ui_control_model_from_finalized_builder.md`
12. `docs/12_variant_notes.md`
13. `docs/13_validation_against_finalized_workbooks.md`

## Authoritative Inputs

- Database dump: `database/fc_handover_phase1_clean.sql`
- Logic docs in `docs/`
- Curated reference files in `scripts_reference/`

## What This Pack Should Be Sufficient For

This pack should let the developer rebuild near-full parity for the finalized non-package FC builder, including:
- clean DB-backed estimate engine
- tariff and payor resolution
- item mapping and rate lookup
- `Low / Typical / High` modes
- `P25 / P50 / P75 / Manual` driver behavior
- advanced pharmacy controls
- service add-ons
- grouped residual adjustments
- workbook-to-UI translation

## Phase 1 Boundary

Build the clean non-package FC builder first:
- tariff resolution
- consultation lookup
- service item mapping
- pharmacy item mapping
- room/ward logic
- cash vs insurance logic
- finalized builder control logic
- percentile and advanced-control behavior
- service add-ons and grouped residual behavior

Do not treat old workbook/export scripts as the target architecture. They are reference material only.
