# Known Gaps And Future Extensions

## Not Included In Phase 1 Clean DB Scope

- package-master-backed FC estimation
- organization-name alias handling
- bill-audit document workflows
- policy-driven package/guideline enforcement

## Important Boundary

The current clean DB handoff is intentionally a non-package FC builder handoff.

This means:
- the developer can build the core FC estimate flow now
- package-aware estimation should be treated as a future extension unless package masters are migrated later

## Current Gaps

- organization-name alias table is not included in the clean DB handoff
- package master datasets are not included in the clean DB handoff
- old workbook orchestration still exists in repo but should not define the new product structure
- package-aware workbook variants may exist in historical outputs, but they are not part of the clean Phase 1 parity target

## Recommended Future Extensions

- migrate package masters if package-based estimates are needed
- migrate organization-name aliases if free-text org entry is needed
- add package-aware estimate flows once clean package data is migrated

## Developer Guidance

If a Phase 1 UI flow depends on package logic or alias-driven org matching, treat that as an extension request rather than quietly implementing against legacy source tables outside the clean DB.

## What This Handoff Now Covers

This handoff does now cover the finalized non-package builder-control layer:
- estimate modes
- percentile drivers
- advanced pharmacy controls
- service add-ons
- grouped residual adjustments
- payer-basis resolution
- LOS / ICU / ward normalization and derived OT / cath-lab context
- reviewed robotic and implant-aware non-package behavior
- emergency / MLC signal rules where evidenced
- PF family behavior, including implementation-target vs review-only distinctions

The remaining major gap is package-master-backed package estimation.
