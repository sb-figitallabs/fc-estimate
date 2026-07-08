# Restore Notes

This folder contains the package-only FC add-on:
- `fc_handover_package_addon_schema.sql`
- `fc_handover_package_addon_data.sql`

This add-on depends on the previously shared base FC handoff database dump.

Restore order:
1. restore the base FC handoff database first
2. apply `fc_handover_package_addon_schema.sql`
3. restore `fc_handover_package_addon_data.sql`

This add-on creates and loads:
- `fc.package_master`
- `fc.package_room_rates`
- `fc.package_alias`
- `fc.package_organization_applicability`
- `fc.v_package_runtime_lookup`
- `fc.v_package_case_history`
