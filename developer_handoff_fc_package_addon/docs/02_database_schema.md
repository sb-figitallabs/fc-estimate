# Package Database Schema

## Persisted Tables

### `fc.package_master`

- Grain: one row per `tariff_code + package_code`
- Purpose: canonical package-serving table
- Includes:
  - canonical package identity and names
  - tariff/payor/department/package amount fields
  - documentation fields such as tariff text, inclusions, exclusions, notes
  - FC mapping fields such as `fc_template_package_code`, `fc_template_primary_package_name`, `fc_case_count_total`
  - readiness fields such as `runtime_status`, `can_generate_estimate`, `primary_blocker`, `warning_reason`

### `fc.package_room_rates`

- Grain: one row per `tariff_code + package_code + ordinal`
- Purpose: structured room/category package rates

### `fc.package_alias`

- Grain: one row per alias variant
- Purpose: raw treatment/package-text alias resolution support

### `fc.package_organization_applicability`

- Grain:
  - insurance/GIPSA: one row per `organization_cd + tariff_code + package_code`
  - cash: one row per tariff/package with blank organization code
- Purpose: organization applicability bridge

## Runtime Views

### `fc.v_package_runtime_lookup`

- Primary runtime lookup surface
- Grain:
  - insurance/GIPSA: one row per `organization_cd + tariff_code + package_code`
  - cash: one row per `tariff_code + package_code`
- Includes:
  - package master fields
  - room-rate JSON
  - alias JSON
  - readiness fields
  - FC mapping fields

### `fc.v_package_case_history`

- Historical package usage summary
- Derived from:
  - `mart.main_table`
  - `fc.v_package_runtime_lookup`
- Includes:
  - `admission_count`
  - `latest_admission_at`
  - observed min/max package amount
  - sample admissions JSON

## Published Counts

Current published package-serving counts:
- `fc.package_master`: `1145`
- `fc.package_room_rates`: `3192`
- `fc.package_alias`: `5034`
- `fc.package_organization_applicability`: `3715`

Published tariff coverage:
- `TR1`
- `TR201`
- `TR285`
- `TR287`
- `TR288`
- `TR289`
- `TR290`
