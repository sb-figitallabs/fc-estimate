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

---

## 9. Deployment (added 2026-07-07)

- **GitHub**: `github.com/sb-figitallabs/fc-estimate` (private; history rewritten — 1.5GB dump excluded, kept on disk + gitignored; a copy of `.git` pre-rewrite exists in the session tmp dir).
- **AWS** (profile `new-fl-aws`, account 452952376831, ap-south-1):
  - EC2 `i-01cfde2610362bf3e` (t3.small, Ubuntu 24.04) — public IP **13.233.93.244** (NO Elastic IP: account EIP quota full; IP changes only on stop/start → then update DNS + gh secret EC2_HOST). SG `sg-0444e4a54a20e04c3` (22/80/443). SSH: `ssh -i ~/.ssh/fc-estimate-key.pem ubuntu@13.233.93.244`.
  - RDS `fc-estimate-db` (db.t4g.micro, PG 16.14) — `fc-estimate-db.cv02w0mscr9b.ap-south-1.rds.amazonaws.com:5432/fc_handoff`, user `fcadmin` (password in `backend-node/.rds-credentials`, gitignored). SG `sg-093821cab0646db49` allows EC2 SG + user IPs (49.36.233.12, 103.59.75.212 — Jio IP changes on reconnect; add new ones with `aws ec2 authorize-security-group-ingress --group-id sg-093821cab0646db49 --protocol tcp --port 5432 --cidr <ip>/32`).
  - All 7 tables verified in RDS (exact counts); local `.env` ALSO points at RDS now (TLS verify-full via `rds-global-bundle.pem`; note `sslmode` in URL overrides pg Pool `ssl` option — use `sslrootcert=` URL param).
- **Server layout**: app at `~/fc-estimate/backend-node`, pm2 process `fc-builder-api` (systemd startup), nginx vhost `fc-estimate` → 127.0.0.1:4100, Vertex `service-account.json` at `/home/ubuntu/`.
- **CI/CD**: `.github/workflows/deploy.yml` — push to main → SSH (secrets EC2_HOST/EC2_USER/EC2_SSH_KEY) → git reset --hard origin/main + npm ci + pm2 restart + health check. Verified working.
- **Domain/TLS (final setup — user built it via ALB)**: `fc-estimate.figitallabs.com` → shared ALB `alb-main-figitallabs` (HTTPS 443 + ACM cert, HTTP 80 → 301 redirect) → target group `tg-fc-estimate` (instance:80, health check `/health`) → nginx → :4100. certbot NOT used.
- **EC2 SG final**: 22 ← 0.0.0.0/0 (key-only; CI needs it), 80 ← ALB SG `sg-04c8053d905ab4f4d` only (raw-IP access closed). Instance :443 closed (TLS at ALB).
- Live URLs: frontend https://fc-estimate.figitallabs.com/ · API /api/* · Swagger /docs.

## 10. Ops notes & family expansion (2026-07-07)

- **DNS gotcha**: when the user switched the record A→CNAME(ALB), resolvers that queried in the gap cached NXDOMAIN for 30 min (zone negative TTL 1800s). Zone was always healthy at Cloudflare (tom/gwen). Diagnosis: query authoritative NS directly; fix: wait/flush (macOS `dscacheutil -flushcache`, Chrome `chrome://net-internals/#dns`, Google flush page).
- **Only 3 procedure families are registered** (robotic TKR right/left/bilateral) — see cohort.js. Reason: the reference workbook existed only for robotic-TKR-right; the others reuse the same surgical-knee line definitions. Big candidate cohorts in the data (≥50 cases/payor): conventional TKR left/right/bilateral (GIPSA + Non-GIPSA heavy), PTCA 1-vessel (131 cash — daycare/cath-lab family: needs cath-lab rows instead of OT), CAG CAT-1 (109 cash), lap cholecystectomy, LSCS. ~2.5k cases have package_name '#N/A' (unusable without another cohort signal).
- Non-TKR families need family-specific `core_line_definitions` variants (docs 12/15: cath-lab vs OT emphasis, daycare handling) — the current core rows are knee-surgery-shaped (X-ray knee, physio package, OTI0098 procedure row).
- **THR family added (2026-07-07)**: `total_hip_replacement_thr_hemiarthroplasty` — 95-case cohort (8 package codes), `coreTemplate:'auto'` (template rows = cohort default-included items; knee fixed layout untouched), `implantProfile:'hip'` (Femoral Stem/Acetabular Shell/Insert/Head...), no procedure row (OT slots carry it). Sanity 12/12 (Cash→All Payers fallback; GIPSA org exact). Known: THR workbook logs row-count warning (206 vs 72 template rows) — values correct, some cross-sheet formulas beyond template ranges may misalign; JSON API fully correct.
- **Dynamic workbook mode (2026-07-07)**: `workbook/dynamicSheets.js` — when a family's row counts differ from the TKR template (detected in generateWorkbook), 8 interactive sheets (LID, Add-Ons, Grouped, Advanced, Implant Selection, Estimate Summary, EvA, Breakdown) are GENERATED with live formulas over correct row ranges (mode/room picks, include-exclude, MLC/emergency/PF/drug-admin, implant resolver); stats baked as values, remaining sheets replay. TKR keeps cell-exact template replay.
- **Manager-reported bugs fixed (2026-07-07)**: zod schema in estimate.routes.js was silently STRIPPING `emergency_ot`, `mlc` and the whole `selections` object (zod drops undeclared keys) → MLC always ₹0, OT always normal ladder, toggles ignored. Data/engine were always correct (TR1 HSP0047=₹1200; OT-E ladder). Lesson: any new API input field MUST be added to the zod schema.
- **3 more families (2026-07-07)**: `general_medical_management` (245 curated-template cases, medical: no OT/cath/surgical rows), `chemotherapy_systemic_therapy_infusion_daycare` (875, daycare), `coronary_angio_cag_cat_1_daycare` (165, cath-lab family: real cath amounts from service rows, cath items excluded from template to avoid double count). USER DESIGN RULE: families are CLINICAL cohorts only — never bake payor/tariff into family name or whereSql (payor+room are user inputs; TKR-right is the one exception, being the parity target). Daycare families set `daycare:true` → room selection N/A (UI disables it; engine normalizes to General). Daycare IP pharmacy uses bucket quartiles (`ipPharmacyMode:'bucket'`) since per-day×0-stay would zero out. Frontend dropdown now driven by GET /api/lookup/families.
- **Medical Records rule (manager-reported fix, 2026-07-08)**: daycare bills MSC10 "MEDICAL RECORDS-1 DAY" (₹360); non-daycare bills RNS0120 "MEDICAL RECORDS- > 1 DAY" (₹1300) — verified in data (RNS0120 never appears in daycare admissions). Both codes are LOGIC_DRIVEN (never template/add-on rows); the Medical Records logic row picks by `rows.medicalRecords` family flag. Chemo/CAG daycare were double-charging both before the fix.
- **5 more families (2026-07-08)**: total_knee_replacement_unilateral (683 cases) / _bilateral (218) — conventional knee, implantProfile knee; ptca_single_vessel (213 — NOT daycare, 3.7d stay, cath-lab family); lap_cholecystectomy (257); lscs_caesarean (188, ot:false — only ~8% have parseable OT rows, procedure cost lives in template rows). 12 families total. NOTE: run local validations with DATABASE_URL=postgresql://apple@localhost:5432/fc_handoff — big cohorts over WAN to RDS time out (683×JSONB ≈ 140MB).

## 11. Package add-on (2026-07-08)
- Overlay from `developer_handoff_fc_package_addon/` applied to BOTH local + RDS fc_handoff: fc.package_master(1145)/room_rates(3192)/alias(5034)/org_applicability(3715) + views v_package_runtime_lookup (primary surface) / v_package_case_history (evidence only).
- Manager rules (i4.md) enforced in packages.service.js: lookup priority code→name→alias; no match = 'no_package_exists' (never guess); docs from curated fields only; history never fabricates.
- `/api/packages/{lookup,search,resolve,history}`; `/api/estimate/build` → `package_offer` SIDE-BY-SIDE (user decision: never replaces itemized; workbook integration deferred). Auto-detect = cohort-dominant package_code (fetchCohortRows now selects package_code/name); override via input.package{code|name|text}; free-text = scored-OR alias match + Gemini ranking (AI never invents).
- Gotchas: readiness primary_blocker/warning_reason store literal 'None' string; insurance grain = org-level rows (cash rows have blank organization_cd).
- **Workbook package sheet (2026-07-08)**: sheet 17 "Package Comparison" appended in BOTH modes when package_offer resolves (side-by-side amounts w/ live ='Estimate Summary'!E2 link, curated details/inclusions/exclusions, room rates, history-as-evidence). Absent when no_package_exists. validate_workbook compares only the first 16 sheets.
- **Data-quality flag for manager**: 38/1145 packages have placeholder amounts ₹1/₹10 (all TR1 cash; 6 marked can_generate_estimate=true incl. all 4 cash THR packages!). List: PACKAGE_AMOUNT_FLAGS.csv (repo root).
- **Package coverage engine (2026-07-08, user-designed)**: coverage.js parses curated inclusion text (semi-structured: stay days "2 day-ward, 1 day-ICU", bucket caps IP/OT/implants, room-wise investigation caps, item allowances "NAME - QTY", exclusions) → per-line statuses {fully_included, partially_included(days), capped(amount), excluded, not_included, review(→full price, never silent ₹0), recomputed(drug-admin on payable pharmacy only)} with curated source-line provenance. Dual totals: with_package = package_amount + Σ final_amounts. UI: 2 new line-item columns + payable-only toggle + dual KPIs; workbook Package Comparison has the coverage table. Parser gotchas: split inclusions on newlines ONLY (names contain " - "); OT allowance counts SLOTS not hours; inclusions_text may hold 2 concatenated source variants (deduped for display via inclusions_display; FLAG for manager — variants differ e.g. investigations 7260/7920 vs 8000/8000).
- **Package Explorer (2026-07-08)**: /packages.html — port of the manager's tester UI (i4.md) onto our stack, completing his loop (his tester only previewed the bundle; ours runs the estimate). GET /api/packages/detail = full curated row + variants + aliases + org applicability + history samples + family mapping (familyForPackage in cohort.js; unmapped → "family not yet onboarded", Run button disabled). Cross-links: estimate package card "View full details →" ↔ explorer "Run estimate with this package →" (deep links /?procedure&package_code, /packages.html?tariff_code&package_code).
- **Grouped-residual policy correction (manager i5.md, 2026-07-08)**: investigation-promoted residuals (<90% presence, e.g. TKR Coagulation 61.5% / Inflammatory 53.8%) are now band 'optional' default EXCLUDE (still visible with review note); only >90% (Haematology 100%) auto-includes. The promotion-to-auto bug came from the manager's own reference script and his finalized Excel inherited it. New TKR default final ₹588,175.60 (was 597,612.07). Parity suites PIN the sample's state via explicit selections {grouped:{Coagulation/Inflammatory:'Include'}} — workbook statics now 99.765% (2 extra diffs = corrected Why texts).

## 12. Insurance settlement layer (2026-07-08, user decision: built in fc-builder, NOT Hospital_OS)
- Hospital_OS analysis done first (two agent reports in session): its IRDAI 7-step engine EXISTS client-side (useEstimateBuilder.ts:3865 — insurance-features-status.md is STALE); real gaps there: sub-limits not applied to math, tier eligibility not resolved to ₹, top-up deductible absent, persistence gaps. We implemented the layer here instead, per-ROW (finer than HO's bucket level).
- `insurance/settlement.js`: settle() — row classes (NME regex list/KIMS, exempt = Pharmacy+Investigations+ICU-day rows, associated = rest), ward ratio = cap ÷ Bed-Charges rate/day (tier eligibility resolves via bed row's per-room rates — upgrade excess computed), icu ratio (2% SI default), structured sub_limits (implants/pharmacy/investigations/procedure/total) scale row groups, copay on admissible, TPA = min(admissible−copay, baseSI−consumed+NCB), top-up standard(per-claim)/super(consumed counts toward deductible), patient = NME+copay+deduction+overflow+upgrade+beyond. Conservation invariant: insurer+patient = gross+upgrade (guard against display-rounded ratios in math — was a ₹320 bug).
- settleWithPackage(): package amount fully admissible (procedure/total sub-limits cap it), coverage-engine payable extras settled per-row.
- API: `insurance` input block on /build (zod-declared!); outputs estimate.insurance_settlement + package_offer.insurance_settlement. Frontend: policy fieldset (payor≠Cash) incl. sub-limits textarea "group:amount:label"; settlement card (covers/pays split + breakdown chips + via-package line). Sanity: scripts/sanity_insurance.js 24/24 (6 documented scenarios).
