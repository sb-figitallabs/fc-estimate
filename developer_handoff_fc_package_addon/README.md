# FC Package Add-On Developer Handoff

This handoff pack contains only the clean package add-on for the FC estimate ecosystem.

It is intended for the developer who has already received:
- the previous base FC handoff database dump
- the previous non-package FC handoff folder

This package add-on is intentionally scoped to:
- clean package lookup
- package readiness and blocker visibility
- FC package mapping fields
- historical package case lookup

This package add-on is intentionally not scoped to:
- raw package curation/import workflows
- review queues
- source-audit reconstruction
- replacement of the original non-package FC handoff

## What This Pack Contains

- package schema overlay:
  - `database/fc_handover_package_addon_schema.sql`
- package data overlay:
  - `database/fc_handover_package_addon_data.sql`
- package-specific docs in `docs/`
- minimal package reference scripts in `scripts_reference/`
- the local package resolver tester UI reference in `scripts_reference/fc_package_resolver_ui.py`

## Restore Dependency

This pack is layered on top of the previously shared base FC handoff.

Restore order:
1. restore the previously shared base clean FC dump
2. apply `database/fc_handover_package_addon_schema.sql`
3. restore `database/fc_handover_package_addon_data.sql`

## Primary Runtime Surfaces

- `fc.v_package_runtime_lookup`
- `fc.v_package_case_history`

Use the docs in this folder as the package-specific guide. The original `developer_handoff_fc_estimate_builder` folder remains the non-package FC builder handoff.

## Included UI Reference

This pack also includes the local package resolver tester UI that was used to:
- enter a tariff code
- enter raw treatment text
- use Gemini to resolve the closest valid package in the tariff-specific catalog
- show whether a package exists
- show the curated package runtime row
- show FC package history and the FC handoff bundle preview
