# Package Reference Scripts

These files are included as package-specific reference only.

Included:
- `migrate_fc_packages_phase7.py`
  - publishes the slim package-serving layer from curated package data into `fc_handover_phase1`
- `export_fc_handover_package_addon_sql_dump.py`
  - exports the package-only schema and data handoff files
- `fc_package_resolver_ui.py`
  - local tester UI for tariff + raw-treatment package resolution
  - shows package-exists / no-package-exists outcome
  - shows curated package runtime detail, FC history, and bundle preview

These are reference/reproducibility artifacts, not the required runtime architecture for the developer application.
