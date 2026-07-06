# Overview

## Goal

Build the Phase 1 FC Estimate Builder from the clean FC database and expose it through an application UI instead of Excel.

## Audience

This handoff is written for the implementation developer who will build the new FC estimate experience.

## In Scope

- tariff resolution
- organization to tariff mapping
- consultation estimate lookup
- service estimate lookup
- pharmacy estimate lookup
- cash vs insurance behavior
- room / ward selection logic
- item-level bucketing and grouping
- unresolved-item and warning behavior

## Out Of Scope

- bill auditing
- policy-review or audit workflows
- Excel formulas as product artifacts
- workbook-specific assembly behavior
- package-master-backed estimate flows in Phase 1
- Supabase Studio assumptions

## Product Direction

The new builder should be:
- UI-first
- DB-backed
- logic-driven
- explicit about unresolved items and warnings

The clean FC database is the operating source of truth for Phase 1. The old scripts are only there to explain how current logic was derived.
