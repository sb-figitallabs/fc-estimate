-- 001_robotic_classification.sql
-- DB-level robotic classification (todo-15jul #28, built on the #9 finding that
-- the classification must run PER PAYOR GROUP).
--
-- The repo has no prior migrations/ directory — DDL so far lived inside loader
-- scripts (see scripts/load-package-bills.js). This file starts the numbered
-- convention; it is fully idempotent (IF NOT EXISTS only) and is applied
-- automatically by scripts/backfill-robotic-classification.js, which also
-- (re)computes the data. New tables only — no existing table is altered.
--
-- Four layers:
--   1. fc.robotic_family_classification  — per treatment family × payor group
--   2. fc.robotic_tariff_addon_rate      — contracted robotic line items per tariff
--   3. fc.robotic_package_classification — per package (tariff_code + package_code)
--   4. fc.robotic_admission_classification — per historical IP admission
--
-- Robotic detection everywhere = the engine's own signal (services.js
-- isRoboticText): /ROBO/i over item code, item name, mapped grouping and
-- mapped fc_estimate_bucket, minus 'remove'-category rows.

CREATE SCHEMA IF NOT EXISTS fc;

-- ---------------------------------------------------------------------------
-- 1) Treatment-family level, one row per (family, payor_group).
--    payor_group ∈ 'Cash' | 'GIPSA Insurance' | 'Non-GIPSA Insurance' | 'All Payers'.
--    robotic_presence_rate reproduces the engine's roboticPresenceInfo()
--    (max presence among robotic signal items in the basis cohort) so the
--    persisted number and the live estimate number can never disagree.
CREATE TABLE IF NOT EXISTS fc.robotic_family_classification (
  family                    text        NOT NULL,   -- key from cohort.js listFamilies()
  payor_group               text        NOT NULL,
  family_label              text,
  family_kind               text,                   -- surgical | medical | daycare
  is_robotic_family         boolean     NOT NULL DEFAULT false, -- the family itself is a robotic curation
  base_family               text,                   -- conventional base for robotic families (ROBOTIC_BASE_FAMILY)
  cohort_cases              integer     NOT NULL DEFAULT 0,
  robotic_presence_rate     numeric,                -- engine-parity %, 0–100
  robotic_signal_cases      integer,                -- admissions behind the winning signal item
  robotic_signal_item_code  text,
  robotic_signal_item_name  text,
  robotic_admission_cases   integer,                -- admissions with ANY robotic-signal line
  robotic_admission_rate    numeric,                -- robotic_admission_cases / cohort_cases %
  robotic_capable           boolean     NOT NULL DEFAULT false, -- any robotic signal in this payor group
  robotic_default_included  boolean     NOT NULL DEFAULT false, -- engine 90% rule (> 90)
  refreshed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family, payor_group)
);

-- ---------------------------------------------------------------------------
-- 2) Contracted robotic line items per tariff, folded per ward group the way
--    the engine folds fc.service_tariff_rate_matrix (artifacts.js
--    tariffRateLookup). e.g. TR290 'CHARGES FOR ROBOTIC TKR' ≈ ₹1,20,000.
CREATE TABLE IF NOT EXISTS fc.robotic_tariff_addon_rate (
  tariff_cd      text        NOT NULL,
  service_cd     text        NOT NULL,
  service_name   text,
  charge_general numeric,
  charge_twin    numeric,
  charge_single  numeric,
  charge_icu     numeric,
  charge_other   numeric,    -- max charge over unrecognised ward groups (daycare/deluxe/…)
  charge_max     numeric,    -- max over all ward groups — the headline contracted rate
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tariff_cd, service_cd)
);

-- ---------------------------------------------------------------------------
-- 3) Package level, one row per (tariff_code, package_code) from
--    fc.package_master. Historical robotic billing is aggregated by
--    package_code across tariffs (manager rule: the CODE is package identity)
--    and stamped on every tariff row carrying that code.
CREATE TABLE IF NOT EXISTS fc.robotic_package_classification (
  tariff_code               text        NOT NULL,
  package_code              text        NOT NULL,
  package_name              text,                   -- representative name (min()); code defines identity
  is_robotic_package        boolean     NOT NULL DEFAULT false, -- package name/code carries the robotic signal
  robotic_addon_available   boolean     NOT NULL DEFAULT false, -- a contracted robotic item exists in this tariff
  robotic_addon_item_code   text,
  robotic_addon_item_name   text,
  robotic_addon_rate        numeric,                -- charge_max of the picked add-on item
  robotic_addon_match       text,                   -- 'name_token' (add-on shares a word with the package) | 'tariff_generic'
  hist_cases_total          integer,                -- mart-matched admissions billed under this package_code
  hist_cases_cash           integer,
  hist_cases_gipsa          integer,
  hist_cases_nongipsa       integer,
  robotic_cases_total       integer,                -- of those, admissions with robotic actually billed
  robotic_cases_cash        integer,
  robotic_cases_gipsa       integer,
  robotic_cases_nongipsa    integer,
  robotic_presence_overall  numeric,                -- %
  robotic_presence_cash     numeric,
  robotic_presence_gipsa    numeric,
  robotic_presence_nongipsa numeric,
  robotic_capable           boolean     NOT NULL DEFAULT false, -- robotic package OR add-on contracted OR robotic billed in history
  refreshed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tariff_code, package_code)
);
CREATE INDEX IF NOT EXISTS idx_robotic_pkg_code ON fc.robotic_package_classification (package_code);

-- ---------------------------------------------------------------------------
-- 4) IP-admission level, one row per admission seen in mart.main_table
--    (admission_no) and/or fc.package_bill_admissions (ip_no).
--    robotic_billed = a robotic-signal line exists on the admission in either
--    source; amounts are kept per source (mart services_json amounts vs
--    package-bill billed portion rate×ex_qty).
CREATE TABLE IF NOT EXISTS fc.robotic_admission_classification (
  ip_no                        text        PRIMARY KEY,
  in_mart                      boolean     NOT NULL DEFAULT false,
  in_package_bills             boolean     NOT NULL DEFAULT false,
  payor_bucket                 text,       -- mart payor group (Cash / GIPSA Insurance / Non-GIPSA Insurance / Corporate)
  payer_type                   text,       -- package-bill export payer type
  p_tariff_cd                  text,       -- package-bill tariff
  organization_name            text,
  package_code                 text,       -- mart package code (bills export carries names only)
  package_name                 text,
  robotic_billed               boolean     NOT NULL DEFAULT false,
  mart_robotic_line_count      integer     NOT NULL DEFAULT 0,
  mart_robotic_amount          numeric,    -- Σ amount of robotic service lines (mart services_json)
  bill_robotic_line_count      integer     NOT NULL DEFAULT 0,
  bill_robotic_billed_amount   numeric,    -- Σ rate×ex_qty of robotic bill lines (actually billed)
  bill_robotic_consumed_amount numeric,    -- Σ amount of robotic bill lines (incl. in-package consumption)
  robotic_amount               numeric,    -- headline: bill billed amount, else mart amount
  robotic_examples             jsonb,      -- sample robotic lines {code,name,amount} for review
  refreshed_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_robotic_adm_pkg    ON fc.robotic_admission_classification (package_code);
CREATE INDEX IF NOT EXISTS idx_robotic_adm_billed ON fc.robotic_admission_classification (robotic_billed);
