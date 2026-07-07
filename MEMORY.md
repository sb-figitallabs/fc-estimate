# MEMORY.md — FC Estimate Builder Project Handoff

> **Purpose**: complete context transfer. Any agent (or human) picking up this project
> should be able to continue from here without re-deriving anything. Read this first,
> then `HANDOFF_CONTENTS.md` (data map) and `backend-node/README.md` (runbook).
>
> Last updated: 2026-07-07. Everything below is implemented, validated, and committed.

---

## 1. What this project is

**Goal**: rebuild the hospital's finalized **non-package FC (Financial Counselor) Estimate
Builder** — previously a hand-built Excel workbook per procedure — as a clean, standalone,
AI-assisted **Node.js pipeline** that takes basic inputs (patient, clinical, cash/insurance)
and produces (a) a JSON estimate and (b) the same 16-sheet Excel workbook with identical
formatting, formulas, and rules.

**Mandate from the manager** (`knowledge_inputs/i2.md`): use the database + the logic docs
+ a sense of the deliverable, and **write clean new scripts — do NOT port the reference
Python scripts** (they are logic evidence only).

**Status**: ✅ COMPLETE for Phase 1 target family (robotic TKR unilateral right, cash/TR1)
with exact numeric parity. The API is live-tested end-to-end. Not yet integrated with the
user's main project (Hospital_OS / FC Co-Pilot) — **the user will explicitly say when to
integrate; do not touch Hospital_OS for this until asked.**

---

## 2. Folder map (`~/Downloads/handoof/` — its own git repo, branch `main`)

| Path | What |
|---|---|
| `HANDOFF_CONTENTS.md` | Map of the original handoff data (read 2nd) |
| `knowledge_inputs/i1..i3.md` | Manager's notes; i2 = "clean scripts" mandate; i3 = announces new2 pack |
| `new2/` | **Authoritative logic docs 01–17** + reference scripts (strengthened pack). Priority over `developer_handoff_fc_estimate_builder/` (same + DB dump, older docs) and `new/` (obsolete, ignore) |
| `developer_handoff_fc_estimate_builder/database/fc_handover_phase1_clean.sql` | The DB dump (only copy) |
| `fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx` | **The reference workbook** — the parity target (16 sheets, produced by the manager's finalized builder) |
| `Tariff code plus package code combo - Sheet1.csv` | 637-row tariff×package price-band reference (not yet used by the pipeline) |
| `backend-node/` | **THE DELIVERABLE** — fc-builder-api (see §4) |

Git log tells the build story: initial snapshot → scaffold → artifacts engine → estimate
engine → AI assist → workbook generator → API docs → README.

---

## 3. Database (local Postgres, DB `fc_handoff`)

- Postgres 17 runs on `localhost:5432`, user `apple`, no password. DB **`fc_handoff`** is
  already restored and fixed. Hospital_OS uses other DBs on the same server — don't confuse.
- 7 tables, exact row counts: `mart.main_table` 14,202 · `fc.service_item_mapping` 1,639 ·
  `fc.pharmacy_item_mapping` 8,578 · `fc.pharmacy_catalog_rate_reference` 7,630 ·
  `fc.service_tariff_rate_matrix` 394,163 · `fc.consultation_tariff_rate_matrix` 35,372 ·
  `fc.organization_tariff_mapping` 68.
- ⚠️ **Dump defect (already fixed here, matters for fresh restores)**: 16 jsonb columns in
  `mart.main_table` contain Python-dict literals (`{'items': ...}`, `None/True/False`).
  Raw `psql -f` aborts (whole dump is one transaction). Fix used: sed the CREATE TABLE to
  `text`, restore, convert values via Python `ast.literal_eval → json.dumps`
  (fallback `json.loads` for already-valid), drop defaults → `ALTER ... TYPE jsonb` →
  re-add jsonb defaults. 0 conversion failures.
- `mart.main_table` has precomputed gold columns — USE THEM, don't re-derive:
  `icu_days`, `ward_days`, `derived_ot_hours`, `service_line_count`,
  `normalized_billable_stay_days` (+reason), `room_category`, `icu_unit_name`,
  `fc_actual_bucket_totals_jsonb`, `fc_actual_cash_drug_administration_charge`,
  `cleaned_pharmacy_issue_jsonb` / `cleaned_pharmacy_returns_jsonb` (deduplicated lines),
  `has_emergency_origin`, `has_mlc_charge`, `payor_bucket`, `tariff_code`.

---

## 4. The deliverable — `backend-node/` (fc-builder-api)

Express + pg + exceljs + zod + @google/genai. Port **4100**. ESM (`type: module`).

### Endpoints (docs: Swagger at `/docs`, `postman.json`, `API.md`)
- `GET /health`, `GET /api/lookup/{organizations,service-items,pharmacy-items,doctors}`
- `POST /api/estimate/build` → full JSON estimate
- `POST /api/estimate/workbook` → 16-sheet interactive .xlsx (~0.8 s)
- `POST /api/estimate/{intake,map-items,explain}` → AI assist

### Module map
- `src/modules/resolve/` — payor→tariff (Cash/General→TR1/KIMS; else org mapping; never
  silent-guess) + payer-basis resolver (exact ≥15 surgical/daycare, ≥20 other; fallback
  chain exact→Insurance All→All Payers→Cash at ≥25; confidence high at ≥2× threshold).
- `src/modules/engine/artifacts.js` — recomputes ALL historical artifacts from the DB per
  basis label (Cash/GIPSA/Non-GIPSA/Corporate/Insurance All/All Payers): driver quartiles,
  bucket quartiles, per-day pharmacy, service/pharmacy item stats, actual-basis metrics,
  PF payor summary, OT slot ladder, org directory, tariff matrices.
- `src/modules/engine/services.js` — cleaned-set rule, default-included split
  (presence>90 OR presence≥75 & typical≤1000), add-on prioritization (expected
  contribution → presence → rate → stable identity), grouping-gap analysis, grouped
  residual bands (auto >90, optional 75–90, investigation promotion: bucket=Investigations
  & presence≥50 & residualP50≥1000 & leftOut>0 & ≥1 optional child).
- `src/modules/engine/advanced.js` — OT-consumables shortlist (Treatment Supplies, in-OT,
  presence<70; cap 10 rows / 0.80 cumulative; applied value via share ≤0.30→P25,
  ≤0.50→P50, else P75) + implant family/brand/item hierarchy (keyword classifier over
  item names, families in `IMPLANT_FAMILY_ORDER`).
- `src/modules/engine/lineItems.js` — **the calculation engine**: all row archetypes
  (template, driver, ward_bed, fixed_one, ot_hours, cath_lab, mlc, drug_admin 12.5% cash,
  PF cascade 0.25/0.15/0.25/0.25, per-day pharmacy, OT-cons/implant advanced rows,
  optional add-ons, grouped residuals), 12 amount cells per row + mode/room picks,
  subtotal-before-PF, grand total, final estimate.
- `src/modules/engine/cohort.js` — family registry. **To add a family: add an entry here**
  (whereSql over mart.main_table + procedure code/label); everything else is computed.
- `src/modules/workbook/` — **template-replay generator**: `template.json` (48,890 cells,
  49 styles, extracted once by `scripts/build_template.js` from the reference workbook) +
  `bands.js` (every data-carrying cell overridden from the live estimate payload) +
  `texts.js` (136 verbatim note strings). `fullCalcOnLoad` on; formulas written verbatim
  with engine-computed cached results. Row-count divergence logs a warning.
- `src/modules/ai/` — Gemini via **Vertex AI** (see §6). intake (free text→structured),
  itemMapper (DB candidates + AI ranking; AI never invents keys), explain.

### Validation (all runnable: `npm test` / `npm run validate:*`)
| Suite | Score | What it proves |
|---|---|---|
| validate_artifacts | **1392/1392** | every Reference-sheet data block matches the sample's cached values |
| validate_estimate | **1042/1042** | all 72 LID rows × 12 cells; final estimate **597612.0654575195** exact |
| validate_workbook | **99.769%** (53,095/53,218) | formulas 2824/2824, cached 2765/2765, structure 2465/2465; 12/16 sheets 100% |

The 123 residual workbook diffs are ALL static labels/data where the clean DB renamed
buckets since the sample's artifact-era CSVs (e.g. ANS0003 "Anesthetist - General -
Needed"→"Professional Fees") + ~6 pharmacy items with slightly different upstream dedup.
Current DB is authoritative — do not "fix" these to match the sample.

### Ground-truth files in `backend-node/spec/` (do not delete)
- `BUILD_SPEC.md` — exhaustive spec extracted from the 6,264-line reference export script
- `WORKBOOK_PARITY_SPEC.md` — per-sheet layout/formula/validation contract from the xlsx
- `reference_targets.json` / `sheet_targets.json` — the sample's cached values (validation targets); also the **insurance-policy seed** (EX:FA block — NOT in the clean DB)
- `cohort_admissions.json` — the 26 reference admissions
- Larger extraction artifacts (full_cell_data.json 1.4MB, parity_spec.json 2.8MB) lived in
  the session scratchpad (`/private/tmp/claude-501/...`) — **may be gone**; `template.json`
  captures what the generator needs, and `scripts/build_template.js` documents the rest.

---

## 5. Hard-won domain knowledge (the gotchas — read carefully)

**Cohort identity**: robotic TKR unilateral right = `package_name = 'ROBOTIC TKR -
UNILATERAL - RIGHT' AND payor_bucket = 'Cash'` → exactly 26 admissions (the reference
workbook's cohort). Note `package_code` ORT5535 is shared with plain "UNILATERAL" —
the **package_name** string is the discriminator. Left = ORT5784, Bilateral = ORT5536.

**Statistics**: all percentiles are *inclusive* quartiles (Python `statistics.quantiles
(n=4, method="inclusive")` = linear interpolation = Excel PERCENTILE.INC). Presence rate =
distinct admissions with item / cohort size × 100 (display-rounded 2dp in artifacts).

**LOS**: the artifact basis is `normalized_billable_stay_days` (≈ceil(los_days) =
icu_days+ward_days), NOT raw `los_days`. Per-day pharmacy denominators use it too.
Builder LOS row = ICU + Ward rounded values (LOS is never independently percentiled there).
Day rounding rule: `INT(x) + (frac > 0.3 ? 1 : 0)`.

**Ward groups in tariff matrix**: GENERAL / TWIN / SINGLE / **ICCU** (this is the "icu"
rate column — 'ICCU' does NOT contain substring 'ICU'!) / DELUXE / SUITE / PREMIUM SUITE /
OUT PATIENT. Rows are duplicated in the matrix — dedupe via keyed maps.

**OT slots**: normal names `OT - 2 1/2 HOURS`, emergency names `OT-E - ...` (not
"EMERGENCY OT"). Snap to nearest supported slot, ties → larger. The OT line-item row uses
the SELECTED slot rate in all Low/Typ/High cells (no per-mode variation).

**Pharmacy stats**: use `cleaned_pharmacy_issue_jsonb` (deduplicated; fields `item_name`,
`raw_quantity`, `sale_rate`, `reconstructed_gross_amount`, `pharmacy_section` = 'OT'/'IP'),
NOT raw `pharmacy_json` (contains duplicate billing rows — values come out ~2×). BUT
display names come from raw `pharmacy_json[].item_desc` (first seen). Returns total =
`cleaned_pharmacy_returns_jsonb->summary->return_amount_total`.

**Professional fees**: PF lines = services_json rows with `service_type` ∈ {Professional,
**Consultations**} (consultant visits are a separate type!). Role classification: explicit
ASST+SURGEON / ASST+ANESTH names first, then doctor specialty via `service_group_name`
(ORTHOPAEDICS→surgeon, ANAESTHESIOLOGY→anesthetist, others→consultant_or_physician).
`department_name` on those rows is the ADMISSION's department — do not use it.
general_needed = PF bucket total − named rows, per admission. PF estimate cascade (cash):
surgeon 0.25×pre-PF subtotal, asst surgeon 0.15×surgeon, anesthetist 0.25×surgeon,
asst anesthetist 0.25×anesthetist; all 0 in insurance mode (insurance multipliers
0.35/0.35/0.45/0 exist in spec but finalized builder zeroes PF for insurance).

**Cleaned service set**: mapped items with **non-empty grouping** (doctor-fee rows and
F&B rows have empty grouping — that's the discriminator), bucket not ~remove, code not in
TEMPLATE_EXCLUDED (15 fixed + 17 logic codes, hardcoded in services.js), not an OT slot
row. Professional-bucket items WITH grouping (e.g. ANS0003 PRE ANAESTHETIST CHECK) stay.

**Grouping gaps**: per-admission grouping totals over ALL mapped grouped items EXCLUDING
logic-driven codes but INCLUDING fixed template codes (CBP counts toward Haematology).
Exact quartiles over admissions where grouping present; captured = p50 of per-admission
totals over default rows (fixed + auto-included). Grouped residual cells = MAX(0, exact −
captured − included same-grouping add-on amounts).

**Cash drug admin** = 12.5% × (ip_drugs + ip_consumables + ot_drugs + ot_consumables +
implants rows), cash only, computed AFTER pharmacy rows, included in subtotal-before-PF.

**Robotic**: detection = 'ROBO' in code/name/grouping/bucket; presence = MAX across
robotic rows; auto-select Yes when presence > 90. The procedure row (OTI0098) is
robotic-controlled (zeroed when Robotic ≠ Yes).

**base_service_count** = 36 for this family (constant in cohort.js; +1 when robotic on →
37 = "Current Included Non-Pharmacy Count" in the alert).

---

## 6. AI / environment specifics

- **Both `GEMINI_API_KEY`s in Hospital_OS `.env` files are DEAD** (project migrated to
  Vertex). This backend uses **Vertex AI**: project `nth-rookery-341212`, location
  `global`, `GOOGLE_APPLICATION_CREDENTIALS` → `~/workspace/code/Hospital_OS/backend/service-account.json`
  (referenced, not copied). `src/modules/ai/gemini.js` falls back to API-key mode if
  `VERTEX_AI_PROJECT` unset. Model: `gemini-2.5-flash`.
- `.env` is gitignored; `.env.example` shows the shape.
- **Claude Code sandbox quirks in this workspace**: writes under `~/Downloads` and any
  localhost network (Postgres, curl to :4100) are blocked by the default sandbox — run
  those Bash commands with `dangerouslyDisableSandbox: true`. The Write/Edit tools are
  fine. **Shell cwd resets between Bash calls** — always `cd /Users/apple/Downloads/handoof/backend-node &&`
  in each command.

---

## 7. What's NOT done (future work, in likely order)

1. **Other families end-to-end**: TKR left/bilateral are registered in `cohort.js` but
   not validated; no reference workbooks exist for them (validation = sanity checks +
   the `validate` suites' methodology). GMM/chemo/daycare families need cohort defs +
   family-specific rows (cath-lab emphasis, daycare rates — see docs 12/15/16).
2. **Insurance mode**: engine implements the insurance guards (exclusion list, PF zeroing,
   drug-admin 0) but no insurance case has been validated end-to-end; insurance-policy
   exclusions are seeded from the sample (22 items in `spec/reference_targets.json`), and
   grouping-level insurance exclusion is stubbed `false` in buildEstimate.
3. **Doctor/consultation pricing row** — lookup endpoint exists; not wired into the
   line-item table (the finalized robotic workbook has no consultation row).
4. **Hospital_OS integration** — the user's main project (`~/workspace/code/Hospital_OS`,
   FC Co-Pilot: React SPA + Express + Neon) has an EstimateBuilder to be wired to this
   engine **only when the user asks**.
5. Package-master estimation / org aliases / bill audit — explicitly out of Phase 1 (doc 08).

## 8. 60-second verification for a fresh agent

```bash
cd /Users/apple/Downloads/handoof/backend-node
npm test                          # 1392/0, 1042/0, 99.769% → healthy
npm run dev &
curl -s localhost:4100/health     # {"ok":true,"db":"fc_handoff"}
curl -s -X POST localhost:4100/api/estimate/build -H 'Content-Type: application/json' \
  -d '{"clinical":{"procedure":"robotic_tkr_unilateral_right"},"payment":{"payor_bucket":"Cash"}}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['final_estimate'])"
# must print 597612.0654575195 — if it does, everything upstream is intact.
```
