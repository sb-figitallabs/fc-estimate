# Package Resolver UI

## Purpose

This add-on includes the local package resolver tester UI used for package validation.

Entry file:
- `scripts_reference/fc_package_resolver_ui.py`

## What The UI Does

The UI allows a user to:
- select or enter a tariff code
- enter raw treatment text
- use Gemini to normalize that text to a valid package candidate from the tariff-specific catalog
- show whether a package exists or does not exist
- show the curated package runtime row
- show FC package history for the resolved package
- preview the FC handoff bundle that would be passed downstream

The UI does not execute the FC estimate builder itself.

## Runtime Requirements

To run the UI as originally designed, the developer should have:
- the package add-on restored in the local Postgres database
- access to the supporting Python project modules used by the UI
- `GEMINI_API_KEY` set in the environment

Important note:
- this UI is included as a reference implementation and tester surface
- it depends on the surrounding package lookup and FC assembly modules from the working project
- the developer can either run it inside the same codebase or reimplement the same behavior in their own application

## Example Run Command

If the developer is running inside a repo/workspace that contains the same supporting Python modules, an example command is:

```bash
PYTHONPATH="$PWD/scripts/etl:$PWD" GEMINI_API_KEY="your_key_here" .venv/bin/python scripts/etl/fc_estimate_resolver_ui.py
```

Then open:

```text
http://127.0.0.1:8765
```

If the developer copies the UI script into a different project structure, they should adjust:
- `PYTHONPATH`
- the script path
- the database environment variables

## Expected Behavior

Inputs:
- `tariff_code`
- raw treatment text

Outputs:
- package exists / no package exists
- resolved package code and name
- package runtime status
- FC package code / FC package name / FC case count when present
- case-history summary
- bundle preview for the FC estimate builder handoff

## Gemini Rule

Gemini should only choose from the provided tariff-specific package catalog.

If Gemini cannot confidently map the raw treatment text to a valid package in that catalog:
- return `no package exists`

Do not invent package codes or names outside the curated package catalog.
