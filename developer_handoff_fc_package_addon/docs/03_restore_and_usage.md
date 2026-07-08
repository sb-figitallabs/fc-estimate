# Restore And Usage

## Restore Order

1. Restore the previously shared base FC handoff database.
2. Apply `database/fc_handover_package_addon_schema.sql`.
3. Restore `database/fc_handover_package_addon_data.sql`.

## Primary Runtime Surface

Use:
- `fc.v_package_runtime_lookup`

Historical evidence surface:
- `fc.v_package_case_history`

## Sample Queries

Cash package lookup:

```sql
select *
from fc.v_package_runtime_lookup
where tariff_code = 'TR1'
  and package_code = 'CAR0122';
```

GIPSA package lookup:

```sql
select *
from fc.v_package_runtime_lookup
where organization_cd = 'ORG55'
  and tariff_code = 'TR290'
  and package_code = 'CAR0122';
```

Non-GIPSA package lookup:

```sql
select *
from fc.v_package_runtime_lookup
where tariff_code = 'TR201'
  and package_code = 'CAR0122';
```

Alias lookup:

```sql
select *
from fc.package_alias
where normalized_alias_text = lower('coronary angiogram (cag)');
```

History lookup:

```sql
select *
from fc.v_package_case_history
where tariff_code = 'TR201'
  and package_code = 'CAR0122';
```

## Expected Runtime Behavior

- direct package hits should use `tariff_code + package_code` first
- exact package-name hits should also resolve directly
- alias search should use `fc.package_alias`
- if no package resolves, return `no package exists`
- FC history should be shown as supporting evidence only
