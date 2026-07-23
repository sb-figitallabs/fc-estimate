# GIPSA Package LOS Ingestion — Next Actions (2026-07-23)

**Source:** `~/Downloads/gipsa Pkg def Master.xlsx` (manager-provided, 2026-07-23).
**Manager's constraint (verbatim):** *"The GIPSA workbook is authoritative for package LOS and ICU/ward allocation only. It is NOT authoritative for package rates. Rates must come from the current TR290 rows in the Service All TR master."*

## What the file is (profiled)
- **223 GIPSA "Operation Packages"**, all `TARIFFCD=TR217` / `KIMSI_GIPSA_24`, all active.
- Per package (`PKGCD`): `PKGDURATION` (total in-package days), **`ICU` days + `Ward` days** (the split we've been missing), `PREDAYS`/`POSTDAYS`, effective dates, department, and combo factors `PRIORITY1..4 = 100/50/25/25`.
- Data quirks: some codes carry stray spaces (`"E N T0018"` → `ENT0018`) — must normalize; **66/223 are 1-day daycare/observation** rows (`ICU=Ward=0, DUR=1`) — keep 0/0.
- `PKGAMOUNT` is present but **must be ignored** (not a rate source).

## Why this matters — it directly unblocks T10 with (almost) no engine code
The engine is **already built to consume the split.** `outsidePackageLos.js` uses a **`per_setting_ledger`** basis when a ward/ICU breakdown is present, and falls back to `total_los_no_breakdown` when it isn't. `buildEstimate.js:1314-1315` sources it from `packageOffer.package.pkg_defined_ward_stay` / `pkg_defined_icu_stay`.

**But `fc.package_master` has no such columns today** (only `package_duration`, `pre_days`, `post_days`) → the engine always reads null → always uses the total-LOS fallback. Populating these from the workbook flips GIPSA overstays to the per-setting ledger the manager approved in T10 — *"per-setting ledger only when a ward/ICU breakdown exists."*

**Coverage measured:** 220/223 workbook codes match TR290 packages in our master (221/223 under any tariff). Unmatched: `GYN5069`, `OPT0262`, `OPT0260` → report to hospital.

## Ingestion design (keyed to the manager's LOS-only constraint)
Join key: **normalized `PKGCD` → `fc.package_master.package_code` WHERE `tariff_code='TR290'`.** Only LOS/allocation columns are written; **no rate column is touched** (rates keep coming from the TR290 service tariff rows, unchanged).

### Step 1 — Migration (additive, non-destructive)
`ALTER TABLE fc.package_master` add:
- `pkg_defined_ward_stay numeric` — from workbook `Ward`
- `pkg_defined_icu_stay numeric` — from workbook `ICU`
- `los_source text` — provenance stamp (`'gipsa_workbook_2025-07'`)

(`package_duration`/`pre_days`/`post_days` already exist.)

### Step 2 — ETL loader `scripts/load-gipsa-package-los.js` (scaffolded, `--dry-run` default)
Reads the xlsx via `exceljs`, normalizes `PKGCD`, and for each match on `(tariff_code='TR290', package_code)`:
- sets `pkg_defined_ward_stay = Ward`, `pkg_defined_icu_stay = ICU`, `los_source`.
- **Number-changing (flag for explicit OK):** optionally refresh `package_duration`/`pre_days`/`post_days` from the workbook (LOS-authoritative per the manager) — this shifts the LOS *default* for these 220 packages, so it changes base estimates. Gate behind `--refresh-duration`.
- Prints matched / unmatched / duration-deltas; writes nothing unless `--apply`.

### Step 3 — Expose the columns
Add `pkg_defined_ward_stay`, `pkg_defined_icu_stay` to the `SELECT` in `packages.service.js` so they ride into `packageOffer.package`. (T10 then activates automatically — no `outsidePackageLos.js` change.)

### Step 4 — Verify
Build a GIPSA package case with an overstay → confirm `outside_package_los.basis` flips from `total_los_no_breakdown` to `per_setting_ledger`, and that unused ward days no longer offset excess ICU days. Run sanity 24/0 + 12/0.

## Guard-rails / decisions to confirm before `--apply`
1. **Rates untouched** — confirmed by design (no rate/amount column written; TR290 service tariff stays the rate source). ✔
2. **`package_duration` refresh** = a real number change (LOS default) → **needs the manager's explicit OK** (his re-review gate). Recommend: ship the ward/ICU split first (enables per-setting ledger for overstays), hold the duration refresh for a diff review.
3. **3 unmatched codes** (`GYN5069`, `OPT0262`, `OPT0260`) → hand back to hospital; skip in the loader.
4. Cross-check: the workbook's `PRIORITY1..4 = 100/50/25/25` **confirms the T1 combo factors** — no action, just corroboration.

## Sequence
1. Apply migration to dev branch DB → run loader `--dry-run` → review matched/unmatched + duration-deltas.
2. `--apply` the ward/ICU split (not `--refresh-duration`) to dev → expose columns → verify T10 flips + sanity.
3. Deploy to dev.hospitalos; show the manager a GIPSA overstay before/after.
4. On his OK: promote, and separately decide on `--refresh-duration`.
