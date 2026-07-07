# fc-builder-api — FC Estimate Builder

Standalone Node/Express backend that rebuilds the finalized **non-package FC (Financial
Counselor) Estimate Builder** from the clean FC handoff database — computing
percentile-driven cost estimates from historical cohorts and generating the full
**16-sheet interactive Excel workbook** with parity to the finalized builders.

Built per the handoff pack in `../new2/` (docs 01–17): UI-first, DB-backed, clean new
scripts — the reference Python scripts were used as logic evidence only, never ported.

## Validation status

| Suite | Result |
|---|---|
| `npm run validate:artifacts` | **1392/1392** — every Reference-sheet block recomputed from DB matches the finalized workbook's cached values |
| `npm run validate:estimate` | **1042/1042** — all 72 line items × 12 cells; final estimate `597612.0654575195` to the paisa |
| `npm run validate:workbook` | **99.77%** of 53,218 cells — 100% formulas, 100% cached values, 100% structure; all 123 diffs are static labels where the clean DB supersedes the sample's artifact-era CSVs |

Validated family: `robotic_tkr_unilateral_right` (cash / TR1 — the 26-case cohort of the
reference workbook). Also registered: `robotic_tkr_unilateral_left`, `robotic_tkr_bilateral`.

## Prerequisites

1. **Node 20+** and **PostgreSQL** running on `localhost:5432`.
2. **Restore the handoff DB** into a database named `fc_handoff`:
   ```bash
   createdb fc_handoff
   psql -d fc_handoff -f ../developer_handoff_fc_estimate_builder/database/fc_handover_phase1_clean.sql
   ```
   ⚠️ The dump's `mart.main_table` jsonb columns contain Python-dict literals that raw
   Postgres rejects — restore the 16 columns as `text` first, convert with
   `ast.literal_eval → json.dumps`, then re-type to `jsonb` (this repo's DB was fixed
   that way; see the note in `spec/BUILD_SPEC.md`).
3. **Vertex AI** service account for the AI endpoints (or a `GEMINI_API_KEY`).

## Setup & run

```bash
npm install
cp .env.example .env        # fill DATABASE_URL + Vertex/Gemini vars
npm run dev                 # http://localhost:4100
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with watch reload (port 4100) |
| `npm start` | Production server |
| `npm run validate` / `npm test` | All three validation suites against the reference workbook |
| `npm run validate:artifacts` | Reference-block parity (basis quartiles, item stats, PF, OT ladder…) |
| `npm run validate:estimate` | End-to-end engine parity (line items, totals, final estimate) |
| `npm run validate:workbook` | Generates the .xlsx and compares it cell-by-cell with the sample |
| `npm run build:template` | Regenerates `src/modules/workbook/template.json` from the parity artifacts (one-time; only needed if the layout contract changes) |
| `npm run docs` | Opens Swagger UI (server must be running) |

## API

Interactive docs: **`http://localhost:4100/docs`** (Swagger UI) · raw spec `/openapi.json`
· Postman: import **`postman.json`** · full reference: **`API.md`**

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + DB check |
| `GET /api/lookup/{organizations,service-items,pharmacy-items,doctors}` | DB-grounded pickers |
| `POST /api/estimate/build` | Full JSON estimate (drivers, line items, payer bases, totals, warnings) |
| `POST /api/estimate/workbook` | The 16-sheet interactive `.xlsx` (live formulas + dropdowns) |
| `POST /api/estimate/intake` | AI: free-text intake note → structured input |
| `POST /api/estimate/map-items` | AI: fuzzy item descriptions → canonical items (DB decides) |
| `POST /api/estimate/explain` | AI: FC-facing plain-language estimate summary |

Quick check:
```bash
curl -s -X POST localhost:4100/api/estimate/build \
  -H 'Content-Type: application/json' \
  -d '{"clinical":{"procedure":"robotic_tkr_unilateral_right"},"payment":{"payor_bucket":"Cash"}}' \
  | jq .final_estimate
# → 597612.0654575195
```

## Architecture

```
src/
  index.js                    Express app + Swagger UI (/docs)
  db/pool.js                  pg pool (DATABASE_URL)
  routes/                     lookup + estimate routes (zod-validated input)
  modules/
    resolve/                  payor→tariff; payer-basis auto-resolution (doc 14 thresholds)
    drivers/normalization.js  LOS/room/OT normalization, slot snapping (doc 15)
    engine/
      cohort.js               clinical-family registry (cohort filters over mart.main_table)
      artifacts.js            recomputes every historical artifact from the DB
      services.js             cleaned set, add-on prioritization, grouping gaps (docs 10/17)
      advanced.js             OT-consumables shortlist, implant hierarchy (docs 09/17)
      lineItems.js            the calculation engine (all row archetypes, PF cascade)
      buildEstimate.js        orchestrator
    workbook/                 template-replay xlsx generator (template.json + bands.js)
    ai/                       Gemini via Vertex: intake, item mapper, explain
scripts/                      validation suites + template builder
spec/                         BUILD_SPEC, WORKBOOK_PARITY_SPEC, validation targets
output/                       generated workbooks (gitignored)
```

**Key design points**
- **Explicit over silent** (docs 04/05): unresolved tariffs/items surface as warnings, never guessed.
- **Workbook = template-replay**: layout/formulas/styles extracted once from the finalized
  workbook; every data cell driven from the live estimate payload (`bands.js`). Row-count
  divergence for new families logs a warning instead of corrupting formulas.
- **AI proposes, DB decides**: canonical item keys and organizations always come from the DB.

## Adding a new clinical family

1. Register it in `src/modules/engine/cohort.js` (cohort `whereSql` over `mart.main_table`,
   procedure code/label, family kind).
2. `POST /api/estimate/build` with the new `clinical.procedure` — the engine computes all
   artifacts from the cohort automatically.
3. For workbook output, check the row-count warnings; extend `bands.js` ranges if the
   family has more add-ons/residuals than the template.

## Known boundaries (Phase 1, per docs 08)

- Package-master-backed estimation, org-name aliases, and bill auditing are out of scope.
- Insurance-policy exclusion list (Reference `EX:FA`) is seeded from the finalized workbook
  (not present in the clean DB).
- PF modeling is implementation-target for the surgical implant families; review-only
  context for medical/daycare families (doc 16).
