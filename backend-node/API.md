# FC Estimate Builder API — `fc-builder-api`

Standalone Node/Express backend that rebuilds the finalized non-package **FC Estimate Builder**
from the clean FC database (local Postgres `fc_handoff`), with AI-assisted intake via
Gemini (Vertex AI). Produces JSON estimates and the full 16-sheet Excel workbook with
parity to the finalized builders.

## Run

```bash
cd backend-node
npm install
npm run dev        # http://localhost:4100
```

`.env` (see `.env.example`):

| Var | Meaning |
|---|---|
| `DATABASE_URL` | `postgresql://apple@localhost:5432/fc_handoff` (restored handoff dump) |
| `VERTEX_AI_PROJECT` / `VERTEX_AI_LOCATION` / `GOOGLE_APPLICATION_CREDENTIALS` | Vertex AI auth (service account) |
| `GEMINI_API_KEY` | fallback API-key mode when Vertex vars unset |
| `GEMINI_MODEL` | default `gemini-2.5-flash` |
| `PORT` | default `4100` |

## Interactive docs & Postman

- **Swagger UI**: `http://localhost:4100/docs` (raw spec at `/openapi.json`, source `openapi.json`)
- **Postman**: import `postman.json` (collection with all 10 requests, sample bodies, and notes; `baseUrl` variable defaults to `http://localhost:4100`)

## Endpoints

### Health
```
GET /health → { ok: true, db: "fc_handoff" }
```

### Lookups (UI pickers / grounding)
```
GET /api/lookup/organizations                 → insurance orgs + tariff mapping (68)
GET /api/lookup/service-items?q=knee          → canonical service items (≤50)
GET /api/lookup/pharmacy-items?q=cement       → canonical pharmacy items + MRP/rate (≤50)
GET /api/lookup/doctors?q=reddy&tariff_name=KIMS → consultation doctors (≤50)
```

### Estimate — JSON
```
POST /api/estimate/build
```
Body (all controls optional — defaults shown):
```json
{
  "patient":  { "name": "Ramesh Kumar", "age": 64, "gender": "M", "umr_no": "", "admission_no": "" },
  "clinical": { "procedure": "robotic_tkr_unilateral_right", "doctor_name": "", "doctor_cd": "" },
  "payment":  { "payor_bucket": "Cash", "organization_cd": "" },
  "controls": {
    "room_type": "Single",            // General | Twin | Single
    "estimate_mode": "Typical",       // Low | Typical | High
    "payer_basis": "Auto (Recommended)",
    "los_basis": "P50", "icu_basis": "P50", "ward_basis": "P50", "ot_hours_basis": "P50",
    "icu_manual": null, "ward_manual": null, "ot_hours_manual": null,
    "emergency_ot": "No", "mlc": "No",
    "robotic": "auto"                 // yes | no | auto (auto = presence > 90%)
  },
  "selections": {                      // optional include/exclude overrides
    "add_ons":        { "BIO0106": "Include" },
    "grouped":        { "Coagulation Tests": "Exclude" },
    "ot_consumables": { "PURU02": "Include" },
    "implants":       { "mode": "Default P50", "family": "All", "brand": "All", "itemCode": "None" }
  }
}
```
Response: `resolved_context` (payor, tariff, payer bases with resolver reason/confidence,
robotic state, OT slot), `drivers` (LOS/ICU/Ward/OT p25/p50/p75 + selected),
`line_items[]` (every row with per-room Low/Typ/High cells), `subtotal`, `grand_total`,
`final_estimate`, `bucket_totals`, `add_ons[]`, `grouped_adjustments[]`,
`advanced_controls` (OT-consumables shortlist + implant hierarchy), `service_line_count`
alert, `warnings[]`, `unresolved_items[]`.

Known procedure families: `robotic_tkr_unilateral_right` (validated to exact parity),
`robotic_tkr_unilateral_left`, `robotic_tkr_bilateral`.

### Estimate — Excel workbook
```
POST /api/estimate/workbook          (same body) → .xlsx download
```
16 sheets matching the finalized builder: Builder, Estimate Summary, Estimate vs IP FC
Actuals, Advanced Controls, Service Add-Ons, Grouped Adjustments, Grouping Review,
Implant Selection, Estimate Breakdown, Line Item Detail, Pharmacy Template, Service
Template, Pharmacy Metrics, IP FC Actuals, Professional Fees Review, Reference — with
live formulas, dropdowns, and formatting, so the workbook stays interactive.

### Packages (side-by-side layer — package add-on overlay)
```
GET  /api/packages/lookup?tariff_code&package_code|package_name&organization_cd
GET  /api/packages/search?tariff_code&q          → alias candidates (no AI)
POST /api/packages/resolve { text, tariff_code } → alias + Gemini-ranked resolution
GET  /api/packages/history?tariff_code&package_code
```
`POST /api/estimate/build` responses now include `package_offer` (side-by-side):
auto-detected from the cohort's dominant package, overridable via input
`package: { package_code | package_name | text }`. Statuses: `resolved` /
`not_ready` (readiness blocker) / `no_package_exists` (never a silent guess).
Documentation fields come only from curated package data (manager rule, i4.md).

### AI assist (Gemini via Vertex)
```
POST /api/estimate/intake     { "text": "<free-text intake note>" }
  → structured { patient, clinical, payment, notes } + DB-grounded organization candidates

POST /api/estimate/map-items  { "items": [{ "description": "knee xray bedside", "kind": "service" }] }
  → per item: DB candidates + AI-ranked resolved canonical item (AI never invents keys)

POST /api/estimate/explain    (same body as /build)
  → { final_estimate, bucket_totals, explanation }  — FC-facing plain-language summary
```

## Example

```bash
curl -s -X POST localhost:4100/api/estimate/build \
  -H 'Content-Type: application/json' \
  -d '{"clinical":{"procedure":"robotic_tkr_unilateral_right"},
       "payment":{"payor_bucket":"Cash"},
       "controls":{"room_type":"Single","estimate_mode":"Typical"}}' | jq .final_estimate
# → 597612.0654575195  (matches the finalized workbook to the paisa)

curl -s -X POST localhost:4100/api/estimate/workbook \
  -H 'Content-Type: application/json' \
  -d '{"clinical":{"procedure":"robotic_tkr_unilateral_right"},"payment":{"payor_bucket":"Cash"}}' \
  -o fc_estimate.xlsx
```

## Validation

```bash
node scripts/validate_artifacts.js   # Reference-block parity vs sample workbook (1392 checks)
node scripts/validate_estimate.js    # end-to-end engine parity (1042 checks incl. final estimate)
node scripts/validate_workbook.js    # generated .xlsx vs sample, cell-by-cell
```

## Architecture

```
src/
  index.js                     Express app
  db/pool.js                   pg pool
  routes/                      lookup + estimate routes
  modules/
    resolve/                   payor→tariff, payer-basis (doc 04/14 thresholds)
    drivers/normalization.js   LOS/room/OT normalization + slot snapping (doc 15)
    engine/
      cohort.js                clinical-family cohort registry
      artifacts.js             recomputes all historical artifacts from mart.main_table + fc.*
      services.js              cleaned set, add-on prioritization, grouping gaps (docs 10/17)
      advanced.js              OT-consumables shortlist, implant hierarchy (docs 09/17)
      lineItems.js             the calculation engine (all row archetypes, PF cascade)
      buildEstimate.js         orchestrator
      rules.js / stats.js      canonical thresholds; inclusive quartiles
    workbook/                  exceljs 16-sheet generator (parity spec)
    ai/                        gemini.js (Vertex), intake, itemMapper, explain
spec/                          BUILD_SPEC, WORKBOOK_PARITY_SPEC, validation targets
```
