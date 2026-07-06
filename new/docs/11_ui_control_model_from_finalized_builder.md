# UI Control Model From Finalized Builder

This document translates the finalized workbook behavior into a UI-ready implementation model.

## Top-Level Controls

The finalized builder conceptually exposes these top-level controls:
- room type
- estimate mode
- historical payer-basis override

Recommended UI mapping:
- room type => dropdown
- estimate mode => segmented control or dropdown
- payer-basis override => dropdown

## Driver Control Block

The canonical driver block includes:
- LOS
- ICU days
- ward days
- OT or cath-lab hours where applicable by family

For each driver the UI should show:
- historical p25
- historical p50
- historical p75
- selected basis
- manual override field
- final selected value

Recommended UI mapping:
- basis selector => dropdown
- manual override => numeric input
- selected value => computed read-only display

## Advanced Controls Block

Advanced Controls should be a separate expandable section.

It should contain:
- advanced pharmacy shortlist controls
- grouped adjustments
- service add-ons
- service-line-count alert

The user should not need this section for a basic estimate flow. It is for refining the estimate closer to historical variation.

## Advanced Pharmacy UI

For reviewed canonical finalized families, expose:
- `IP Drugs`
- `IP Treatment Supplies`

For each advanced bucket show:
- low amount
- typical amount
- high amount
- shortlisted items
- expected contribution
- cumulative share
- include/exclude toggle

The typical amount should update when shortlist selection changes.

## Grouped Adjustments UI

For each grouped residual row show:
- grouping
- FC bucket
- presence rate
- grouped p25 / p50 / p75 amount
- captured-by-default amount
- selected add-on amount already consuming the group
- net residual low / typical / high
- include/exclude state
- selected amount
- explanation

## Service Add-Ons UI

For each add-on show:
- select/include toggle
- item code
- item name
- original FC bucket
- grouping
- presence %
- quantity p25/p50/p75
- rates by room where applicable

## Output Blocks

The UI should organize outputs into:
- estimate summary
- bucket breakdown
- line-item detail
- warnings / alerts

Recommended output behavior:
- estimate summary shows headline low / typical / high
- breakdown shows bucket totals
- line-item detail shows selected quantities and selected amounts
- warnings show unresolved or out-of-range conditions

## Warning And Alert States

The UI should explicitly surface:
- service-line-count alert
- unresolved tariff
- unresolved item mapping
- missing consultation or service rate
- basis resolver note

The service-line-count alert should compare current included non-pharmacy count against historical p25/p75 range and show:
- below historical range
- within historical range
- above historical range

## Workbook Concepts To Convert

Map workbook concepts to UI as follows:
- sheet tabs => UI sections or accordions
- drop-down validation lists => app dropdowns
- include/exclude cells => toggles
- computed formula cells => read-only computed values
- hidden reference sheets => backend data sources or hidden client state

The UI should reproduce the logic, not the spreadsheet layout.
