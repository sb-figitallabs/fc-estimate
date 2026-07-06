# Builder Controls And Percentile Logic

This document captures the canonical control model used by the finalized non-package FC estimate builders.

## Canonical Estimate Modes

The finalized builders use three estimate modes:
- `Low`
- `Typical`
- `High`

These modes drive selected quantities and selected totals across multiple sections. In the canonical model:
- `Low` corresponds to `P25`
- `Typical` corresponds to `P50`
- `High` corresponds to `P75`

The mode is selected once at the top of the builder and then propagated through line-item formulas and summary formulas.

## Driver Selector Model

The builder uses driver selectors with these options:
- `P25`
- `P50`
- `P75`
- `Manual`

Some flows also expose:
- `Auto (Recommended)` for payer basis

The driver-selector model is used to choose the active value for:
- LOS
- ICU days
- ward days
- OT or cath-lab hours where applicable

The canonical formula pattern is:
- if `P25`, use historical p25
- if `P50`, use historical p50
- if `P75`, use historical p75
- if `Manual`, use the manual override field

## Historical Driver Families

The finalized builders source percentile references from these artifact families:

- `14_service_line_count_metrics*.json`
  - distinct service-line count references

- `16_los_icu_ward_room_metrics*.json`
  - LOS
  - ICU days
  - ward days
  - room-related historical context

- `05_ip_bucket_los_normalized_percentiles*.csv`
  - inpatient pharmacy-per-day baselines
  - specifically IP drugs and IP treatment supplies in the reviewed finalized non-package builders

- `03_bucket_percentile_summary*.csv`
  - bucket-level percentile references in families that use explicit bucket percentile files

- cath-lab metrics JSON
  - p25 / p50 / p75 for cath-lab family amounts where applicable

## Selected Value Behavior

The builders store historical p25/p50/p75 side by side and compute a selected value from the chosen driver basis.

For example:
- LOS selected value comes from LOS p25/p50/p75 or manual override
- ICU selected value comes from ICU p25/p50/p75 or manual override
- ward selected value comes from ward p25/p50/p75 or manual override

Those selected driver values then feed:
- room-charge rows
- nursing/DMO/intensivist logic rows where applicable
- pharmacy low/typical/high baseline scaling
- line-item detail selected quantities

## Advanced Pharmacy Controls

The finalized canonical builders expose advanced controls for percentile-sensitive pharmacy buckets.

Reviewed canonical non-package behavior confirms advanced-control handling for:
- `IP Drugs`
- `IP Treatment Supplies`

Current reviewed finalized builders do not expose a canonical advanced-control block for `OP consumables`. If a future family introduces it, that should be documented as a variant extension rather than assumed here.

### Shortlist Construction

The advanced-control shortlist is built from high-contribution items in the bucket.

Current reviewed logic includes:
- shortlist row cap
- cumulative share target
- expected-contribution ordering
- default include/exclude selection derived from target percentile position

### Low / Typical / High Bucket Bounds

For advanced pharmacy buckets:
- low bound uses p25 baseline
- typical uses p50 baseline
- high uses p75 baseline

For reviewed inpatient pharmacy controls, those bounds are derived by multiplying:
- selected LOS context
- bucket per-day percentile baseline

### Typical Interpolation

The reviewed finalized builder computes the `Typical` advanced-control value using the share of selected shortlisted items between the low and high bounds.

Conceptually:
- low = base p25 bucket amount
- high = base p75 bucket amount
- selected shortlist share determines how far the current typical state moves between low and high

This is not a naive toggle. It is a weighted interpolation based on the included shortlist rows.

## Service-Line Count Alert

The finalized builders also expose a service-line-count alert block.

Tracked values:
- historical p25
- historical p50
- historical p75
- base included non-pharmacy count
- selected optional count
- current included non-pharmacy count

Alert logic:
- below p25 => below historical range
- above p75 => above historical range
- otherwise => within historical range

This should surface in UI as an alert/warning state, not as a hidden internal number.

## Payer Basis As A Control Concept

Payer basis is separate from estimate mode and driver basis.

The canonical payer-basis control model includes:
- `Auto (Recommended)`
- `Cash`
- `GIPSA Insurance`
- `Non-GIPSA Insurance`
- `Corporate`
- `Insurance All`
- `All Payers`

Payer basis can resolve independently for:
- service basis
- pharmacy basis
- PF basis

The finalized builders expose those as resolved outputs plus a resolver note.
