# Service Add-Ons And Grouped Adjustments

This document captures how the finalized builders organize default services, optional add-ons, and grouped common-case residuals.

## Source Artifact Families

The reviewed finalized builders depend on these service-organization artifact families:
- `11_clean_*_template_for_fc*.csv`
- `12_default_included_services*.csv`
- `13_optional_service_add_ons*.csv`
- `14_service_line_count_metrics*.json`
- `16_los_icu_ward_room_metrics*.json`
- `30_payer_basis_resolution_summary.csv`

## Default Included Services

Default included services are the base non-pharmacy service rows that the builder includes automatically.

These rows are already curated into the `12_default_included_services*.csv` artifacts.

Each row generally carries:
- item code
- item name
- FC bucket
- grouping
- quantity p25 / p50 / p75
- rate columns by room where applicable

UI expectation:
- show them as part of the default estimate
- do not force the end user to manually add them one by one

## Optional Service Add-Ons

Optional service add-ons are explicit service rows that can be turned on or off by the user.

Current reviewed finalized builder behavior:
- add-ons live in a dedicated `Service Add-Ons` section
- each row has a direct include/exclude control
- each row preserves:
  - FC bucket
  - grouping
  - presence %
  - quantity p25/p50/p75
  - room-specific rates where applicable

UI expectation for each add-on row:
- include/exclude toggle
- item label
- grouping label
- FC bucket label
- quantity band context
- rate context

## Grouped Common-Case Residuals

Grouped adjustments are used to complete common service groups without double counting exact rows.

The finalized behavior is:
- common group amounts exist at p25 / p50 / p75
- default rows capture part of those group amounts
- grouped residual rows represent the remaining common-case amount not already captured by default exact rows

Each grouped-adjustment row carries:
- grouping
- FC bucket
- presence %
- grouped amount p25 exact
- grouped amount p50 exact
- grouped amount p75 exact
- amount already captured by default rows
- residual band classification

## Auto Vs Optional Grouped Residuals

The reviewed finalized builder differentiates between:
- auto grouped residuals
- optional grouped residuals

Meaning:
- `auto` residuals are common-case grouped completions that should usually be included by default
- `optional` residuals are common but not strong enough to always include automatically

UI expectation:
- auto grouped residuals can default to included
- optional grouped residuals can default to excluded or clearly marked as optional

## Interaction Between Add-Ons And Grouped Residuals

This is a key finalized behavior.

If an exact optional add-on from a grouping is selected:
- the grouped residual for the same grouping should shrink automatically

This prevents double counting.

So the grouped-adjustment layer is not independent. It reacts to explicit service-add-on inclusion.

## How The Developer Should Render This

### Default Rows
- visible in estimate breakdown
- part of starting estimate
- not treated as optional user actions

### Add-On Rows
- shown in an advanced or expandable service-add-on section
- explicit include/exclude toggle
- grouping shown clearly
- traceable to FC bucket

### Grouped Residual Rows
- shown in a grouped-adjustments section
- grouped by FC grouping label
- include/exclude control where applicable
- explanation text that this is a common-case residual completion, not a single exact billed item

### Residual Explanations
- explain that grouped residuals represent missing common-case value not already captured by default rows
- explain that exact add-ons from the same grouping reduce the residual
