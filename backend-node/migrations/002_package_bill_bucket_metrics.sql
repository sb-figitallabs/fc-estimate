-- 16-Jul (manager note ¶1): Historic Metrics for PACKAGE bills, at bucket
-- level — what rides ABOVE the package (billed exclusions), classified into
-- the same buckets the estimate uses, per package code × payor group.
-- Refresh via scripts/backfill-package-bill-buckets.js (idempotent).

CREATE TABLE IF NOT EXISTS fc.package_bill_bucket_metrics (
  package_code   TEXT NOT NULL,   -- master identity (same code = one package, name variants merged)
  payor_group    TEXT NOT NULL,   -- Cash | GIPSA Insurance | Non-GIPSA Insurance | Corporate | All Payers
  bucket         TEXT NOT NULL,   -- Pharmacy / Implants / Investigations / Procedure / OT Charges / Room Charges / Professional Fees / Bedside Services / Other / Miscellaneous
  admissions     INT  NOT NULL,   -- single-package (non-combo) billed admissions in this cohort
  presence_cases INT  NOT NULL,   -- of those, admissions with >0 extras in this bucket
  -- per-admission extras in this bucket, across admissions WHERE present
  -- (grouping-gaps convention): what a patient who gets charged this bucket
  -- above the package typically pays.
  p25 NUMERIC,
  p50 NUMERIC,
  p75 NUMERIC,
  avg_amount NUMERIC,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_code, payor_group, bucket)
);

CREATE INDEX IF NOT EXISTS idx_pbbm_code_payor
  ON fc.package_bill_bucket_metrics (package_code, payor_group);
