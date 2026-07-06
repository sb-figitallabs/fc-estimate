I've now read the entire script and all supporting material. Here is the exhaustive implementation spec.

---

# FC Estimate Builder — Robotic TKR Unilateral Right (Cash / TR1) — Node.js Rebuild Spec

Derived from `export_robotic_tkr_fc_estimate_builder.py` (6264 lines), which produced `fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx`. The finalized workbook is built entirely by `rebuild_workbook()` → `build_guided_workbook()`, which creates 16 fresh sheets. Several template-based functions in the file (`write_sheet1`, `write_estimate_builder`, `write_pharmacy_variance`, `write_implants_sheet`, `write_services_selection`, and constants `DEFAULT_TEMPLATE_WORKBOOK`, `DEFAULT_PROFESSIONAL_FEES`, `BASE_ESTIMATE_BUILDER_TEMPLATE_ROWS`, `ESTIMATE_BUILDER_ALWAYS_ONE_ROWS`, `ESTIMATE_BUILDER_LOGIC_ROWS`, `DEFAULT_SERVICES_SELECTION_CODES`) are **legacy/unused in the final path** — `build_guided_workbook` never calls them. They are documented at the end for completeness but are NOT part of the rebuild.

Two important architecture notes for the Node port:
1. The Python script writes **live Excel formulas** that a spreadsheet engine (LibreOffice `soffice`, via `recalculate_workbook_with_soffice`) recalculates. A Node/Postgres backend should instead **compute the resolved values directly**, using the formulas below as the exact computation spec. The formulas encode all interaction logic (mode picks, room picks, insurance exclusion, grouped-residual netting, PF cascades).
2. The historical percentile/presence artifacts are **pre-computed CSV/JSON files** in the reference build. In the DB rebuild they must be recomputed from `mart.main_table` (JSONB) + `fc.*` tables. Section 1 gives the exact recompute recipe for each.

---

## 0. TOP-LEVEL PIPELINE (`rebuild_workbook` → `build_guided_workbook`)

Order of operations:
1. `load_builder_runtime_inputs(args)` — loads/normalizes all inputs (or a single `--builder-input-pack-json`).
2. Load cath-lab metrics, service-line-count metrics, resolution rows, PF payor summary, grouping-gap summary+child, TR1 rate lookup, OT slot rows, org-tariff reference, tariff rate matrix, tariff OT slot matrix, insurance policy.
3. `clean_services_for_fc(service_rows)` → `(cleaned, auto_included, optional)`; then `filter_out_cath_lab_slot_rows`; write cleaned services CSV.
4. `build_guided_workbook(...)`:
   - `clean_services_for_fc` again → cleaned/auto/optional.
   - `prioritize_optional_service_rows(optional, rate_lookup)`.
   - `split_robotic_optional_service_rows(optional, procedure_code)` → `(optional, robotic_service_rows)`.
   - `args.robotic_service_rows = collect_robotic_service_rows(cleaned, procedure_code, include_procedure_row)`.
   - `args.robotic_optional_service_count = len(robotic_service_rows)`.
   - `args.robotic_charge_presence_rate = compute_robotic_charge_presence_rate(collect_robotic_presence_signal_rows(service_rows, procedure_code))`.
   - `args.robotic_default_selection = resolve_robotic_default_selection(default_mode, presence_rate, presence_threshold)`.
   - `grouped_adjustment_rows = build_grouped_residual_candidates(grouping_gap_summary_rows)`.
   - `insurance_excluded_groupings = build_insurance_excluded_groupings(grouping_gap_child_rows, insurance_policy_rows)`.
   - Create 16 sheets (order below), write each, then **set all `freeze_panes = None`** (validation requires no freeze panes and no merged cells in the final file).
5. Save; recalc with soffice; `validate_generated_surgical_workbook` (checks sheet order == 16 expected, no freeze panes, no merged ranges, `Estimate Summary!E2` non-blank, breakdown col J total == final estimate within 0.5, OT slot resolution consistency, OT ≤ Procedure bucket).

Sheet creation order (also the required saved order):
`Builder, Estimate Summary, Estimate vs IP FC Actuals, Advanced Controls, Service Add-Ons, Grouped Adjustments, Grouping Review, Implant Selection, Estimate Breakdown, Line Item Detail, Pharmacy Template, Service Template, Pharmacy Metrics, IP FC Actuals, Professional Fees Review, Reference`.

---

## 1. DATA SOURCES

### 1a. Database (live query in the reference build)
Only one direct DB query exists, in `fetch_main_rows_for_admissions()`:
```sql
select admission_no, patient_name, los_days, payor_bucket, organization_name,
       patient_type, organization_cd, surgical_medical, services_json, pharmacy_json
from mart.main_table
where admission_no = any(%s)
order by admission_no
```
Connection: `psycopg.connect(os.getenv("SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"))`. The `admission_no` list comes from the per-IP bucket CSV. `services_json` (list) and `pharmacy_json` (dict with `returns[]`) are read from JSONB.

### 1b. Artifact files consumed (all default under `.../robotic_tkr_unilateral_right_three_csvs/` unless noted)
Note: the reference file names differ from the generic names in the task prompt. Mapping and recompute recipe for each:

| Arg / const | File | Contents | Recompute from DB |
|---|---|---|---|
| `--quartiles-json` | `17_los_icu_ward_ot_quartiles.json` | `{"metrics": {"los_days":{p25,p50,p75}, "icu_days":{...}, "ward_days":{...}, "ot_hours":{...}}}` | For the cohort, compute `los_days` from `main_table.los_days`; `icu_days`/`ward_days` via `derive_icu_and_ward_days(services_json, los_days)`; `ot_hours` parsed from OT-charge service-row names ("OT - 2 1/2 HOURS"). Percentiles = `inclusive_quartiles` (Python `statistics.quantiles(n=4, method="inclusive")`). |
| `--per-ip-buckets` | `09_per_ip_bucket_totals_from_classification.csv` | One row per cohort admission: `admission_no, patient_name, los_days, ot_hours, total_amount_ip_drugs_medicines_ivs_nutrition_products, total_amount_ip_treatment_supplies, total_amount_ot_drugs_..., total_amount_ot_treatment_supplies, total_amount_implants`, plus `line_item_count_*`, `gross_return_quantity_total`, `unclassified_item_count`. **This file defines the cohort admission set.** | Classify each pharmacy line in `pharmacy_json` via `fc.pharmacy_item_mapping` (classification + `present_in_ip/ot_pharmacy` + `fc_estimate_bucket`), sum amounts per bucket per admission. `ip_drugs_per_los_day = ip_drugs_amount/los_days`, `ip_consumables_per_los_day = ip_supplies/los_days` (added by loader). |
| `--pharmacy-template` | `10_classified_pharmacy_template.csv` | Per-item cohort pharmacy rows: `item_code, item_name, classification, present_in_ip_pharmacy, present_in_ot_pharmacy, present_in_returns, case_count, case_presence_rate, ot/ip/overall_quantity_typical_cleaned, ot/ip/overall_amount_typical_cleaned, observed_any_sale_rate_*`. | Aggregate cohort pharmacy_json by canonical item; `case_presence_rate = 100*distinct_admissions_with_item/cohort_size`; "typical_cleaned" = p50 across cohort; join classification from `fc.pharmacy_item_mapping`, rates from `fc.pharmacy_catalog_rate_reference`. |
| `--implant-hierarchy` | `16_implant_family_brand_item_presence.csv` | Implant family/brand/item hierarchy: `implant_family, brand_family, item_code, item_name, implant_family_distinct_ip_count, implant_family_presence_rate, implant_family_quantity_p25/p50/p75, implant_family_rate_p25/p50/p75, family_brand_presence_rate / brand_presence_rate_within_implant_family, brand_quantity/rate_p25/p50/p75, item_presence_rate, item_quantity_p25/p50/p75, item_rate_p25/p50/p75, typical_rate_p50`. | Group implant pharmacy lines (`fc_estimate_bucket = implants`) by family/brand/item; presence rates and percentiles per level across cohort admissions. |
| `--implant-detail` | `12_implant_combinations_per_ip.csv` | Per-IP implant lines: `admission_no, item_code, quantity, sale_rate, gross_amount`. | Explode implant lines from cohort `pharmacy_json`. |
| `--services-template` | `..._services_template.csv` | Per-item cohort service rows: `item_code, item_name, fc_estimate_bucket, grouping, case_count, case_presence_rate, quantity_p25/p50/p75, tariff_code, tariff_general/twin/single/icu, rate_cash_p25/p50/p75, amount_cash_typical, room_category_dependent`. | Aggregate cohort `services_json` by canonical service; bucket/grouping from `fc.service_item_mapping`; presence rate & qty percentiles across cohort; rates from `fc.service_tariff_rate_matrix` (TR1). |
| `--service-line-count-metrics` | `..._service_line_count_metrics.json` | `{"cleaned_distinct_service_line_count":{p25,p50,p75}}` | Per admission, `count_distinct_non_food_service_lines(services_json)`; `inclusive_quartiles` across cohort. |
| `--ip-pharmacy-per-day-metrics` | `..._ip_pharmacy_per_day_metrics.json` | `{"metrics":{"ip_drugs_per_los_day":{p25,p50,p75}, "ip_consumables_per_los_day":{p25,p50,p75}}}` | Per admission compute per-LOS-day, then quartiles. |
| `--rate-csv` | `tr1_cash_rates_robotic_tkr_unilateral_right_full_codes.csv` | Per code TR1 room rates: `item_code, item_name, general, twin, single, icu`. | `fc.service_tariff_rate_matrix` filtered `tariff_cd='TR1'` pivoted by `ward_group_name`. |
| `--ot-slot-rate-csv` | `18_ot_slot_rates_tr1.csv` | OT slot rows: `tariff_code, ot_slot_hours, ot_mode, item_code, item_name, general, twin, single, icu`. | OT-slot service rows from tariff matrix. |
| `--cath-lab-metrics-json` | `22_cath_lab_metrics_cash.json` | `{"metrics":{p25,p50,p75}, "amount_metrics":{...}}` for cath-lab net amount. | Cath-lab slot-family amounts (not material for robotic TKR but written). |
| `--cath-lab-slot-rate-csv` | `23_cath_lab_slot_rates_tr1.csv` | Cath-lab slot rates. | tariff matrix. |
| `--payer-basis-summary-json` | `19_payer_basis_summary.json` | `{"basis_order":[...], "basis_metrics":{basis:{cohort_size, payor_counts, clinical_drivers, bucket_quartiles, ip_pharmacy_per_day, service_line_count, cath_lab_amount}}}`. | See Reference sheet layout (§4P). |
| `--payer-basis-service-metrics-csv` | `20_payer_basis_service_metrics.csv` | Per-basis per-item service metrics. | Per basis cohort filter, service aggregation. |
| `--payer-basis-pharmacy-metrics-csv` | `21_payer_basis_pharmacy_metrics.csv` | Per-basis per-item pharmacy metrics. | Per basis cohort filter. |
| `--org-tariff-reference-csv` | `24_insurance_org_tariff_reference.csv` | `payor_bucket, organization_cd, organization_name, organization_label, tariff_code, tariff_name, case_count`. | `fc.organization_tariff_mapping` joined to cohort counts. |
| `--tariff-rate-matrix-csv` | `25_tariff_service_rate_matrix.csv` | `matrix_key, tariff_code, tariff_name, item_code, item_name, general, twin, single, icu`. matrix_key = `tariff_code|item_code`. | `fc.service_tariff_rate_matrix` pivoted. |
| `--tariff-ot-slot-rate-matrix-csv` | `26_tariff_ot_slot_rate_matrix.csv` | `matrix_key, tariff_code, tariff_name, ot_slot_hours, ot_mode, item_code, item_name, general, twin, single, icu`. matrix_key = `tariff_code|ot_mode|ot_slot_hours`. | OT slot rows. |
| `--insurance-policy-csv` | `27_insurance_fc_policy.csv` | `item_code, policy_scope, exclude_from_insurance_estimate (Yes/No), note`. | Policy table. |
| `--grouping-gap-summary-csv` | `.../robotic_tkr_unilateral_right_cash/grouping_gap_summary.csv` | Per grouping: `grouping, sample_fc_estimate_bucket, group_presence_rate, group_amount_p25/p50/p75_exact, group_amount_captured_by_default_rows, group_amount_left_out_vs_p50, suggested_group_residual_p50, group_residual_band (auto/optional), optional_child_count, status (material_gap)`. | Compare grouping p50 exact totals vs what default-included exact rows captured. |
| `--grouping-gap-child-detail-csv` | `.../grouping_gap_child_detail.csv` | Per child: `grouping, item_code, item_name, case_presence_rate, amount_cash_typical, made_it_to_fc_default (Yes/No), why_not_default`. | |
| `--payer-basis-resolution-csv` | `30_payer_basis_resolution_summary.csv` | Resolver output per `component|target_payor_bucket` (see `fc_payer_basis_resolution.py`, §3). | Run resolver (§3). |
| `--pf-payor-summary-csv` / `--pf-shape-review-json` / `--pf-modeled-vs-actual-csv` | (no defaults) | Professional-fee historical summary per payor bucket. | From `export_fc_professional_fee_analysis.py`. |

Alternative single input: `--builder-input-pack-json` bundles all of the above under keys `historical_driver_metrics`, `historical_actual_metrics.{bucket_quartiles, ip_pharmacy_per_day_metrics, per_ip_compat_rows}`, `payer_basis_metrics.{summary, service_rows, pharmacy_rows}`, `service_template_rows`, `pharmacy_template_rows`, `ip_actual_benchmark_rows`, `implant_template_rows.{hierarchy_rows, detail_rows}`.

### 1c. Local synthesis fallback
`should_synthesize_local_basis_artifacts` returns True when `payer_basis_summary_json == DEFAULT` **and** `services_template != DEFAULT`. Then it synthesizes two bases (`["Cash","All Payers"]`, both pointing at the same shared metrics) from the loaded cohort via `synthesize_local_cash_basis_summary` / `synthesize_local_basis_service_rows` / `synthesize_local_basis_pharmacy_rows`. `basis_item_key` = `basis|code` (service) or `basis|code|name` (pharmacy).

---

## 2. COHORT SELECTION

The cohort admission set is **defined upstream** and materialized as the `09_per_ip_bucket_totals_from_classification.csv` admission list; this script fetches those admissions from `mart.main_table`. The variant identity is fixed via constants/args:

- Template/procedure identity: `--sheet1-template-name = "Robotic TKR Unilateral - Right"`, `--procedure-code = "OTI0098"`, `--procedure-label = "ROBO (TKR) - UNILATERAL"`, `--include-procedure-row = "yes"`.
- Payor label: `SHEET1_PAYOR_TEXT = "Cash (Tarriff Code Tr1)"` → cash → tariff **TR1 / KIMS** (`--payor-label`; `derive_payer_type` returns `"cash"` when label contains "cash").
- Management type: `--sheet1-management-type = "Surgical"`.

For the DB rebuild, the equivalent cohort filter on `mart.main_table` is: robotic TKR unilateral-right cases (procedure `OTI0098` / package name "ROBO (TKR) - UNILATERAL"), `payor_bucket = 'Cash'` (and General/GENERAL, which also map to TR1), `tariff_code = 'TR1'`, IP (non-daycare surgical: `surgical_medical='Surgical'`, `is_daycare_broad=false`). Percentiles/presence rates below are computed over exactly this admission set. Family kind for the resolver is `surgical` (exact threshold 15).

Cohort-derived denominators: presence rate = `100 * (# distinct admissions containing the item) / cohort_size`; all "p25/p50/p75" use inclusive quartiles.

---

## 3. COMPUTATION PIPELINE

### 3a. Drivers (LOS / ICU / Ward / OT) — Builder sheet
Historical p25/p50/p75 for `icu_days`, `ward_days`, `ot_hours` are looked up from the Reference payer-basis summary by resolved **service** basis (`Builder!G6`). LOS is **derived** as ICU + Ward (never independently percentiled in the Builder): `B10=B11+B12`, `C10=C11+C12`, `D10=D11+D12`, `G10=G11+G12`.
- ICU/Ward driver p-values are day-rounded: `build_day_rounding_formula(expr)` = `=INT((expr))+IF(MOD((expr),1)>0.3,1,0)` (i.e. round up only if fractional part > 0.3 — mirrors `round_display_quantity`).
- OT p-values are snapped to nearest supported tariff slot via `build_nearest_supported_ot_slot_formula` (see §3k).
- Selected value: `build_builder_value_formula(choice, p25, p50, p75, manual)` = `=IF(choice="P25",p25,IF(choice="P50",p50,IF(choice="P75",p75,manual)))`. Default Selection per driver = `"P50"`. ICU/Ward selected are re-day-rounded; OT selected re-snapped.

### 3b. Default-included vs optional services (`clean_services_for_fc`)
For each service template row: skip if `fc_estimate_bucket` contains "remove"; skip if code ∈ `TEMPLATE_EXCLUDED_SERVICE_CODES` (fixed template + logic-driven codes — see §5). Remaining → `cleaned_rows`. Classify default-included via `is_template_default_included`:
```
presence_rate > 90.0  OR  (presence_rate >= 75.0 AND amount_cash_typical <= 1000.0)
```
Default → `auto_included_rows`; else → `optional_rows`. Rule text surfaced by `service_rule_text`: ">90%" → `"Historic Presence Rate > 90%"`; ">=75% & <=1000" → `"Historic Presence Rate >= 75% & Typical Amount <= Rs 1,000"`; else `"Template Override"`.

### 3c. Optional add-on ordering (`prioritize_optional_service_rows`)
Sort key (all descending unless noted):
1. `-expected_add_on_contribution(row, rate_lookup)` where `expected = quantity_p50 * rate * (presence_rate/100)`; rate = first non-null of `single, twin, general, icu` from TR1 rate lookup, else `amount_cash_typical/quantity_p50`.
2. `-case_presence_rate`
3. `-tariff_rate_for_add_on` (single→twin→general→icu)
4. `grouping` (asc), 5. `item_name` (asc), 6. `item_code` (asc).

Then `split_robotic_optional_service_rows`: rows where `is_robotic_service_row` (any of code/name/grouping/bucket contains "ROBO" or "ROBOTIC") are pulled out into `robotic_service_rows` (excluding the primary procedure code); the rest stay optional.

### 3d. Grouped residuals (`build_grouped_residual_candidates`)
`has_positive_residual`: `suggested_group_residual_p50 > 0 AND group_amount_left_out_vs_p50 > 0`.
Band eligibility:
- `auto`: `group_residual_band=="auto"` AND `group_presence_rate > 90.0` AND positive residual.
- `optional`: band=="optional" AND `75.0 <= presence <= 90.0` AND positive residual.
Investigation promotion → `auto` when: `sample_fc_estimate_bucket=="Investigations"`, band NOT already auto/optional, `presence >= 50.0`, `suggested_group_residual_p50 >= 1000.0`, `group_amount_left_out_vs_p50 > 0`, `optional_child_count >= 1` (promoted copy sets `group_residual_band="auto"`, `eligible_group_residual="Yes"`).
Sort: `-suggested_group_residual_p50`, `-group_presence_rate`, `grouping`.

Netting (Grouped Adjustments sheet, §4F): net residual per mode = `MAX(0, group_amount_pXX_exact - captured_by_default - selected_addon_amount_from_same_grouping)`. Selected add-on amount pulled via `SUMIFS` over Service Add-Ons where grouping matches and Selected="Include".

Auto vs optional default selection: `auto` → default `Selected="Include"`; `optional` → default `"Exclude"`.

`build_insurance_excluded_groupings`: a grouping is insurance-excluded iff **all** its child item codes are in the insurance policy exclusion set.

### 3e. Advanced OT-consumables shortlist (`build_ot_consumable_shortlist`)
Eligible pharmacy rows: `classification=="Treatment Supplies"` AND `present_in_ot_pharmacy=="true"` AND `case_presence_rate < 70.0`.
`compute_ot_expected_contribution(row) = presence_rate * ot_quantity_typical_cleaned * rate / 100`, where `rate = ot_amount_typical_cleaned / ot_quantity_typical_cleaned`.
Rank: `-expected`, `-presence_rate`, `-ot_amount_typical_cleaned`, `item_name`. Build shortlist accumulating until `len >= max_count` (`--ot-consumable-shortlist-count`, default **10**) OR `running/total_expected >= cumulative_target` (default **0.80**).
Default selection (`default_ot_shortlist_selection_indices`, used only in fixed helper path): pick prefix whose cumulative share lands in `(0.30, 0.50]`, else prefix closest to target `0.40` (lower 0.30, upper 0.50). In the Advanced Controls sheet the default `Selected` is `"Exclude"` for all rows.
Applied value (piecewise, §4D): selected expected share = `SUMIF(selected="Include", contribution)/SUM(contribution)`; `<=0.30 → P25`, `<=0.50 → P50`, else `P75` (constants `OT_CONSUMABLES_P25_SHARE_THRESHOLD=0.30`, `OT_CONSUMABLES_P50_SHARE_THRESHOLD=0.50`). If zero selected → P50 default.

### 3f. Robotic presence & default
`collect_robotic_presence_signal_rows`: robotic rows (excluding remove-bucket) — the primary procedure code always counts; other robotic rows excluded if in `TEMPLATE_EXCLUDED_SERVICE_CODES`. `compute_robotic_charge_presence_rate` = **max** `case_presence_rate` across those rows (strongest signal, not average). `resolve_robotic_default_selection`: mode `"yes"`→"Yes", `"no"`→"No", `"auto"`→ `"Yes" if presence_rate > presence_threshold else ""` (blank). `--robotic-default-mode` default `"auto"`; `--robotic-presence-threshold` default **90.0**. Builder `E8` = presence_rate/100 (percent format).

### 3g. Implant hierarchy (`build_implant_template_records` for Implant Selection; `build_implant_selection_records` for legacy Pharmacy Variance)
Three levels keyed off `IMPLANT_FAMILY_ORDER` = `["Femoral Component","Tibial Insert / Bearing","Bone Cement","Tibial Baseplate","Stem / Extension","Screw","Pin"]` (unknown families sort to 999).
- Family record: presence_rate, quantity_p25/50/75, rate_p25/50/75, `amount_p50 = quantity_p50*rate_p50`.
- Brand record: keyed `(family, brand)`, presence from `family_brand_presence_rate`|`brand_presence_rate_within_implant_family`|`brand_presence_rate`, quantities/rates p25/50/75, `amount_p50 = qty_p50*rate_p50`.
- Item record: keyed by code, presence, qty p25/50/75, rate p25/50/75 (`rate_p50` from `typical_rate_p50`), `amount_p50`.
Resolver precedence Item > Brand > Family (Implant Selection formula, §4H).

### 3h. Professional-fee analysis
Guided workbook uses **percentage multipliers** (not fixed fees). `get_professional_fee_multipliers`: cash → surgeon 0.25, assistant_surgeon 0.15, anesthetist 0.25, assistant_anesthetist 0.25; insurance → 0.35 / 0.35 / 0.45 / 0.0. Line Item Detail always uses the **cash** multipliers, then zeroes all PF when in insurance mode via `IF(insurance_mode,0,...)`. Cascade: Surgeon = mult_surgeon × (pre-PF subtotal); Assistant Surgeon = mult × Surgeon; Anesthetist = mult × Surgeon; Assistant Anesthetist = mult × Anesthetist (0 for insurance). Historical PF (p25/p50/p75 collectible + named breakdown per role) surfaced from the PF payor summary rows in Reference and shown on Estimate Summary / Estimate-vs-Actual / PF Review.

### 3i. Payer-basis resolution (`fc_payer_basis_resolution.py`)
`AUTO_BASIS="Auto (Recommended)"`. Options: `Cash, GIPSA Insurance, Non-GIPSA Insurance, Corporate, Insurance All, All Payers`. Target buckets for exact match: `Cash, GIPSA Insurance, Non-GIPSA Insurance, Corporate`. Components resolved independently: `service_basis, pharmacy_basis, pf_basis`.
Thresholds: `family_exact_threshold` = **15** for `surgical`/`daycare`, else **20**; `fallback_count_threshold` = **25**.
`choose_basis`:
1. If target ∈ {GIPSA, Non-GIPSA, Corporate, Cash} and exact count ≥ exact_threshold → `recommended_exact`; confidence `high` if count ≥ 2×threshold else `medium`.
2. Else if target ∈ {GIPSA, Non-GIPSA} and Insurance-All count ≥ 25 → `Insurance All`, `recommended_fallback_insurance_all`; confidence `medium` if spread ≤ 0.2 else `low`.
3. Else if All-Payers count ≥ 25 → `All Payers`, `recommended_fallback_all_payers`, `medium`.
4. Else → `Cash`, `recommended_fallback_cash`; `medium` if cash count ≥ exact_threshold else `low`.
`variability_score = |(p75-p25)/p50|`; spreads = `|(p50 - insurance_all_p50)/insurance_all_p50|` and vs all-payers. `supported_basis_options_from_resolution_rows` yields the Builder dropdown options (those with count>0), fallback `["Cash"]`.

For robotic-TKR **cash** the resolved basis for all three components is Cash (or the local synthesized Cash/All Payers when synthesizing).

### 3j. Cash drug administration 12.5% rule
`drug_administration_charges = 0.125 * pharmacy_total`, where `pharmacy_total = ip_drugs + ip_consumables + ot_drugs + ot_consumables + implants`. In Line Item Detail the drug-admin row's low/typ/high per room column = `IF(insurance_mode,0,0.125*SUM(ip_drugs_row, ip_cons_row, ot_drugs_row, ot_cons_row, implants_row))` (zero for insurance). IP actual rows also add `0.125*pharmacy_total` on top; `total_amount = services_total_ex_fnb + pharmacy_total + drug_administration_charges`.

### 3k. OT slot snapping (`snap_to_supported_ot_slot_hours` / formulas)
Supported hours = distinct positive `ot_slot_hours` from the tariff OT matrix (e.g. 2.0/2.5/3.0/3.5/4.0). Snap = nearest; ties go to the **larger** slot. Excel form `build_nearest_supported_ot_slot_formula`: if `≤0 → 0`; if `≤MIN → MIN`; if `≥MAX → MAX`; else nearest of MATCH-bracketed lower/upper. Resolved slot: `build_resolved_ot_slot_formula` returns "" if duration ≤ 0. OT mode: `IF(emergency="Yes","emergency","normal")`. OT lookups key = `tariff_code|mode|hours` into the tariff-OT matrix.

### 3l. Estimate summary Low/Typical/High math
The full engine lives in **Line Item Detail** (§4J). Each line writes 12 amount cells: General/Twin/Single × Low/Typical/High (cols N–V) plus 3 selected-room totals W/X/Y (`build_mode_pick_formula` on `Builder!B5`). Subtotal-before-PF row sums all non-PF rows per column. PF rows computed from subtotal. Grand Total row = subtotal + Σ(PF rows). Final estimate (`Estimate Summary!E2`) = room-pick (`Builder!B2`) of Grand Total W/X/Y. Low=P25, Typical=P50, High=P75 selected via mode-pick.

---

## 4. WORKBOOK CONSTRUCTION (per sheet)

Global styling constants (fills are solid ARGB): `HEADER_FILL=1F4E78` (white bold), `SUBHEADER_FILL=D9EAF7`, `OT_FILL=FCE4D6`, `IMPLANT_FILL=E2F0D9`, `RESULT_FILL=FFF2CC`, `SELECTION_FILL=F4F6F8`, `FORMULA_GREEN_FILL=EAF4EA`, `FORMULA_BLUE_FILL=EAF1FB`, `INPUT_FILL=FFF2CC`, `SPACER_FILL=F7F7F7`. Borders: thin grey `D9D9D9`; section border medium blue `4F81BD`. Default number format currency `#,##0.00`, percent `0.0%` or `0.00`, day counts `#,##0`. Freeze panes are set per sheet during writing but **stripped to None** at the end; `showGridLines=False` on guided sheets. `apply_default_calc_settings` sets full recalc-on-load.

### A. Builder (`write_builder_sheet`)
Input cells (INPUT_FILL + section border): `E2` Pricing Mode (`PRICING_MODE_OPTIONS = ["Cash / TR1","Insurance / Org Tariff"]`, default index 0), `E3` Historical Payer Basis (default `AUTO_BASIS`), `G2` Insurance Org Code (blank), `B4` Selected Room Type (default "Single", validation `General,Twin,Single`), `B5` Estimate Mode (default "Typical", `Low,Typical,High`), `B6` Emergency OT? (default "No", `No,Yes`), `E6` MLC? (default "No"), `B8` Robotic? (default = `robotic_default_selection`, validation `Yes,No` allow_blank), `E11:E13` driver Selection (`P25,P50,P75,Manual`), `F11:F13` manual values, `F13`.
Header/derived cells (FORMULA_GREEN_FILL bold):
- `B2` = template name; `A3`/`B3="=E2"`.
- `G3` = org name lookup `build_org_reference_lookup_formula("G2", organization_name)`.
- `E4` Resolved Payor Bucket = `=IF(E2="Cash / TR1","Cash", <org payor_bucket lookup>)`.
- `G4` Resolved Tariff Name = `=IF(E2="Cash / TR1","KIMS", <lookup tariff_name>)`.
- `E5` Resolved Tariff Code = `=IF(E2="Cash / TR1","TR1", <lookup tariff_code>)`.
- `G5` Resolved Pharmacy Basis = `=IF(E3<>"Auto (Recommended)",E3, <resolution lookup selected_basis for pharmacy_basis|E4, fallback "Cash">)`.
- `G6` Resolved Service Basis (service_basis), `G7` Resolved PF Basis (pf_basis), `G8` Basis Resolver = `=IF(E3<>"Auto (Recommended)","Manual override applied", <service selection_reason>)`.
- Drivers block rows 9 header (`Driver,P25,P50,P75,Selection,Manual Value,Selected Value`); row 10 LOS derived; rows 11 ICU, 12 Ward, 13 OT Hours (p-formulas via `build_reference_basis_lookup_formula` on `Builder!G6` wrapped in day-rounding/OT-snap). `G10=G11+G12`.
- `B14` Resolved OT Slot (Hours) = `build_resolved_ot_slot_formula("G13")`; `B15` Resolved OT Slot Code, `B16` Label = `build_ot_slot_lookup_from_resolved_formula("B14","B6",...)`; `B17` Resolved OT Type = `=IF(B6="Yes","Emergency","Normal")`.
- `E8` = `robotic_charge_presence_rate/100` (0.0% format).
Data validations: room, mode, pricing mode, basis (`"Auto (Recommended),<supported options>"`), yes/no (B6,E6), robotic (B8), driver (E11:E13), org (from Reference org_cd column). "How To Use" notes rows 19–28. Widths A24 B18 C12 D18 E18 F20 G24. Freeze `A8` (stripped). Named cross-refs used everywhere: `Builder!B4/B5/B6/E6/B8/E2/E3/E4/E5/G2/G5/G6/G7/G10/G11/G12/G13/B10..D13/B14..B17`.
`build_reference_basis_lookup_formula(col, basis_ref="Builder!G6")` = `=IFERROR(INDEX('Reference'!$COL$2:$COL$500, MATCH(basis_ref, 'Reference'!$AZ$2:$AZ$500, 0)),0)`.

### B. Estimate Summary (`write_estimate_summary_sheet`)
- A2:B11 context (`=Builder!B4/B5/E3/E2/G2/E4/E5/G5/G6/G7`).
- `D2/E2` Final Estimate = `build_room_pick_formula("B2", 'Line Item Detail'!W{GT}, X{GT}, Y{GT})` where GT = grand_total_row; `build_room_pick_formula(room, g, t, s)` = `=IF(room="General",g,IF(room="Twin",t,s))`.
- `D3/E3` explanation text.
- D6:G9 room × Low/Typ/High grid pulling `Line Item Detail!{N..V}{GT}`.
- I6:J20 Selected Drivers & Controls (LOS/ICU/Ward/OT selected, Emergency, Resolved OT slot hours/code/type, MLC, OT Consumables Selected Typical=`'Advanced Controls'!C6`, Implants Selected Typical=`'Implant Selection'!F6`, Optional Add-Ons Selected Typical=`'Service Add-Ons'!C5`, Grouped Adjustments Selected Typical=`'Grouped Adjustments'!C5`, Included Count=`!E5`).
- I24:J29 Service Count Check (Current=`'Service Add-Ons'!P10`, P25/P50/P75=`!P5/P6/P7`, Alert=`!P11`).
- L6:M11 Cohort Basis Counts (`build_reference_basis_lookup_formula` on cohort_size/cash/gipsa/non_gipsa/corporate).
- L13:R19 Pharmacy P50 by Basis (bucket rows × Cash/GIPSA/Non-GIPSA/Corporate/Insurance All/All Payers via INDEX/MATCH on Reference basis label).
- A12:B23 Bucket → Selected Estimate. Buckets: Room Charges, Investigations, Procedure / OT Charges, Bedside Services, Pharmacy, Drug Administration Charges, Professional Fees, Optional Add-Ons, Grand Total (`=E2`), Professional Fees (Historic Basis P50) (`build_pf_payor_lookup_formula(...p50, Builder!G7)`), Grand Total (Historic PF) (`=B21-B19+B22`). Non-total buckets = `build_room_pick_formula("B2", SUMIF over 'Line Item Detail'!$B$ by bucket into $W/$X/$Y)`.
- A25:E32 Professional Fees by Payer (6 payor rows: cases + p25/p50/p75 collectible via `build_pf_payor_lookup_formula`).
- L24:P34 Selected Basis PF Mix (8 role rows p25/p50/p75 on `Builder!G7`) + dominant PF shape.
- Row 36+ Selected-basis IP actuals snapshot (`write_selected_basis_actuals_snapshot`, §4-Ref helper) with metric rows, Basis/P25/P50/P75/Notes; grand-total row uses component-mix when service/pharmacy/PF bases differ; PF historic-basis row.
Number formats: `#,##0.00` across value ranges. Freeze none.

### C. Estimate vs IP FC Actuals (`write_estimate_vs_actual_sheet`)
Header A1/A2. Row 4 columns: `Metric, Comparison Basis, Selected Estimate, Actual P25, Actual P50, Actual P75, Delta vs P25, Delta vs P50, Delta vs P75, Status`. 17 comparison rows (room/inv/procedure/bedside/pharmacy total, IP drugs (+/day), IP consumables (+/day), OT drugs, OT consumables, implants, drug admin, PF calculated, PF historic p50, Grand Total calculated, Grand Total historic PF). Selected estimate refs either `'Estimate Summary'!Bxx` or `selected_line_item_formula(name)` = room-pick of `SUMIF('Line Item Detail'!$A, name, $W/$X/$Y)`. Actual P25/50/75 via `build_actual_basis_metric_lookup_formula(stat_col, field_key, basis_ref)` = `=IFERROR(INDEX('Reference'!$STAT$2:$STAT$1000, MATCH(basis_ref&"|"&"field_key", 'Reference'!$HA$2:$HA$1000,0)),0)`. Deltas `=C-D/E/F`. Status:
```
=IF(AND(OR(C<D,C>F),ABS(H)>MAX(5000,0.2*MAX(E,1))),"Material Gap",
  IF(C<D,"Below Range",IF(C>F,"Above Range","Within Range")))
```
Then Driver table (LOS/ICU/Ward/OT — selected vs actual p25/50/75, Below/Within/Above), Component Cohort table (Service/Pharmacy/PF resolved basis + case counts + scope note), and 6 explanatory Notes. Widths A28…J18.

### D. Advanced Controls (`write_advanced_controls_sheet`)
OT-consumables only. A4:D4 benchmark header; B5/C5/D5 = `build_reference_basis_lookup_formula(ot_consumables_p25/p50/p75, "Builder!G5")`. A6/B6 Resolved OT Consumables/Applied Value. Shortlist table header row 7: `Item, Typical Qty, Typical Rate, Typical Amount, Presence Rate, Expected Contribution, Cumulative Share, Selected`; data from row 8. Per row: `A`=item name; `B`,`D`,`E` = `build_reference_pharmacy_name_lookup_formula(A, ot_qty/ot_amount/presence, fallback, "Builder!G5")` (key `basis|name` into Reference col DR); `C=IF(B>0,D/B,0)`; `F=E*B*C/100`; `G` cumulative share; `H` default `"Exclude"`. Applied `C6`:
```
=IF(COUNTIF(H8:Hend,"Include")=0,C5,
  IF(<share><=0.3,B5,IF(<share><=0.5,C5,D5)))
```
where `<share> = IFERROR(SUMIF(H8:Hend,"Include",F8:Fend)/SUM(F8:Fend),0)`. Validation Include/Exclude on H. Returns refs `ot_typical=ot_resolved='Advanced Controls'!C6`. (Note: implant "typical" ref is injected separately as `'Implant Selection'!F6`.)

### E. Service Add-Ons (`write_service_addons_sheet`)
A4:D4 totals header (Optional Add-Ons / Low / Typical / High); A6:M6 columns: `Service Name, Grouping, Presence Rate, Qty P25, Qty P50, Qty P75, Selected Tariff Rate, Typical Gross, Selected, Low Amt, Typical Amt, High Amt, Code` (M hidden). Data from row 7 per optional row:
- `C/D/E/F` = `build_reference_service_lookup_formula(M, case_presence_rate/quantity_p25/p50/p75, fallback)` = INDEX/MATCH on Reference service col by `Builder!G6&"|"&M` into key col CQ.
- `G` Selected Tariff Rate = `build_room_pick_formula("Builder!B4", tariff general/twin/single lookups)` via `build_tariff_rate_lookup_formula(M, col, "0", "Builder!E5")` = `=0+IFERROR(INDEX('Reference'!$COL$2:$COL$8000, MATCH(Builder!E5&"|"&M,'Reference'!$EB$2:$EB$8000,0)),0)`.
- `H` Typical Gross = `wrap_insurance_exclusion(M,"=E*G")`; `I` Selected default "Exclude"; `J/K/L` = `wrap_insurance_exclusion(M,"=D*G")/"=E*G"/"=F*G"`; `M` = code.
- Totals `B5/C5/D5` = `SUMIF(I,"Include",J/K/L)`.
Service-Line-Count Alert (O4:P11): P5/P6/P7 = `build_reference_basis_lookup_formula(service_line_p25/p50/p75,"Builder!G6")`; `P8` Base Included Non-Pharmacy Count = `= base_service_count + IF('Builder'!B8="Yes", robotic_core+robotic_optional, 0)`; `P9=COUNTIF(I,"Include")`; `P10=P8+P9`; `P11=IF(P10<P5,"Below historical P25",IF(P10>P7,"Above historical P75","Within historical range"))`. Validation Include/Exclude on I. `wrap_insurance_exclusion(code, expr)` = `=IF(AND(Builder!E2="Insurance / Org Tariff", <policy exclude lookup>="Yes"),0,<expr>)`.

### F. Grouped Adjustments (`write_grouped_adjustments_sheet`)
A4:D4 totals; header row 6: `Grouping, FC Bucket, Group Presence Rate, Group Amount P25/P50/P75 Exact, Captured By Default, Selected Add-On Amount, Net Residual Low/Typical/High, Selected, Selected Amount, Why`. Hidden helper cols O/P/Q = `SUMIFS('Service Add-Ons'!$J/$K/$L, $B=grouping, $I="Include")`. `H` = mode-pick of O/P/Q. `I/J/K` net residual = `=MAX(0,D-G-O)` / `=MAX(0,E-G-P)` / `=MAX(0,F-G-Q)`. `L` Selected default Include(auto)/Exclude(optional). `M` Selected Amount: if grouping insurance-excluded → `=IF(insurance_mode,0,IF(L="Include",<mode-pick net>,0))` else `=IF(L="Include",<mode-pick net>,0)`. `N` Why text. Totals `B5/C5/D5=SUMIF(L,"Include",I/J/K)`, `E5=COUNTIF(L,"Include")`. Returns refs `grouped_low/typical/high/selected_count` = `!B5/C5/D5/E5`, plus grouped_start/end.

### G. Grouping Review (`write_grouping_review_sheet`) — audit only
Filters summary rows to `status=="material_gap"`, sorts by `-left_out_vs_p50, -presence, grouping`. Summary block (row 4 header): `Grouping, FC Bucket, Group Presence Rate, Group Amount P50 Exact, Captured by Default, Left Out vs P50, Status`. Child block below (only flagged groupings): `Grouping, Item Code, Item Name, Presence Rate, Typical Amount, Made It To FC Default, Why Not Default`. Auto-filter, percent format on presence, currency on amounts. No estimate impact.

### H. Implant Selection (`write_implant_selection_sheet`)
Control block A4:B7: `Implant Estimate Mode` (default "Default P50", validation `Default P50,Family Override,Brand Override,Exact Item Override`), `Selected Family` (default "All"), `Selected Brand` ("All"), `Selected Item Code` ("None"). `C7` resolves item name. E4:H5 Implants Low/Typ/High = `build_reference_basis_lookup_formula(implants_p25/p50/p75,"Builder!G5")`. E6/F6 Resolved Implant Estimate:
```
=IF(B4="Default P50",$G$5,
 IF(B4="Family Override",IFERROR(INDEX($AB$2:$AB$50,MATCH(B5,$U$2:$U$50,0)),$G$5),
 IF(B4="Brand Override",IFERROR(INDEX($AI$2:$AI$100,MATCH(B5&"|"&B6,$AJ$2:$AJ$100,0)),
   IFERROR(INDEX($AB$2:$AB$50,MATCH(B5,$U$2:$U$50,0)),$G$5)),
 IFERROR(INDEX($AR$2:$AR$200,MATCH(B7,$AM$2:$AM$200,0)),
   IFERROR(INDEX($AI$2:$AI$100,MATCH(B5&"|"&B6,$AJ$2:$AJ$100,0)),
   IFERROR(INDEX($AB$2:$AB$50,MATCH(B5,$U$2:$U$50,0)),$G$5))))))
```
Visible tables: Family Summary (A10:I), Brand View (K10:Q, "Matches Family" flag), Exact Item View (K26:S, "Matches Selection" flag). Hidden helper columns R–AR hold list-validation sources and INDEX/MATCH source arrays (Family list R, Brand list S, Item list T; family metrics U–AB; brand metrics AD–AJ incl Brand Key `family|brand`; item metrics AK–AR). Returns `'Implant Selection'!F6` as the implant typical ref.

### I. Estimate Breakdown (`write_estimate_breakdown_sheet`)
Selected-estimate-only mirror of Line Item Detail, grouped by bucket in order: Room Charges, Investigations, Procedure / OT Charges, Bedside Services, Drug Administration Charges, Other Services, Pharmacy, Professional Fees, Optional Add-Ons. Columns: `Line Item, Summary Bucket, Sub-Bucket, Source Type, How Calculated, Included?, Selected Quantity, Selected Room, Selected Rate, Selected Amount`. A/C/D/E pull from Detail; H=`'Builder'!B4`; J=selected amount = room-pick of Detail W/X/Y; Included?/Qty/Rate guarded for optional & grouped-residual (blank when amount 0) and "Excluded for Insurance". Group header rows styled SUBHEADER. Auto-filter; freeze `A4` (stripped). Validation `breakdown col J sum == Estimate Summary!E2 within 0.5`.

### J. Line Item Detail (`write_line_item_detail_sheet`) — the engine
Columns (A–Y): `Line Item, Parent Bucket, Sub-Bucket, Source, How, Item Code(F hidden), Selected Qty(G), Qty Low/Typ/High(H/I/J), Rate General/Twin/Single(K/L/M), General Low/Typ/High(N/O/P), Twin Low/Typ/High(Q/R/S), Single Low/Typ/High(T/U/V), Selected Total General/Twin/Single(W/X/Y)`.
Row set = `core_line_definitions(args)` (see §5 for full ordered list) + optional-service rows + robotic-service rows + grouped-residual rows. Per-kind formula families:
- **template**: qty H/I/J via `build_reference_service_lookup_formula` (quantity_p25/p50/p75), G=mode-pick; rates K/L/M via `build_tariff_rate_lookup_formula`; N..V = `wrap_insurance_exclusion(qty×rate)`, with optional robotic wrap `IF(Builder!B8="Yes",...,0)` when `robotic_controlled`; W/X/Y mode-pick.
- **driver** (ward/icu/los): G=`=selected_ref`, H/I/J = driver low/typ/high refs; ICU-only rows use `icu` rate in all three K/L/M; totals = qty×rate wrapped for insurance.
- **ward_bed**: bed rates ROM0001/ROM0024/ROM0036 (general col) as general/twin/single; qty = ward days.
- **fixed_one**: qty 1; totals = rate.
- **ot_hours**: F=`=Builder!B15`; qty = selected OT hours; K/L/M = tariff rate lookup on `Builder!B15`; totals = rate.
- **cath_lab_history**: N/O/P = `'Reference'!{T/U/V}4` (cath p25/p50/p75); Q..V mirror; W=mode-pick.
- **mlc_charge** (HSP0047): qty `=IF(Builder!E6="Yes",1,0)`; totals = qty×rate wrapped.
- **drug_admin**: W/X/Y mode-pick; N..V = `=IF(insurance_mode,0,0.125*SUM(ip_drugs,ip_cons,ot_drugs,ot_cons,implants rows))`.
- **pharmacy_ip_drugs / ip_consumables**: G=selected LOS; K/L/M = per-day p50 (`ip_drugs_day_p50`/`ip_consumables_day_p50` on Builder!G5); N/O/P = `=G*<per-day p25/p50/p75>`; Q..V mirror; W/X/Y mode-pick.
- **pharmacy_ot_drugs**: N/O/P = ot_drugs p25/p50/p75 (Builder!G5); mirror; mode-pick.
- **pharmacy_ot_consumables**: N/P = ot_consumables p25/p75; O/R/U = `='Advanced Controls'!C6` (typical); mode-pick.
- **pharmacy_implants**: N/P = implants p25/p75; O/R/U = `'Implant Selection'!F6`; mode-pick.
- **optional_service**: qty via reference service lookup; N..V = `wrap_insurance_exclusion(IF('Service Add-Ons'!I{idx}="Include", qty×rate, 0))`.
- **robotic_service**: N..V = `wrap_insurance_exclusion(IF(Builder!B8="Yes", qty×rate, 0))`.
- **grouped_residual**: K/L/M = `='Grouped Adjustments'!M{idx}`; N/O/P guarded = `IF(AND(insurance_mode,ISNUMBER(SEARCH("excluded for insurance",LOWER('Grouped Adjustments'!N{idx})))),0,IF('Grouped Adjustments'!L{idx}="Include",'Grouped Adjustments'!I/J/K{idx},0))`.
PF rows: after all rows, subtotal-before-PF row sums pre-PF + post-PF ranges (excluding the 4 PF rows); Surgeon = `IF(insurance_mode,0,0.25×subtotal)` per column; Asst Surgeon = `0.15×Surgeon`; Anesthetist = `0.25×Surgeon`; Asst Anesthetist = `0.25×Anesthetist`. Grand Total row = `=col{subtotal}+SUM(col{pf_start}:col{pf_end})`. Returns `{subtotal_row, grand_total_row}`. F hidden; freeze A2 (stripped).
Helper formula defs: `build_mode_pick_formula(mode,low,typ,high)`=`=IF(mode="Low",low,IF(mode="Typical",typ,high))`; `build_room_pick_formula` as above.

### K. Pharmacy Template (`write_pharmacy_template_sheet`)
Header row 3, data row 4. 18 columns from pharmacy rows (Item Code…Observed Rate Values). `finalize_filterable_sheet` sets auto-filter `A3:R{end}`, currency L:Q, quantity I:K, percent H, freeze A4 (stripped).

### L. Service Template (`write_service_template_sheet`)
Header row 3. 16 columns from cleaned service rows (Item Code, Name, FC Bucket, Grouping, Case Count, Presence Rate, Qty P25/P50/P75, Tariff Code, Tariff General/Twin/Single/ICU, Typical Amount, Room Dependent). Auto-filter; currency K:O, quantity G:I, percent F.

### M. Pharmacy Metrics (`write_pharmacy_metrics_sheet`)
Per-IP pharmacy metrics, 18 columns (Admission No, Patient Name, LOS Days, OT Hours, IP Drugs/LOS Day, IP Consumables/LOS Day, Implant Amount+Line Count, IP Drugs Amount+Line Count, IP Treatment Supplies Amount+Line Count, OT Drugs Amount+Line Count, OT Treatment Supplies Amount+Line Count, Gross Return Qty, Unclassified Item Count). From `per_ip_rows`.

### N. IP FC Actuals (`write_ip_fc_actuals_sheet`)
`ACTUAL_IP_HEADERS` (33 columns) from `build_ip_fc_actual_rows`: admission_no, patient_name, payor_bucket, patient_type, organization_name, surgical_medical, room_category (commercial precedence), icu_unit_name, los_days, icu_days, ward_days, ot_hours, service_line_count, room_charges, room_charges_per_day, investigations, procedure_ot_charges, bedside_services, professional_fees, ip_drugs(+/day), ip_consumables(+/day), ot_drugs, ot_consumables, implants, pharmacy_total, drug_administration_charges, services_total_ex_fnb, food_and_beverage_excluded, pharmacy_returns_excluded, total_amount(…plus drug admin). Service-bucket amounts mapped via `map_actual_service_bucket`→`collapse_actual_display_bucket`. Auto-filter; currency L:AC, quantity G:K.

### O. Professional Fees Review (`write_pf_review_sheet`)
Delegates to `professional_fee_review_workbook.write_professional_fees_review_sheet` with payor summary rows, shape review JSON, modeled-vs-actual rows, and `estimate_behavior` text ("Cash formula in estimate body; historical PF shown as review context." for cash).

### P. Reference (`write_reference_sheet`) — the lookup backbone
Left block (cols A–R, sequential rows):
1. LOS/ICU/Ward/OT Quartiles (metric,p25,p50,p75).
2. Pharmacy Bucket Quartiles (ip_drugs, ip_consumables, ot_drugs, ot_consumables, implants).
3. IP Pharmacy Per LOS Day Quartiles (ip_drugs_per_los_day, ip_consumables_per_los_day).
4. Cleaned Service Line Count Quartiles.
5. Cleaned Services Template + 6. Optional Service Rows (item_code…amount_cash_typical).
7. TR1 Tariff Rates (code,name,general,twin,single,icu).
8. Implant Reference.
OT Tariff Slot Reference at cols J–R, rows `OT_SLOT_REFERENCE_START_ROW=300`..`END=331` (tariff_code, ot_slot_hours, ot_mode, item_code, item_name, general, twin, single, icu). Cath Lab Family Metrics at cols S/T/U/V (`label/p25/p50/p75`) rows 2–4.
Wide right-side lookup tables (fixed column letters — critical for cross-sheet formulas):
- **Payer Basis Summary** rows 2+, key col `AZ` (basis_label), through `CR` (48 metric columns incl cohort_size BA, cash BB, gipsa BC, non_gipsa BD, corporate BE, los/icu/ward/ot/service_line/ip_drugs/ip_consumables/ot_drugs/ot_consumables/implants p25-p75, ip_drugs_day/ip_consumables_day p25-p75, cath_lab p25-p75). Full mapping in `PAYER_BASIS_SUMMARY_COLS`.
- **Payer Basis Service** rows 2+, key col `CQ` … `DE` (`PAYER_BASIS_SERVICE_COLS`: key, basis_label, item_code, item_name, fc_estimate_bucket, grouping, case_presence_rate, quantity_p25/50/75, amount_cash_typical, tariff_general/twin/single/icu).
- **Payer Basis Pharmacy** key col `DG` … `DR` (incl `basis_name_key` DR = `basis|item_name`).
- **Org Tariff Reference** cols `DT`–`DZ`.
- **Tariff Rate Matrix** key col `EB`, `EC`–`EJ`.
- **Tariff OT Slot Matrix** key col `EL`, `EM`–`EV`.
- **Insurance Policy** cols `EX`–`FA`.
- **PF Payor Summary** cols `FC`–`GC` (`PF_PAYOR_SUMMARY_COLS`).
- **Payer Basis Resolution** key col `GD` (`component|target_payor_bucket`) … `GS`.
- **Actual Basis Metric** key col `HA` (`basis|field_key`) … `HJ` (min,max,average,p25,p50,p75) built by `build_actual_basis_metric_rows` over 6 bases × `ACTUAL_IP_SUMMARY_FIELDS`.
All lookup formula builders (`build_reference_basis_lookup_formula`, `..._service_lookup`, `..._pharmacy_lookup`, `..._pharmacy_name_lookup`, `..._org_reference_lookup`, `..._tariff_rate_lookup`, `..._ot_slot_lookup`, `..._insurance_policy_lookup`, `build_actual_basis_metric_lookup_formula`, `build_pf_payor_lookup_formula`, `build_resolution_lookup_formula`) target exactly these columns/ranges — quoted in §0b of the code and reproduced above.

---

## 5. CONSTANTS (exhaustive)

Thresholds & rules:
- Default-included service: `presence > 90.0` OR (`presence >= 75.0` AND `amount_cash_typical <= 1000.0`). `SERVICES_SIGNIFICANCE_AMOUNT_THRESHOLD = 1000.0`.
- Grouped residual auto: `presence > 90.0` + positive residual; optional: `75.0 <= presence <= 90.0` + positive residual; investigation promotion: bucket=="Investigations", `presence >= 50.0`, `suggested_group_residual_p50 >= 1000.0`, `left_out > 0`, `optional_child_count >= 1`.
- OT consumables share thresholds: `OT_CONSUMABLES_P25_SHARE_THRESHOLD = 0.30`, `OT_CONSUMABLES_P50_SHARE_THRESHOLD = 0.50`.
- OT shortlist: `--ot-consumable-shortlist-count` default `10`; `cumulative_target = 0.80`; eligibility `presence < 70.0`, classification "Treatment Supplies", `present_in_ot_pharmacy=="true"`.
- OT default-selection targets: preferred `0.40`, lower `0.30`, upper `0.50`.
- Robotic: `--robotic-presence-threshold = 90.0`; `--robotic-default-mode = "auto"`; presence = max presence across robotic rows.
- Cash drug admin: `0.125` (12.5%).
- PF cash multipliers: surgeon `0.25`, assistant_surgeon `0.15`, anesthetist `0.25`, assistant_anesthetist `0.25`. PF insurance: `0.35 / 0.35 / 0.45 / 0.0`.
- Day rounding: round up only if fractional part `> 0.3` (`round_display_quantity`, `build_day_rounding_formula`).
- Payer-basis: exact threshold `15` (surgical/daycare) / `20` (other); fallback threshold `25`; confidence high at `>= 2×exact`; insurance spread cut `0.2`.
- Estimate-vs-actual "Material Gap": `ABS(delta_p50) > MAX(5000, 0.2*MAX(actual_p50,1))` while outside [P25,P75].
- Validation tolerance: breakdown vs final estimate `0.5`.

Selection tokens & sheet names: `SELECTION_INCLUDE="Include"`, `SELECTION_EXCLUDE="Exclude"`; sheet-name constants exactly as the 16 titles. `PRICING_MODE_OPTIONS=["Cash / TR1","Insurance / Org Tariff"]`. `PAYER_BASIS_OPTIONS` = resolver's `["Cash","GIPSA Insurance","Non-GIPSA Insurance","Corporate","Insurance All","All Payers"]`. `AUTO_BASIS="Auto (Recommended)"`.

Reference layout constants: `OT_SLOT_REFERENCE_START_ROW=300`, `OT_SLOT_REFERENCE_END_ROW=331`; all `*_START_ROW=2`; column-letter maps `PAYER_BASIS_SUMMARY_COLS` (AZ…CR), `PAYER_BASIS_SERVICE_COLS` (CQ…DE), `PAYER_BASIS_PHARMACY_COLS` (DG…DR), `ORG_TARIFF_REFERENCE_COLS` (DT…DZ), `TARIFF_RATE_MATRIX_COLS` (EB…EJ), `TARIFF_OT_SLOT_MATRIX_COLS` (EL…EV), `INSURANCE_POLICY_COLS` (EX…FA), `PF_PAYOR_SUMMARY_COLS` (FC…GC), `PAYER_BASIS_RESOLUTION_COLS` (GD…GS), `ACTUAL_BASIS_METRIC_COLS` (HA…HJ), `CATH_LAB_REFERENCE_COLS` (S/T/U/V), `OT_SLOT_REFERENCE_COLS` (J..R).

`IMPLANT_FAMILY_ORDER = ["Femoral Component","Tibial Insert / Bearing","Bone Cement","Tibial Baseplate","Stem / Extension","Screw","Pin"]`.

Room precedence: `ROOM_PRECEDENCE = ["MICU","SICU","ICCU","ICU","HDU","SINGLE","DELUXE","TWIN SHARING","GENERAL WARD","DAYCARE"]`; `COMMERCIAL_ROOM_PRECEDENCE = ["DELUXE","SINGLE","TWIN SHARING","GENERAL WARD","DAYCARE"]`; ICU-unit display precedence `["SICU","MICU","ICCU","ICU","HDU"]`; ICU-family tokens `MICU,SICU,PICU,NICU,ICCU,ICU`; ward tokens general/single/twin/deluxe; daycare separate. F&B keywords `["FOOD","BEVERAGE","FOOD AND BEVERAGES","TEA","COFFEE","JUICE","SOUP"]`. Robotic markers `["ROBO","ROBOTIC"]`. MLC service code `HSP0047`; emergency evidence `ER Physician`.

`core_line_definitions` ordered rows (kind → code): XRY5090(template), Nursing-Room ROM5189(driver ward), Nursing-ICU ROM5189(driver icu icu_only), DMO ROM0093(driver ward), ICU-Surgical ROM5009(driver icu icu_only), Bed Charges-Ward ROOM_BED(ward_bed), CSSD RNS5005(template), Medical Records RNS0120(fixed_one), Physiotherapy PHY5082(template), [procedure OTI0098 inserted at index 11 when include_procedure_row!="no", robotic_controlled if label has "ROBO"], HAEMOGLOBIN PAT0045, CBP PAT0042, Instrument OTI0018(fixed_one), OT Disinfection OTI0015(fixed_one), Post Surgery OTC5005(fixed_one), OT Charges(ot_hours), Cath Lab Charges(cath_lab_history), Intensivist ICC0002(icu), Asst Intensivist ICC0001(icu), Ward Consumables HSP5013(driver los), Warmer EME0087(template), Monitor EME0019(icu), Oxygen EME0017(template), Diet DIE0001(template), Dressing CAS0007(template), Bedside ECG CAR5341(template), Albumin BIO0162, Sodium BIO0004, Electrolytes BIO0003, Creatinine BIO0002, Urea BIO0001, MLC HSP0047(mlc_charge), Drug Admin(drug_admin), Surgeon/Asst Surgeon/Anesthetist/Asst Anesthetist(pf_*), IP Drugs/IP Consumables/OT Drugs/OT Consumables/Implants(pharmacy_*).

`TEMPLATE_EXCLUDED_SERVICE_CODES` = `FIXED_ESTIMATE_TEMPLATE_SERVICE_CODES` ∪ `LOGIC_DRIVEN_SERVICE_CODES`:
- Fixed: XRY5090, PHY5082, PAT0045, PAT0042, OTI0098, EME0087, EME0017, DIE0001, CAS0007, CAR5341, BIO0162, BIO0004, BIO0003, BIO0002, BIO0001.
- Logic-driven: ROM5189, ROM0093, ROM5009, ROM0001, ROM0024, ROM0036, ICC0002, ICC0001, HSP5013, EME0019, OTC0010, RNS0120, RNS5005, OTI0018, OTI0015, OTC5005, HSP0047.
Bed rate codes: general ROM0001, twin ROM0024, single ROM0036. Pharmacy Variance result cells (legacy): OT `F3`, implant `N3`.

Legacy/unused-in-final-path constants (do not port unless reproducing the old template sheet): `DEFAULT_TEMPLATE_WORKBOOK`, `DEFAULT_PROFESSIONAL_FEES = {33:65000.0, 34:9750.0, 35:16250.0, 36:4062.5}`, `BASE_ESTIMATE_BUILDER_TEMPLATE_ROWS`, `ESTIMATE_BUILDER_ALWAYS_ONE_ROWS`, `ESTIMATE_BUILDER_LOGIC_ROWS`, `DEFAULT_SERVICES_SELECTION_CODES`, `DEFAULT_OT_CONSUMABLE_SHORTLIST`, `--surgeon-fee/--assistant-surgeon-fee/--anesthetist-fee/--assistant-anesthetist-fee` (defaults 65000/9750/16250/4062.5), `--ot-consumable-shortlist-mode`, `--services-selection-mode/-count`, `--service-rate-field=rate_cash_p50`.

---

### Node port guidance (concise)
- Replace INDEX/MATCH lookups with keyed maps: basis-summary by `basis_label`; service metrics by `basis|code`; pharmacy by `basis|code|name` and `basis|name`; tariff rate by `tariff|code`; OT slot by `tariff|mode|hours`; resolution by `component|target_payor_bucket`; actual-basis by `basis|field_key`; PF by `payor_bucket`.
- Implement `mode_pick` (Low/Typ/High → N/O/P etc.), `room_pick` (General/Twin/Single → W/X/Y-style triplets), `insurance_exclusion` guard, day-rounding (>0.3), and OT slot snapping (nearest, tie→larger) as pure functions.
- Compute Line Item Detail row-by-row exactly per §4J kinds, produce the 12 amount cells + selected-room totals, subtotal-before-PF, PF cascade, grand total, then Final Estimate = room-pick of grand total under the selected mode. Bucket rollups via grouping on Parent Bucket.
- Recompute all §1b artifacts from `mart.main_table` + `fc.*` per §1b recipes for the cohort in §2; run the resolver in §3i for service/pharmacy/PF bases (all resolve to Cash for this cash/TR1 variant).