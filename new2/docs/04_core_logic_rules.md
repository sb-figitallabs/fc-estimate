# Core Logic Rules

## Payor Logic

- `Cash` cases use `TR1 / KIMS`.
- `General Patients` and `GENERAL` should also resolve to `TR1 / KIMS`.
- Non-cash cases should resolve tariff using `fc.organization_tariff_mapping`.
- If tariff resolution fails, the builder should not silently guess another tariff.

## Tariff Resolution

- Primary insurance resolution key: `organization_cd`
- Resolved output:
  - `tariff_cd`
  - `tariff_name`
- Service and investigation rates then come from `fc.service_tariff_rate_matrix`.
- Consultation rates come from `fc.consultation_tariff_rate_matrix`.
- Basis selection for service, pharmacy, and PF is documented separately in `14_payer_basis_and_payor_selection_rules.md`.

## Consultation Lookup

- Primary consultation lookup grain:
  - `tariff_name + doctor_cd + ward_group_name`
- Use `tariff_cd` only as helper metadata.
- Preserve unresolved consultation cases as warnings instead of auto-rewriting them.

## Service Rate Lookup

- Primary service rate lookup grain:
  - `tariff_cd + service_cd + ward_group_name`
- `rate_domain` remains important because both `service` and `investigation` live in the same matrix.
- Do not use `service_name` as an identifier key.

## Room / Ward Logic

- Room category is derived from ward/service signals.
- Current room-category inference rules:
  - ICU-family labels map to `icu`
  - `HDU` maps to `hdu`
  - `SINGLE` maps to `single`
  - `TWIN` maps to `twin`
  - `GENERAL` maps to `general`
  - `DAY CARE` or `DAYCARE` maps to `daycare`
  - `DELUXE` maps to `deluxe`
- Primary commercial room category prefers:
  - `Single`
  - then `Deluxe`
  - then `Twin`
  - then `General`
- LOS normalization, ICU/ward reconciliation, OT-hour derivation, and cath-lab derivation are documented in `15_normalization_rounding_and_derived_fields.md`.

## Main Table Usage

- `mart.main_table` is authoritative for case context already materialized into the clean DB.
- Use it for:
  - payor / organization context
  - stay context
  - room category context
  - benchmark FC actual totals
- The app should still recompute builder outputs from the clean FC lookup tables rather than blindly treating stored actuals as estimate outputs.

## Cash Drug Administration Logic

- Drug administration charge applies only to cash.
- Formula:
  - cash drug administration charge = `12.5%` of `pharmacy_total`
- For non-cash:
  - drug administration charge = `0`
- Adjusted cash total:
  - `fc_actual_total_excluding_fnb_and_returns + cash_drug_administration_charge`

## Edge-Case Rule Families

- Robotic-charge defaults, implant behavior, emergency-origin rules, and MLC detection are documented in `17_edge_cases_robotic_implants_emergency_mlc.md`.
- PF family behavior is documented in `16_professional_fee_logic.md`.

## Failure And Warning Behavior

- Missing tariff mapping: warning or blocking unresolved state
- Missing service mapping: unresolved item
- Missing pharmacy mapping: unresolved item
- Missing tariff rate row: unresolved estimate component
- Missing consultation rate row: unresolved estimate component
- Missing basis-resolution evidence: preserve the resolver warning and surface the chosen fallback explicitly
- Missing implant / robotic / grouped-adjustment support rows: treat as unresolved detail rather than silently guessing

The builder should prefer explicit warnings over hidden fallbacks.
