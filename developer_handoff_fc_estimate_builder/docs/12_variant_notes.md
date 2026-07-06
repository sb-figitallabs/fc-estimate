# Variant Notes

The finalized non-package FC builders share one broad control model, but each family has some specific logic emphasis.

## General Medical Management

This family is the clearest canonical control-model reference.

Key emphasis:
- room-charge-heavy structure
- explicit LOS / ICU / ward drivers
- nursing, DMO, intensivist, monitor, and ward-consumable logic rows
- advanced controls for inpatient pharmacy buckets
- grouped adjustments and service add-ons

This family is the best starting point for rebuilding the canonical UI control model.

## Chemotherapy / Systemic Infusion / Daycare Families

These families share the same broad model but introduce family-specific patterns.

Observed differences include:
- optional logic rows that are not identical to GMM
- daycare-specific artifacts and rate families
- different room and optional-service emphasis
- some families use cath-lab/daycare style metric artifacts

Use these families to understand how the canonical control model flexes by clinical family without redefining the whole architecture.

## Surgical Non-Daycare Variants

Broader surgical variants reuse the same broad structure:
- room type selection
- estimate mode
- payer-basis resolution
- percentile-driven drivers
- grouped adjustments
- optional service add-ons

What changes by family:
- artifact set
- optional service rows
- room / OT / cath-lab emphasis
- final workbook presentation details

## Canonical Vs Family-Specific Rule

When documenting or implementing:
- if a behavior is present across the reviewed finalized builders, treat it as canonical
- if a behavior is clearly limited to one family, treat it as variant-specific

Examples:
- `Low / Typical / High` is canonical
- `P25 / P50 / P75 / Manual` driver selection is canonical
- inpatient pharmacy advanced controls are canonical in reviewed non-package builders
- specific optional logic rows for chemo/daycare are family-specific

## Package-Aware Variants

Historical outputs may contain package-aware workbook variants, but those are not part of the clean non-package parity scope for this handoff.
