# Developer Send-Off Note

This folder is the package add-on for the FC handoff you already received earlier.

Please use it as an overlay on top of the previous base FC handoff:

1. Restore the previously shared base FC handoff database/dump first.
2. Apply `database/fc_handover_package_addon_schema.sql`.
3. Restore `database/fc_handover_package_addon_data.sql`.

What this adds:
- clean package-serving tables
- package runtime lookup via `fc.v_package_runtime_lookup`
- package case-history lookup via `fc.v_package_case_history`

How to use it:
- use direct lookup by `tariff_code + package_code` first
- exact `tariff_code + package_name` is also supported
- alias-based lookup can use `fc.package_alias`
- if no row resolves, treat that as `no package exists`

Important rule:
- package documentation/details must come from the curated package fields
- FC package history is supporting evidence only and should not be used to fabricate package details

This add-on does not replace the original non-package FC handoff. It only extends it with the clean package layer.

If you want to run the local tester UI in a similar workspace, an example command is:

```bash
PYTHONPATH="$PWD/scripts/etl:$PWD" GEMINI_API_KEY="your_key_here" .venv/bin/python scripts/etl/fc_estimate_resolver_ui.py
```

Then open `http://127.0.0.1:8765`.
