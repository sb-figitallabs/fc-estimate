# Normalization, Rounding, And Derived Fields

This document captures the reviewed rules for normalized stay context and derived procedure-duration fields used by finalized non-package FC builders.

## LOS Normalization Purpose

The builder does not rely only on raw `los_days`.
It uses normalized stay context so that:
- IP per-day pharmacy buckets scale correctly
- room-charge rows use a clean stay basis
- ICU and ward quantities align with rate logic

## ICU And Ward Day Reconciliation

Reviewed room/stay derivation logic reconstructs:
- `icu_days`
- `ward_days`

from ward-charge service rows plus total stay context.

Observed rules:
- ICU-family labels include `MICU`, `SICU`, `PICU`, `NICU`, `ICCU`, `ICU`
- `HDU` is treated as critical-care-style stay context
- `GENERAL`, `SINGLE`, `TWIN`, and `DELUXE` are ward-side context
- `DAYCARE` is treated separately from ward and ICU usage

The resulting rule is effectively:
- compute a total billable stay context
- allocate critical-care days first
- then allocate remaining ward days

## Same-Day And Cross-Day Stay Rules

Reviewed normalization behavior includes:
- same-day daycare-style fractional LOS can normalize to `0`
- same-day non-daycare room-based stay can normalize to `1`
- cross-day stays can use inclusive-day logic
- late-admission cross-day stays can be adjusted down by `1`
- normalized LOS never drops below `1` for non-daycare cross-day stays
- if admission/discharge dates are missing:
  - daycare LOS under `1` can normalize to `0`
  - non-daycare fallback uses ceiling LOS

Representative normalization reasons observed in tests:
- `same_day_daycare_fractional_los`
- `same_day_room_based_stay`
- `cross_day_inclusive`
- `cross_day_late_admission_adjusted`
- `cross_day_inclusive_stay_aligned_minus_one`
- `missing_dates_daycare_los_lt_1`
- `missing_dates_fallback_ceil_los`

## Room Category And Commercial Room Category

Reviewed logic derives room labels from service and ward text.

Inferred room categories:
- `icu`
- `hdu`
- `single`
- `twin`
- `general`
- `daycare`
- `deluxe`

Primary commercial room precedence in reviewed builder logic:
- `DELUXE`
- `SINGLE`
- `TWIN SHARING`
- `GENERAL WARD`
- `DAYCARE`

ICU-unit display precedence in reviewed builder logic:
- `SICU`
- `MICU`
- `ICCU`
- `ICU`
- `HDU`

## OT Hours Derivation

Reviewed OT logic derives OT duration from OT charge service rows.

Observed behavior:
- parse OT hours from service-row naming patterns such as `OT - 2 1/2 HOURS`
- if multiple parsable OT rows exist, the first parsable duration can drive the chosen value
- store all distinct OT service codes for traceability
- if no OT row is parsable, OT hours remain blank / null

This means the UI/backend should preserve:
- selected OT hours
- supporting OT code list

## Cath-Lab Hours Derivation

Reviewed cath-lab logic:
- sums cath-lab duration across matching rows
- stores all distinct cath-lab service codes
- can also detect cath-lab rows by name even when a service code is missing

This makes cath-lab behavior slightly more additive than OT behavior.

## Rounding And Supported Slot Behavior

Reviewed workbook logic includes explicit slot snapping for OT-style controls.

Observed rule:
- snap to the nearest supported slot-hours value
- supported examples include `2.0`, `2.5`, `3.0`, `3.5`, `4.0`
- representative behavior:
  - `3.625 -> 3.5`
  - `3.75 -> 4.0`

The handoff should treat this as the canonical slot-based rounding pattern when a family uses OT-slot controls.

## Cath-Lab And OT When Applicable

Not every family uses both OT and cath-lab.

Developer expectations:
- surgical non-daycare families may use OT logic heavily
- cath-lab/daycare families may use cath-lab metrics instead
- do not force OT and cath-lab simultaneously for every family

## How Normalized Fields Feed Estimate Logic

Normalized / derived values are used by:
- room-charge rows
- ICU / ward nursing rows
- LOS-multiplied IP pharmacy buckets
- OT-slot rate selection
- cath-lab-slot selection when applicable
- service-line-count benchmarking

## Source Evidence

Primary source-of-truth references:
- `scripts_reference/common_supabase_db.py`
- `scripts_reference/export_robotic_tkr_fc_estimate_builder.py`
- `scripts_reference/test_main_table_fc_actuals.py`
