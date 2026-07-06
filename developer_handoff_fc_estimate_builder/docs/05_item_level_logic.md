# Item-Level Logic

## Canonical Join Key

- `canonical_item_key` is the canonical item identifier for Phase 1 FC builder work.
- For services and pharmacy, this is the join key into the mapping tables.
- Preserve `item_code` and `item_name` for traceability and UI/debugging.

## Service Item Logic

Use `fc.service_item_mapping` to resolve:
- FC estimate bucket
- grouping
- billing head
- sub-head
- room-category dependency

Important behavior:
- if multiple raw service rows collapse into one canonical meaning, the canonical row is the final meaning to use
- room-category-dependent items must not be treated as globally room-agnostic
- billing head and sub-head remain useful for downstream grouping and explanation

## Pharmacy Item Logic

Use `fc.pharmacy_item_mapping` to resolve:
- classification
- FC estimate bucket
- grouping
- whether the item behaves like IP pharmacy or OT pharmacy

Current FC bucket behavior was derived from finalized classification logic:
- implants map to implants
- drugs/medicines/IV/nutrition products map to IP drugs or OT drugs
- treatment supplies map to IP consumables or OT consumables

When present in both IP and OT contexts:
- the finalized mapping table already reflects the intended FC meaning
- do not invent a fresh taxonomy in the app

## Pharmacy Rate Reference

Use `fc.pharmacy_catalog_rate_reference` for:
- `mrp`
- `sale_rate`
- population flags
- descriptive category/reference fields

This table is rate/reference support, not the main bucket mapping table.

## Room Charges Logic

Room-charge-sensitive behavior should follow room-category context.

Current finalized room signals are derived from service and ward labels, not from arbitrary UI text.

Recommended handling:
- normalize room context before rate selection
- map UI-selected room intent to the clean ward-group categories used in tariff tables
- keep room-category-dependent service handling explicit

## Bucket And Grouping Behavior

The builder should preserve:
- FC bucket identity
- grouping identity
- traceable item origin

Use grouping for presentation and estimate rollups. Use bucket for logic and total construction.

## Missing Mapping Behavior

If a selected item does not resolve in the mapping tables:
- do not silently bucket it into a guessed category
- return it as unresolved
- preserve raw item identity in the warning payload

## Warning vs Hard Failure

Developer-visible warning:
- unmapped service item
- unmapped pharmacy item
- missing consultation rate
- missing service tariff row

Hard failure:
- total inability to resolve payor/tariff context
- malformed request that lacks required identifying inputs
