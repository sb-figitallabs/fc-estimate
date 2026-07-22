-- ============================================================================
-- NME Phase-1 — historical HIMS NME source + cohort profiles
-- ----------------------------------------------------------------------------
-- Manager 21-Jul (knowledge_inputs/i23.md + FC_Data_Developer_Ingestion_Guide):
-- the true NME modelling target is the hospital-supplied `HIMS NME Amount (Rs.)`
-- from RawData/FC Data/Estimate-Variance-Report (1).csv — NOT the package-bill
-- `package_bill_admissions.nme_amount` (that set is ~all zero: 192/17,002 > 0).
--
-- Constraint (manager): import ONLY for IP numbers already present in our DB
-- (fc.package_bill_admissions.ip_no), and only the relevant fields — no PII, no
-- noisy columns. HIMS NME (historical actual) and FC NME (counsellor estimate)
-- are kept as SEPARATE fields; negative HIMS NME rows are quarantined.
--
-- Idempotent DDL. Populate via scripts/backfill-nme.js.
-- ============================================================================

-- 1) Per-admission NME source (present IPs only, lineage-preserving) ----------
CREATE TABLE IF NOT EXISTS fc.fc_nme_source (
  ip_no            TEXT PRIMARY KEY,   -- normalized; must exist in package_bill_admissions
  hims_nme_amount  NUMERIC,            -- HISTORICAL ACTUAL — the modelling target
  fc_nme_amount    NUMERIC,            -- counsellor estimate — comparison evidence only
  payer_type       TEXT,              -- raw EVR label (INSURANCE/PRIVATE/CORPORATE/…)
  department_name  TEXT,
  procedure_name   TEXT,
  estimate_type    TEXT,
  is_package       BOOLEAN,           -- EVR "IS PACKAGE" (FC selection, not final truth)
  package_amount   NUMERIC,
  final_bill       NUMERIC,
  room_stay        NUMERIC,
  icu_stay         NUMERIC,
  length_of_stay   NUMERIC,
  admission_date   DATE,
  discharge_date   DATE,
  is_negative_nme  BOOLEAN NOT NULL DEFAULT false,  -- quarantine: exclude from modelling
  final_estimate_date DATE,           -- canonical-selection tie-break when >1 EVR row/IP
  source_file      TEXT NOT NULL,     -- lineage
  source_row       INT,               -- lineage
  loaded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fc_nme_source_dept   ON fc.fc_nme_source (department_name);
CREATE INDEX IF NOT EXISTS idx_fc_nme_source_posnme ON fc.fc_nme_source (hims_nme_amount) WHERE hims_nme_amount > 0;

-- 2) Cohort NME profiles (positive-probability + positive-value percentiles) --
-- Specificity ladder (cohort_level): 1 = payer+package+department+LOS+ICU,
-- 2 = payer+package+department, 3 = payer+package (global fallback). Percentiles
-- are over POSITIVE HIMS NME only; positive_prob carries the chance of any NME.
-- Built ONLY over governed-clean admissions (package_bill_admissions.matched_in_mart),
-- excluding quarantined negatives. Cash is retained for audit but the insurance
-- flow uses insurance buckets (guide §7: keep Cash out of the insurance model).
CREATE TABLE IF NOT EXISTS fc.nme_profile (
  cohort_level    INT  NOT NULL,   -- 1 (most specific) .. 3 (global fallback)
  payer_bucket    TEXT NOT NULL,   -- Cash | GIPSA Insurance | Non-GIPSA Insurance | Corporate | International
  package_status  TEXT NOT NULL,   -- Open Bill | Package Bill | All
  department      TEXT NOT NULL,   -- department name | All
  los_band        TEXT NOT NULL,   -- 0-2 | 3-5 | 6-10 | 11+ | All
  icu_band        TEXT NOT NULL,   -- 0 | 1-2 | 3+ | All
  admissions      INT  NOT NULL,   -- modelling-eligible admissions in cohort
  positive_count  INT  NOT NULL,   -- admissions with HIMS NME > 0
  positive_prob   NUMERIC,         -- positive_count / admissions
  p25 NUMERIC, p50 NUMERIC, p75 NUMERIC, p80 NUMERIC,   -- POSITIVE-only percentiles
  p50_incl_zero NUMERIC, p75_incl_zero NUMERIC,          -- zero-inclusive (audit only)
  blended     BOOLEAN NOT NULL DEFAULT false,  -- 15-29 sample blended with parent cohort
  last_seen   DATE,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cohort_level, payer_bucket, package_status, department, los_band, icu_band)
);

CREATE INDEX IF NOT EXISTS idx_nme_profile_lookup
  ON fc.nme_profile (payer_bucket, package_status, department, los_band, icu_band);
