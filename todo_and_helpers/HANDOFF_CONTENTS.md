# Handoff Folder — Contents Guide

A map of everything in `~/Downloads/handoof/`. This handoff is for rebuilding the
**Phase 1 FC Estimate Builder** (Financial Counselor estimate tool) as a clean,
UI-first, DB-backed application — replacing the old Excel workbooks.

**Manager's intent (from `knowledge_inputs/`):** use the database + the logic docs
+ a sense of the end deliverable, and write **clean new scripts** — do NOT reuse the
reference scripts as runtime architecture. They are logic backstop / traceability only.

**Scope:** non-package FC estimate flow (tariff resolution, item mapping, room logic,
cash vs insurance, builder controls). **Out of scope for Phase 1:** bill auditing,
package-master-backed estimates, org-name alias handling, Excel-as-architecture.

> **Which pack is current?** There are now three copies of the docs/scripts pack.
> **`new2/` is the latest and strongest** (adds docs 14–17, tightens 8 core docs, adds
> 4 reference scripts — per `knowledge_inputs/i3.md`). The **DB dump is unchanged** and
> only lives in `developer_handoff_fc_estimate_builder/database/`. So: **read logic from
> `new2/`, restore the DB from `developer_handoff_fc_estimate_builder/database/`.**
> `new/` is an older docs-only copy and can be ignored.

---

## Top-level files

| File | What it is |
|------|-----------|
| `Tariff code plus package code combo  - Sheet1.csv` | 637-row reference table: every `tariff_code + package_code` combo (KIMS/TR1) with observed case counts, distinct amounts, and min/max/observed amounts broken down by **payor bucket** and **room category** (daycare / general / twin / single / deluxe / unknown). Use as historical price-band reference per package × room type. |
| `fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx` | A **finalized example workbook** (Robotic TKR unilateral right, cash, TR1). This is the "target behavior" artifact the docs describe. 16 sheets: `Builder`, `Estimate Summary`, `Estimate vs IP FC Actuals`, `Advanced Controls`, `Service Add-Ons`, `Grouped Adjustments`, `Grouping Review`, `Implant Selection`, `Estimate Breakdown`, `Line Item Detail`, `Pharmacy Template`, `Service Template`, `Pharmacy Metrics`, `IP FC Actuals`, `Professional Fees Review`, `Reference`. Open it to see the control model the UI must reproduce. |

---

## `knowledge_inputs/` — Manager's inputs (read FIRST)

| File | What it is |
|------|-----------|
| `i1.md` | Manager's own walkthrough of the `developer_handoff_fc_estimate_builder` pack — a one-line description of every folder, doc, and script (the original inventory). |
| `i2.md` | One-line directive: *"the agent should have the database + logics + a sense of the deliverable and build its own clean scripts, not use mine."* This is the guiding constraint. |
| `i3.md` | Update note announcing the **strengthened `new2/` pack**: 4 new docs (14–17), tightened core docs/README, 4 new reference scripts. Explicitly states **the DB dump did NOT change** — this was a docs + reference-pack pass only. |

---

## `developer_handoff_fc_estimate_builder/` — The authoritative handoff pack

The real deliverable. Contains the DB dump, 13 logic docs, and 13 reference scripts.

### `README.md`
Entrypoint: scope, reading order (docs 01→13), what's authoritative, Phase 1 boundary,
and the rule that old scripts are reference-only.

### `database/`

| File | What it is |
|------|-----------|
| `RESTORE.md` | Short note: what the dump is + restore into a dedicated Postgres for the FC builder. |
| `fc_handover_phase1_clean.sql` | **The clean DB dump** (~462k lines). Schema + data for 7 business tables (see schema below). This is the operating source of truth for Phase 1. |

**The 7 tables (from `docs/02_database_schema.md`):**

| Table | Grain / key | Purpose | Rows |
|-------|-------------|---------|------|
| `mart.main_table` | one row per admitted case (`main_table_key`) | historical case context, prefilled tariff/payor/stay/room, FC-actual benchmark totals | 14,202 |
| `fc.service_item_mapping` | one row per `canonical_item_key` | service item → FC bucket / grouping / billing head / sub-head / room-dependency | 1,639 |
| `fc.pharmacy_item_mapping` | one row per `canonical_item_key` | pharmacy item → classification / FC bucket / grouping / IP-vs-OT flags | 8,578 |
| `fc.pharmacy_catalog_rate_reference` | one row per canonical pharmacy item | MRP / sale_rate reference (NOT a bucket table) | 7,630 |
| `fc.service_tariff_rate_matrix` | `tariff_cd + rate_domain + service_cd + ward_group_name` | service & investigation rate lookup | 394,163 |
| `fc.consultation_tariff_rate_matrix` | `tariff_name + doctor_cd + ward_group_name` | consultation pricing (charge / revisit / emergency) | 35,372 |
| `fc.organization_tariff_mapping` | one row per `organization_cd` | KIMS org → tariff bridge (insurance tariff resolution) | 68 |

**Canonical joins:** `organization_cd` → org_tariff_mapping → `tariff_cd`; then
`tariff_cd + service_cd + ward_group_name` → service matrix; `tariff_name + doctor_cd + ward_group_name`
→ consultation matrix; `canonical_item_key` → the three item tables.

### `docs/` — 13 logic docs (read in numeric order)

| Doc | Contents (short note) |
|-----|-----------------------|
| `01_overview.md` | Product brief: goal, audience, in/out of scope, UI-first + DB-backed direction. |
| `02_database_schema.md` | Canonical DB contract — the 7 tables, grains, key columns, joins, row counts (table above). |
| `03_fc_estimate_flowchart.md` | End-to-end flow (input → payor → tariff → room → consult/service/pharmacy lines → rates → totals/warnings) + Mermaid decision flowchart. |
| `04_core_logic_rules.md` | Core business rules: cash→TR1/KIMS, tariff resolution, consultation/service lookup grains, room-category inference, **cash drug-admin = 12.5% of pharmacy_total** (0 for non-cash), warning-over-fallback behavior. |
| `05_item_level_logic.md` | Item mapping: `canonical_item_key` join, service/pharmacy bucket logic, rate reference usage, room-sensitive handling, unresolved-item → warning (never silent guess). |
| `06_input_output_contract.md` | API contract: minimal input fields, sample service/pharmacy item payloads (JSON), expected output sections (`resolved_context`, `consultations`, `services`, `pharmacy`, `totals`, `warnings`, `unresolved_items`). |
| `07_reference_scripts.md` | Which scripts matter & why — splits them into source-of-truth / control-model / validation / migration / historical-only. Lists modules to ignore for Phase 1. |
| `08_known_gaps_and_future_extensions.md` | Boundary doc: package-master estimation, org-name aliases, bill-audit, policy enforcement all NOT included → future extensions. |
| `09_builder_controls_and_percentile_logic.md` | The control model: `Low/Typical/High` = `P25/P50/P75`, `Manual` override, driver families (LOS/ICU/ward/OT), percentile artifact files, advanced pharmacy controls (shortlist + interpolation), service-line-count alert, payer-basis control. |
| `10_service_addons_and_grouped_adjustments.md` | Default included services vs optional add-ons vs grouped residuals; how add-on inclusion shrinks the matching grouped residual to avoid double counting. |
| `11_ui_control_model_from_finalized_builder.md` | Workbook→UI translation: top-level controls, driver block, advanced controls section, advanced pharmacy UI, grouped adjustments UI, add-ons UI, output blocks, warning states, sheet→section mapping. |
| `12_variant_notes.md` | What's canonical vs family-specific across builders: GMM (best canonical reference), chemo/daycare, surgical non-daycare. |
| `13_validation_against_finalized_workbooks.md` | How to validate the rebuild against finalized workbook behavior; reviewer acceptance checklist. |

### `scripts_reference/` — 13 Python reference scripts (logic backstop only)

> Priority order stated by the pack: **1) docs → 2) DB dump → 3) these scripts.**
> Do NOT copy these as runtime architecture.

| Script | Lines | What it references |
|--------|-------|--------------------|
| `common_supabase_db.py` | 3200 | Room-category derivation, FC-actual bucket logic, cash drug-admin formula, DB helpers. |
| `build_general_medical_management_cash_fc_estimate_builder.py` | 2058 | **Best canonical builder-control reference** — Low/Typical/High, P25/P50/P75/Manual, advanced pharmacy controls, add-ons, grouped adjustments. |
| `fc_estimate_assembly.py` | 1862 | Main estimate resolver — payor normalization, tariff resolution, estimate-context assembly. |
| `build_chemotherapy_cash_fc_estimate_builder.py` | 1390 | Variant/daycare control reference (family-specific differences). |
| `migrate_fc_lookup_tables_phase2.py` | 627 | How service & pharmacy canonical mapping tables were built. |
| `validate_surgical_non_daycare_cash_variants.py` | 564 | Validation reference — selected-controls / summary / estimate-vs-actual snapshots. |
| `migrate_fc_service_tariff_phase4.py` | 507 | How the service tariff matrix was built. |
| `migrate_fc_consultation_tariff_phase5.py` | 404 | How the consultation tariff matrix was built. |
| `migrate_fc_pharmacy_catalog_phase3.py` | 338 | How the pharmacy catalog rate/MRP table was built. |
| `migrate_fc_org_tariff_phase6.py` | 319 | How the KIMS org→tariff mapping was built. |
| `export_general_medical_management_fc_estimate_builder.py` | 271 | Historical/orchestration example only — NOT target architecture. |
| `fc_payer_basis_resolution.py` | 269 | Payer-basis resolution & fallback (`Auto (Recommended)`, component-level basis). |
| `export_fc_handover_sql_dump.py` | 180 | How the final clean DB dump was exported. |
| `README.md` | — | How to use the reference scripts + priority order. |

---

## `new2/` — **Strengthened pack (LATEST — use this for logic)**

Same structure as the original pack (`docs/` + `scripts_reference/` + `README.md`),
**no `database/` folder** (DB dump unchanged, still in `developer_handoff_.../database/`).
This is the current authoritative source for *logic*.

**4 new docs (14–17):**

| Doc | Contents (short note) |
|-----|-----------------------|
| `14_payer_basis_and_payor_selection_rules.md` | Full payer-basis model: 7 basis labels, `Auto (Recommended)` threshold-driven fallback (exact→Insurance All→All Payers→Cash), exact thresholds (surgical/daycare = 15, others = 20; fallback cohort = 25), recommendation statuses, confidence levels, independent `service_basis`/`pharmacy_basis`/`pf_basis` resolution. |
| `15_normalization_rounding_and_derived_fields.md` | LOS/ICU/ward normalization, same-day vs cross-day stay rules (with named reason codes), room-category + commercial-room precedence, OT-hours parsing (`OT - 2 1/2 HOURS`), cath-lab derivation, and **slot rounding** (snap to 2.0/2.5/3.0/3.5/4.0). |
| `16_professional_fee_logic.md` | PF split into **implementation-target families** (robotic TKR variants, THR) vs **review-only families** (GMM, chemo, CAG daycare); named-role PF breakdown (surgeon/assistant/anesthetist/etc.), p25/p50/p75 context, PF basis resolves independently. |
| `17_edge_cases_robotic_implants_emergency_mlc.md` | Robotic charge detection (`ROBO`/`ROBOTIC`) + auto-select threshold (presence > 90%), OT-consumables piecewise thresholds (≤0.30→P25, ≤0.50→P50, else P75), default-included vs optional service rules, grouped-residual auto/optional thresholds, implant hierarchy (family→brand→item), signal-based emergency-origin, MLC detection (code `HSP0047`, `MLC Desk`). |

**Docs 01–13 in `new2/` were tightened** (differ from the original in: 04, 05, 07, 08,
09, 10, 12, 13) to cross-reference the new payer-basis/normalization/PF/edge-case logic.
Read the `new2/` versions.

**4 new reference scripts** (added to `new2/scripts_reference/`):

| Script | Lines | What it references |
|--------|-------|--------------------|
| `export_robotic_tkr_fc_estimate_builder.py` | 6264 | Largest reference — robotic/implant surgical builder; source of truth for robotic detection, implant hierarchy, OT logic, PF modeling. |
| `test_main_table_fc_actuals.py` | 1918 | Tests for main_table FC-actuals — LOS/room normalization reason codes, emergency/MLC signal rules. |
| `export_fc_professional_fee_analysis.py` | 838 | PF analysis — the implementation-target vs review-only family split and named-role PF breakdown. |
| `test_surgical_workbook_logic.py` | 183 | Tests validating surgical workbook control behavior (thresholds, add-on ordering, grouped residuals). |

---

## `new/` — Older docs-only duplicate (ignore)

Byte-identical `docs/`, `scripts_reference/`, and `README.md` to the **original**
`developer_handoff_fc_estimate_builder/` pack, **missing the `database/` folder**.
Superseded by `new2/`. Ignore it.

---

## Suggested reading order

1. `knowledge_inputs/i2.md` + `i1.md` + `i3.md` — the mandate and the "what changed" note.
2. `new2/README.md`
3. `new2/docs/01` → `new2/docs/17` in order (the tightened + expanded set).
4. `developer_handoff_fc_estimate_builder/database/fc_handover_phase1_clean.sql` — restore + inspect the 7 tables (dump is unchanged).
5. Open the `.xlsx` example workbook to see the finalized control model in action.
6. Dip into `new2/scripts_reference/` only when a doc points you at a specific logic detail.

---

*This is a contents map only — no changes made to the current project.
Reference it when we later wire this into the Hospital_OS project.*
