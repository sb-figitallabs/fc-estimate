# Input / Output Contract

## Input Shape

The UI/backend should provide enough information to resolve:
- payor bucket
- organization code
- stay type
- management type
- room or ward context
- doctor / consultation items
- service items
- pharmacy items
- optional admission reference

## Minimal Input Fields

- `payor_bucket`
- `organization_cd`
- `stay_type`
- `management_type`
- `ward_group_name` or normalized room context
- `doctor_cd` when consultation pricing is needed
- `service_items[]`
- `pharmacy_items[]`

Optional:
- `admission_no`
- `patient_name`
- `department_name`
- `doctor_name`

## Suggested Service Item Payload

```json
{
  "canonical_item_key": "HSP5013",
  "item_code": "HSP5013",
  "item_name": "Example Service",
  "quantity": 1
}
```

## Suggested Pharmacy Item Payload

```json
{
  "canonical_item_key": "MED123",
  "item_code": "MED123",
  "item_name": "Example Drug",
  "quantity": 2
}
```

## Output Shape

Return:
- resolved context
- estimate sections
- totals
- warnings
- unresolved items

## Suggested Output Sections

- `resolved_context`
  - payor bucket
  - organization
  - tariff
  - room/ward context
- `consultations`
- `services`
- `pharmacy`
- `totals`
- `warnings`
- `unresolved_items`

## Output Expectations

- every itemized line should preserve traceability fields
- every unresolved line should identify why it failed
- totals should remain explainable from the resolved line items
