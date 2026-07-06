# Variant Notes

The reviewed non-package FC builders share one broad control model, but the safest implementation view is a four-family matrix.

## Canonical Across All Reviewed Families

Treat these as canonical unless a reviewed family clearly overrides them:
- `Low / Typical / High`
- `P25 / P50 / P75 / Manual`
- payer-basis resolution
- service add-ons
- grouped residual logic
- unresolved-item / warning-first behavior

## Surgical Non-Daycare

Primary examples:
- robotic TKR families
- THR / hemiarthroplasty families

Key emphasis:
- strongest OT / room / implant presence
- robotic-charge handling may apply
- PF is most likely to be implementation-target behavior
- OT-consumables advanced shortlist logic is especially relevant
- implant hierarchy can be first-class

## Surgical Daycare

Key emphasis:
- same broad control model
- lighter LOS / ward dependency than non-daycare surgical families
- cath-lab / slot-based logic may matter more than ward-stay logic in some families
- grouped adjustments and payer-basis still apply

## Medical Non-Daycare

Primary canonical reference:
- General Medical Management

Key emphasis:
- room-charge-heavy structure
- explicit LOS / ICU / ward drivers
- nursing / DMO / intensivist / monitor patterns
- advanced controls for inpatient pharmacy buckets
- PF is more often contextual or review-oriented than surgically modeled

This remains the clearest starting point for the canonical non-package control model.

## Medical Daycare

Primary examples:
- chemotherapy / systemic infusion daycare-style families

Key emphasis:
- daycare-style stay logic
- optional rows differ from GMM
- cath-lab / daycare artifact families may replace some OT-heavy logic
- PF usually stays review-oriented unless a family explicitly promotes it

## Canonical Vs Family-Specific Rule

When documenting or implementing:
- if a behavior is present across reviewed families, treat it as canonical
- if a behavior is limited to one family or artifact set, treat it as family-specific

Examples:
- inpatient pharmacy advanced controls are canonical in reviewed non-package builders
- robotic-charge logic is surgical-family-specific
- implant hierarchy is strong in reviewed surgical implant-aware families, not universal
- cath-lab slot behavior is family-specific

## Package-Aware Variants

Historical outputs may contain package-aware workbook variants, but those are not part of the clean non-package parity scope for this handoff.
