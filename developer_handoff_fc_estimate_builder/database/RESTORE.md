# Restore Notes

This folder contains the clean Phase 1 FC handoff SQL dump:
- `fc_handover_phase1_clean.sql`

The dump contains schema plus data for:
- `mart.main_table`
- `fc.service_item_mapping`
- `fc.pharmacy_item_mapping`
- `fc.pharmacy_catalog_rate_reference`
- `fc.service_tariff_rate_matrix`
- `fc.consultation_tariff_rate_matrix`
- `fc.organization_tariff_mapping`

Restore it into a Postgres database dedicated to the FC Estimate Builder handoff environment.
