# Lookup Contract

## Direct Lookup

Preferred direct paths:
- `tariff_code + package_code`
- `tariff_code + package_name`

Insurance and GIPSA can also include:
- `organization_cd`

## Alias Lookup

If direct package identity is missing:
- normalize the raw treatment/package text
- search `fc.package_alias`
- resolve the matched alias back to the canonical package row

## Output Contract

Primary package output should come from:
- `fc.v_package_runtime_lookup`

Historical evidence should come from:
- `fc.v_package_case_history`

Important rule:
- do not use FC history to fabricate package documentation
- package documentation must come from the curated package-serving fields

## No-Match Behavior

If neither direct lookup nor alias lookup resolves to a canonical package row:
- return `no package exists`

Do not silently invent a best guess.
