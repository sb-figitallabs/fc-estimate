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

Current finalized non-package behavior also distinguishes:
- IP drugs and IP consumables as per-day historical buckets
- OT drugs and OT consumables as variable / percentile-sensitive buckets
- implants as a separate historical bucket with family / brand / item-level selection behavior in implant-aware surgical builders

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
- keep OT / cath-lab slot-style rows separate from generic room rows when the family exposes those drivers

## Bucket And Grouping Behavior

The builder should preserve:
- FC bucket identity
- grouping identity
- traceable item origin

Use grouping for presentation and estimate rollups. Use bucket for logic and total construction.

Important finalized bucket behaviors:
- IP per-day buckets should be multiplied by normalized billable stay context
- OT variable buckets can move between low / typical / high using advanced shortlist controls
- implant buckets should preserve item-level traceability even when surfaced as grouped family selections
- robotic-charge rows should stay distinct from standard OT rows when the family exposes robotic logic

## Missing Mapping Behavior

If a selected item does not resolve in the mapping tables:
- do not silently bucket it into a guessed category
- return it as unresolved
- preserve raw item identity in the warning payload

## Warning vs Hard Failure

Developer-visible warning:
- unmapped service item
- unmapped implant detail row
- missing historical pharmacy / shortlist evidence for a percentile-sensitive bucket
- missing grouped residual evidence for a grouping the UI tries to render
- unmapped pharmacy item
- missing consultation rate
- missing service tariff row

Hard failure:
- total inability to resolve payor/tariff context
- malformed request that lacks required identifying inputs
