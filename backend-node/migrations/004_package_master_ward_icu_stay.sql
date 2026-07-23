-- ============================================================================
-- GIPSA package LOS — ward/ICU allocation on package_master
-- ----------------------------------------------------------------------------
-- Manager 23-Jul (gipsa Pkg def Master.xlsx): the GIPSA workbook is authoritative
-- for package LOS and ICU/ward allocation ONLY — NOT for rates (rates stay from
-- the current TR290 rows in the Service All TR master). This adds the ward/ICU
-- split columns the engine already reads (buildEstimate.js →
-- packageOffer.package.pkg_defined_ward_stay / pkg_defined_icu_stay), which
-- flips outsidePackageLos.js (T10) from `total_los_no_breakdown` to the
-- manager-approved `per_setting_ledger` for GIPSA overstays.
--
-- Additive & idempotent. No rate/amount column is touched. Populate via
-- scripts/load-gipsa-package-los.js (LOS/allocation only; --refresh-duration is
-- a separate, gated number-changing step).
-- ============================================================================

ALTER TABLE fc.package_master
  ADD COLUMN IF NOT EXISTS pkg_defined_ward_stay NUMERIC,   -- workbook `Ward` days
  ADD COLUMN IF NOT EXISTS pkg_defined_icu_stay  NUMERIC,   -- workbook `ICU` days
  ADD COLUMN IF NOT EXISTS los_source            TEXT;      -- provenance, e.g. 'gipsa_workbook_2025-07'
