# Reference Scripts

These files are included as curated reference only.

## Clean DB Source-Of-Truth References

- `scripts_reference/fc_estimate_assembly.py`
  - Main FC estimate resolver logic reference
  - Important for payor normalization, tariff resolution, and estimate-context behavior

- `scripts_reference/common_supabase_db.py`
  - Reference for stored FC actual, room-category, and cash drug-admin logic
  - Important sections:
    - room category derivation
    - FC actual bucket behavior
    - cash drug administration formula

## Control-Model References

- `scripts_reference/build_general_medical_management_cash_fc_estimate_builder.py`
  - Primary canonical builder-control reference
  - Important for:
    - `Low / Typical / High`
    - `P25 / P50 / P75 / Manual`
    - advanced pharmacy controls
    - service add-ons
    - grouped adjustments
    - workbook section organization

- `scripts_reference/build_chemotherapy_cash_fc_estimate_builder.py`
  - Variant reference for chemo/daycare-style builder behavior
  - Important for family-specific differences and optional logic rows

- `scripts_reference/fc_payer_basis_resolution.py`
  - Authoritative payer-basis resolution logic reference
  - Important for:
    - `Auto (Recommended)`
    - component-level basis resolution
    - payor fallback rules

- `scripts_reference/validate_surgical_non_daycare_cash_variants.py`
  - Validation reference against finalized workbooks
  - Important for:
    - selected controls snapshot
    - summary snapshot
    - estimate-vs-actual comparison snapshot

## Validation References

- `scripts_reference/validate_surgical_non_daycare_cash_variants.py`
  - Validation reference against finalized workbooks
  - Important for:
    - selected controls snapshot
    - summary snapshot
    - estimate-vs-actual comparison snapshot

## Clean DB Migration References

- `scripts_reference/migrate_fc_lookup_tables_phase2.py`
  - service/pharmacy canonical mapping table construction

- `scripts_reference/migrate_fc_pharmacy_catalog_phase3.py`
  - pharmacy catalog rate/MRP reference construction

- `scripts_reference/migrate_fc_service_tariff_phase4.py`
  - service tariff matrix construction

- `scripts_reference/migrate_fc_consultation_tariff_phase5.py`
  - consultation tariff matrix construction

- `scripts_reference/migrate_fc_org_tariff_phase6.py`
  - KIMS organization-to-tariff mapping construction

- `scripts_reference/export_fc_handover_sql_dump.py`
  - clean DB dump exporter

## Historical / Orchestration-Only References

- `scripts_reference/export_general_medical_management_fc_estimate_builder.py`
  - useful for understanding prior orchestration
  - historical orchestration example only
  - not the target runtime architecture

## Modules To Ignore For Phase 1 Build

- bill-audit modules
- template curation workflows
- raw import / QA pipelines
- policy-review pipelines
- package-audit implementation paths
- workbook-only output assembly paths as product architecture

The developer should treat the clean DB plus these docs as primary, and the reference scripts as logic backstop only.
