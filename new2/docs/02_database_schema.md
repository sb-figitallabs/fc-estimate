# Database Schema

The clean FC handoff DB contains 7 business tables.

## 1. `mart.main_table`

- Purpose: clean IP case-level source table for estimate context and historical FC-supporting fields
- Grain: one row per admitted case
- Effective key: `main_table_key`
- Important fields:
  - patient/admission context
  - `organization_cd`, `organization_name`, `payor_bucket`
  - `tariff_code`, `tariff_name`
  - `surgical_medical`, `is_daycare_broad`
  - `room_category`
  - `fc_actual_bucket_totals_jsonb`
  - `fc_actual_total_excluding_fnb_and_returns`
  - `fc_actual_cash_drug_administration_charge`
  - `fc_actual_total_excluding_fnb_and_returns_plus_cash_drug_admin`
- Use it for:
  - historical case context
  - prefilled tariff/payor/stay context
  - FC actual benchmark/reference fields
- Do not use it for:
  - item master lookup
  - tariff matrix lookup

## 2. `fc.service_item_mapping`

- Purpose: canonical service item to FC bucket/group mapping
- Grain: one row per `canonical_item_key`
- Primary key: `canonical_item_key`
- Important fields:
  - `item_code`, `item_name`
  - `fc_estimate_bucket`
  - `grouping`
  - `billing_head`
  - `sub_head`
  - `room_category_dependent`
  - `mapping_source`
- Use it for:
  - mapping UI-selected service items into FC estimate buckets
  - rollup/group display

## 3. `fc.pharmacy_item_mapping`

- Purpose: canonical pharmacy item to FC bucket/group mapping
- Grain: one row per `canonical_item_key`
- Primary key: `canonical_item_key`
- Important fields:
  - `item_code`, `item_name`
  - `classification`
  - `fc_estimate_bucket`
  - `grouping`
  - `present_in_ip_pharmacy`
  - `present_in_ot_pharmacy`
  - `mapping_source`
- Use it for:
  - classifying pharmacy lines into FC estimate buckets

## 4. `fc.pharmacy_catalog_rate_reference`

- Purpose: clean pharmacy rate/MRP reference table
- Grain: one row per canonical pharmacy item
- Primary key: `canonical_item_key`
- Important fields:
  - `item_code`, `item_name`
  - `mrp`, `sale_rate`
  - `mrp_populated`, `sale_rate_populated`
  - category and manufacturer descriptors
- Use it for:
  - showing rate reference for pharmacy items
  - supporting UI/debug/traceability
- Do not use it as the bucket mapping table

## 5. `fc.service_tariff_rate_matrix`

- Purpose: canonical service/investigation tariff matrix
- Grain: one row per `tariff_cd + rate_domain + service_cd + ward_group_name`
- Primary key: `tariff_cd, rate_domain, service_cd, ward_group_name`
- Important fields:
  - `tariff_cd`, `tariff_name`
  - `rate_domain`
  - `service_cd`, `service_name`
  - `ward_group_name`
  - `charge`
  - `billing_head`
- Use it for:
  - service and investigation rate lookup after tariff resolution

## 6. `fc.consultation_tariff_rate_matrix`

- Purpose: canonical consultation tariff lookup
- Grain: one row per `tariff_name + doctor_cd + ward_group_name`
- Primary key: `tariff_name, doctor_cd, ward_group_name`
- Important fields:
  - `tariff_name`
  - nullable `tariff_cd`
  - `doctor_cd`, `doctor_name`
  - `ward_group_name`
  - `charge`, `revisit_charge`, `emergency_charge`
- Use it for:
  - consultation pricing lookup

## 7. `fc.organization_tariff_mapping`

- Purpose: KIMS-only organization to tariff bridge
- Grain: one row per `organization_cd`
- Primary key: `organization_cd`
- Important fields:
  - `organization_cd`, `organization_name`
  - `tariff_cd`, `tariff_name`
  - `priority_type`
- Use it for:
  - insurance tariff resolution in Phase 1

## Canonical Joins

- `organization_cd -> fc.organization_tariff_mapping.tariff_cd`
- `tariff_cd + service_cd + ward_group_name -> fc.service_tariff_rate_matrix`
- `tariff_name + doctor_cd + ward_group_name -> fc.consultation_tariff_rate_matrix`
- `canonical_item_key -> fc.service_item_mapping`
- `canonical_item_key -> fc.pharmacy_item_mapping`
- `canonical_item_key -> fc.pharmacy_catalog_rate_reference`

## Current Loaded Row Counts

- `mart.main_table`: `14,202`
- `fc.service_item_mapping`: `1,639`
- `fc.pharmacy_item_mapping`: `8,578`
- `fc.pharmacy_catalog_rate_reference`: `7,630`
- `fc.service_tariff_rate_matrix`: `394,163`
- `fc.consultation_tariff_rate_matrix`: `35,372`
- `fc.organization_tariff_mapping`: `68`
