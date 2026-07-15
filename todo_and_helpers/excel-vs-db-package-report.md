# KIMS Insurance Packages — Excel vs DB Reconciliation Report

**Date:** 2026-07-13
**Source of truth:** `/Users/apple/Downloads/inputs/KIMS Insurance Packages .xlsx`
**Compared against:** deployed DEV engine (`fc-estimate-dev.figitallabs.com`), `GET /api/packages/detail` per package (backed by `fc.v_package_runtime_lookup` — `package_amount` + `room_rates_jsonb`)
**Scope:** ALL 642 Excel rows were looked up in the DB by service code (not a sample).

---

## 1. Executive summary — "how many times is it wrong"

| Metric | Value |
|---|---|
| Excel package rows (6 insurer sheets) | **642** |
| Found in DB (by exact service code + tariff) | **484 (75.4%)** |
| Absent from DB entirely | **158 (24.6%)** — incl. the **entire HDFC sheet (105 rows)** |
| Packages where all room-tier rates match Excel | **156 (24.3% of Excel; 32.2% of those found)** |
| Room-tier price cells compared (Gen/Twin/Single) | 1,452 |
| Tier cells wrong or missing in DB | **980 (67.5%)** — 920 wrong amounts + 60 missing tiers |

**Only Bajaj is fully correct. Star is ~89% correct. GIPSA, Medi Assist and ICICI are wrong on essentially every package, and HDFC does not exist in the DB at all.**

The premise is *partially* outdated in one respect: the DB **does** already store per-room-type rates (`room_rates_jsonb`, 3–4 tiers per package) alongside the single `package_amount`. The problem is that (a) `package_amount` is what the estimate engine surfaces and it is the **General Ward** rate (or, for GIPSA, an unexplained higher figure), and (b) for 3 of 6 insurers the stored tier rates come from an **older tariff revision** than the Excel.

---

## 2. Excel structure

Workbook has **6 sheets, one per insurer/TPA**. Every sheet is per-room-tier — confirming your instruction that tariffs differ by room type and provider.

| Sheet | Rows | Code column | Room-tier columns | Other columns |
|---|---|---|---|---|
| GIPSA | 210 | `SERVCODE` | **GW / TWIN / SINGLE** | PACKAGE NAME, LOS, EXCLUSIONS |
| HDFC | 105 | `EQUIVALENT CD` | **GENERAL / TWIN / SINGLE** | PACKAGE NAME, LOS, Exclusions |
| MEDI ASSIST | 84 | `SERVICE CODE` | **General ward / Semi Private / Private** | PACKAGE NAME, LOS, Exclusion |
| STAR | 120 | `EQUSERVICECD` (×2, duplicated header) | **GENERAL / TWIN / SINGLE** | Tariff name = `STAR_HYD_PKG_23`, TARIFFCD = **`TR176`**, SERVICENAME, EXCLUSION |
| ICICI | 71 | `EQUIVALENT CD` | **GENERAL / TWIN / SINGLE / ICCU / DELUXE / SUITE** | Service name, LOS, Exclusions |
| BAJAJ | 52 | `SERVICE CODE` | **GENERAL / TWIN / SINGLE / ICCU / DELUXE / SUITE** | SERVICENAME, LOS, Exclusion |

Semantics observed:

- **Service codes are KIMS HIS codes** (e.g. `CAR0122`, `CTH0059`) and match DB `package_code` directly — this made exact-code matching possible for all rows.
- **GIPSA sheet** is the GIPSA PSU-insurer rate card (structured multipliers: TWIN = GW × **1.125**, SINGLE = GW × **1.25** on almost every row; flat/day-care packages 1.0×).
- **ICICI upper tiers are formulaic:** ICCU = SINGLE, DELUXE = SINGLE × 1.2, SUITE = SINGLE × 1.35 on **all 71 rows**.
- **BAJAJ upper tiers are capped:** ICCU = DELUXE = SUITE = SINGLE on **all 52 rows** (rate stops escalating above Single).
- **LOS** is mostly numeric days; some rows say `day care` / `DAYCARE` (free text).
- GIPSA has two rows with malformed codes containing spaces (`E N T0017`, `E N T0018`) — cleaned to `ENT0017/18` for lookup.
- Duplicate codes for the same procedure are common (e.g. three CAG codes `CAR0122/CAR5153/CAR5158` at the same price).

---

## 3. Match methodology

1. Parsed all 6 sheets with openpyxl (642 data rows).
2. Mapped each sheet to the DB tariff via `GET /api/lookup/organizations`:

| Excel sheet | DB tariff | DB tariff name | Organization used |
|---|---|---|---|
| GIPSA | TR290 | KIMI_GIPS_24(C) | ORG56 New India Assurance (same card serves National/Oriental/United) |
| HDFC | TR286 | HDFC_HYD_23(C) | ORG126 HDFC Ergo |
| MEDI ASSIST | TR285 | MEDI ASST-23(C) | ORG1197 Aditya Birla (same card: Go Digit, Manipal Cigna, MD India, Health Assist) |
| STAR | TR287 | STAR_HYD_23(C) | ORG61 Star Health |
| ICICI | TR201 | **SSG_ICICI** | ORG59 ICICI Lombard |
| BAJAJ | TR289 | BAJA_HYD_23(C) | ORG57 Bajaj General |

3. Called `/api/packages/detail?tariff_code&package_code&organization_cd` for **every** Excel row (642 calls; 54 transient 502s retried successfully). Note: `organization_cd` is **required** for insurance tariffs — without it the lookup view only matches org-blank (cash) rows and returns `no_package_exists`.
4. Compared Excel GW/Twin/Single against DB `room_rates_jsonb` tiers and against the single `package_amount`.

DB room-category codes per tariff (they are not uniform):

- GIPSA / STAR / MEDI ASSIST: `multi_sharing_general_ward`, `twin_sharing_ac_single_room_non_ac`, `deluxe_single_room_ac_private` (Medi Assist additionally has `general_ward_add_on` / `twin_sharing_add_on` / `single_room_add_on` per-day add-on amounts of 7,000/9,000/10,000)
- ICICI (TR201): `general`, `triple`, `twin`, `single_ac` (4 tiers)
- BAJAJ: `general`, `twin`, `single_deluxe`

**Coverage:** 484/642 Excel rows (75.4%) resolved to a DB package with amounts. This is a census of the Excel, not a sample; the only untested combinations are DB packages *not* present in the Excel (312 GIPSA, 176 Star etc. in DB vs 210/120 in Excel — the Excel is a subset).

---

## 4. Results per insurer

### 4.1 BAJAJ (TR289) — ✅ fully correct
52/52 found; **all General/Twin/Single tier rates match the Excel exactly**. `package_amount` = General tier. Excel's ICCU/DELUXE/SUITE columns are identical to SINGLE, so the DB's 3-tier model loses nothing here.

### 4.2 STAR (TR287) — ~89% correct, 13 packages wrong
116/120 found (missing: `NES5099` ant. cervical discectomy, `NES5028` post. cervical discectomy; 2 others resolved on retry). 103 packages match on all three tiers. **13 packages mismatch (35 wrong tier cells)** — pattern: `package_amount` was updated to the Excel figure but `room_rates_jsonb` still holds the old revision:

| Code | Package | Excel G/T/S | DB tiers G/T/S | DB `package_amount` |
|---|---|---|---|---|
| NES5208 | Laminectomy & discectomy — cervical | 225,225 / 251,213 / 277,200 | 150,150 / 167,475 / 184,800 | 225,225 (= Excel GW) |
| NES5209 | Laminectomy & discectomy — dorsal | same | same stale | 225,225 |
| ORT0052 | THR bilateral | 253,047 / 281,165 / 312,933 | 168,698 / 187,443 / 208,622 | 253,047 |
| ORT5531 | TKR bilateral | same | same stale | 253,047 |
| URO5138 | PCNL bilateral | 174,875 / 193,283 / 211,691 | 116,583 / 128,855 / 141,127 | 174,875 |
| URO5116 | RIRS unilateral | 72,600 / 79,200 / 85,800 | 60,500 / 66,000 / 71,500 | 72,600 |
| URO5132 / URO5079 | Orchiectomy / orchiopexy bilateral | 66,000 / 74,250 / 82,500 | 52,800 / 59,400 / 66,000 | 66,000 |
| SGA5085 / SGA5086 | Hydrocelectomy bilateral / unilateral | 66,000… / 44,000… | 44,000… / 52,800… | 79,200 / 52,800 — **rates look swapped between uni- and bilateral** |
| GYN0110 | Vaginal hysterectomy | 116,424 / 127,512 / 138,600 | 113,600 / 127,800 / 142,000 | 116,424 |
| ORT5205 | DHS / hemiarthroplasty | Twin 112,091 | Twin 112,901 | — **digit transposition (091 vs 901) in one source** |
| URO0023 | Cystoscopy + DJ stent removal | Twin 22,000 | Twin 22,500 | 20,000 |

### 4.3 GIPSA (TR290) — 0 packages fully correct
201/210 found (9 absent, incl. Normal Delivery `GYN0023`, Cataract-Phaco `OPT0260/0262`, PCNL `URO0187/URO5372`, prostate Holmium `URO5183`, `SGA5194`).

- **Every found package mismatches.** DB `room_rates_jsonb` holds a much older/lower rate set (e.g. CABG `CTH0059`: Excel 225,600/253,900/282,100 vs DB tiers 162,900/179,200/195,500).
- The two sources even use **different escalation multipliers**: Excel Twin/Single = GW × 1.125 / × 1.25; DB tiers = base × 1.1 / × 1.2.
- **Systematic ratio found:** for 188/201 packages, **Excel GW = DB `package_amount` × 0.90 exactly** (rounded to ₹100). i.e. the DB single amount is ~11.1% above the Excel GW rate — either the DB holds an undiscounted 2024 rate (tariff name is `KIMI_GIPS_24`) and the Excel applies a 10% GIPSA discount, or the Excel is the negotiated card and the DB is inflated. 9 packages match at 1.0; 4 are irregular.
- 20 found packages have **no room tiers at all** in the DB (60 missing cells).
- Largest deltas (Excel GW vs DB GW tier): Renal transplant `URO5365/5413` Excel 703,800 vs DB 385,000 (**Δ +318,800**); small-bowel resection `SGA5379` 265,900 vs 46,200; craniotomy `NES5110/5111` 239,700 vs 63,800; decompressive craniectomy `NES0073` 247,300 vs 77,000.

### 4.4 MEDI ASSIST (TR285) — 1 package fully correct
79/84 found with amounts (5 absent, incl. 2 CAG variants and nasal bone reduction). **78/79 mismatch.**

- **Systematic ratio:** Excel = DB tier × **1.18** on 222/234 tier cells (mean 1.19). The Excel is plainly a newer revision of the same card with a uniform **+18% uplift** the DB never received.
- DB uniquely carries per-day room **add-on** tiers (7k/9k/10k) with no Excel counterpart.
- `package_amount` = DB General tier (so doubly stale).

### 4.5 ICICI (TR201 SSG_ICICI) — 0 correct, likely the wrong contract entirely
Only 36/71 found (**35 absent = 49%**), and all 36 found mismatch on every tier with **scattered ratios (1.3×–3.2×)** — no uniform uplift. DB tier structure also differs (general/triple/twin/single_ac vs Excel's 6 columns). Conclusion: the DB's `SSG_ICICI` tariff is a **different (older/corporate SSG) agreement**, not the ICICI Lombard card in the Excel. Examples: AVR/MVR Excel GW 304,800 vs DB 169,000; CABG 294,000 vs 169,000; bilateral hip 261,000 vs 130,000.

### 4.6 HDFC (TR286) — completely absent
Tariff TR286 `HDFC_HYD_23(C)` exists and is linked to ORG126 HDFC Ergo, but has **0 packages** in the DB. All 105 Excel rows returned `no_package_exists`. The whole HDFC card needs loading.

---

## 5. Aggregates — your numbers

| Insurer | Excel rows | In DB | Absent | Fully matching | Wrong (found but ≠) | Wrong-cell rate |
|---|---|---|---|---|---|---|
| BAJAJ | 52 | 52 | 0 | **52 (100%)** | 0 | 0 / 156 |
| STAR | 120 | 116 | 4 | 103 (86%) | 13 | 35 / 348 (10%) |
| GIPSA | 210 | 201 | 9 | **0** | 201 | 603 / 603 (100%) |
| MEDI ASSIST | 84 | 79 | 5 | 1 | 78 | 234 / 237 (99%) |
| ICICI | 71 | 36 | 35 | **0** | 36 | 108 / 108 (100%) |
| HDFC | 105 | **0** | 105 | 0 | — | — |
| **Total** | **642** | **484 (75%)** | **158 (25%)** | **156 (24%)** | **328 (51%)** | **980 / 1,452 (67.5%)** |

Systematic patterns (root causes, not random noise):

1. **HDFC card never loaded** (105 rows).
2. **GIPSA tier rates are an old revision** with old multipliers (1.1/1.2 vs 1.125/1.25), while `package_amount` sits ~11% *above* the Excel GW (Excel = amount × 0.90 on 94% of rows).
3. **Medi Assist is uniformly one revision behind** (Excel = DB × 1.18).
4. **DB "ICICI" is a different contract** (SSG_ICICI) — half the Excel's packages missing, prices unrelated.
5. **Star: `package_amount` refreshed, `room_rates_jsonb` not** on 13 packages — the two fields are drifting independently.
6. **Engine surfaces one number** — `package_amount`, which (where determinable) equals the **General Ward** tier — so any twin/single patient is under-quoted by 10–35% even where the tiers are stored correctly.
7. Readiness is a separate axis: of the 484 found, 175 are `not_ready` (blockers = missing FC-history/template mapping), independent of price correctness.

---

## 6. Schema recommendation — per-room package amounts

The plumbing half-exists (`room_rates_jsonb` on `fc.package_master` → `fc.v_package_runtime_lookup`). Recommended target state:

1. **Normalise room rates into a child table** instead of (or materialising) the JSONB:

```sql
CREATE TABLE fc.package_room_rate (
  tariff_code        text NOT NULL,
  package_code       text NOT NULL,
  room_category_code text NOT NULL,   -- canonical enum below
  amount             numeric(12,2) NOT NULL,
  rate_basis         text,            -- 'contract' | 'derived_multiplier'
  effective_from     date NOT NULL,
  effective_to       date,            -- versioning: never overwrite, close old row
  source_ref         text,            -- e.g. 'KIMS Insurance Packages.xlsx / STAR / row 14'
  PRIMARY KEY (tariff_code, package_code, room_category_code, effective_from)
);
```

2. **Canonical room-category enum** covering every tier seen in either source: `general_ward`, `semi_private_twin`, `private_single`, `iccu`, `deluxe`, `suite` — plus a per-tariff mapping table (`fc.tariff_room_category_map`) because each insurer names/collapses tiers differently (Bajaj caps everything above Single; ICICI derives Deluxe/Suite as 1.2×/1.35× Single; Medi Assist calls them GW/Semi-Private/Private).
3. **Per-day room add-ons** as a rate-type on the same table (Medi Assist's 7k/9k/10k) rather than a bespoke column.
4. **Deprecate scalar `package_amount` as the quoted figure.** Keep it only as a fallback and define it explicitly (= `general_ward` rate). The coverage engine should resolve `(tariff, package, patient's room_category, admission_date)` → rate, using the policy's room-cap logic (already a concept in the estimate flow) to pick the tier.
5. **Version, don't overwrite** — the Star drift (amount updated, tiers stale) and the GIPSA/Medi Assist "old revision" problems are exactly what `effective_from/to` + `source_ref` prevent.
6. ETL: this Excel can seed the table directly — codes align with `package_code` for 75% of rows out of the box.

---

## 7. Open questions for you

1. **GIPSA 0.9 factor** — Excel GW = DB `package_amount` × 0.90 on 188/201 packages. Is the Excel a 10%-discounted GIPSA card (and the DB's 2024 amount right but undiscounted), or is the Excel the signed rate and the DB inflated? Which multipliers are contractual — 1.125/1.25 (Excel) or 1.1/1.2 (DB)?
2. **ICICI** — the DB only has `SSG_ICICI` (TR201). Is the Excel ICICI sheet a *new* ICICI Lombard agreement that should become a new tariff, or a replacement for TR201?
3. **STAR tariff identity** — Excel says `TARIFFCD TR176 / STAR_HYD_PKG_23`; the DB serves Star from `TR287 STAR_HYD_23(C)`. Same agreement, different code — which is canonical? (Prices agree 89%, so probably the same card.)
4. **Star hydrocelectomy `SGA5085`/`SGA5086`** — unilateral/bilateral rates appear swapped between Excel and DB; which is right? Also `ORT5205` Twin 112,091 vs 112,901 (digit transposition — which source has the typo?) and `URO0023` Twin 22,000 vs 22,500.
5. **HDFC** — confirm the sheet is current so we can load all 105 packages into TR286.
6. **ICICI/Bajaj upper tiers** — should ICCU/Deluxe/Suite be stored explicitly, or derived (ICICI: 1.0/1.2/1.35 × Single; Bajaj: capped at Single)?
7. **Medi Assist +18%** — is the Excel the currently effective revision (effective when?), and do the DB's per-day room add-ons (7k/9k/10k) still apply on top?
8. **Missing packages** (9 GIPSA, 4 Star, 5 Medi Assist, 35 ICICI listed in section 4) — add to the catalogue, or intentionally dropped from the contracts?
9. The Excel's `LOS` includes free text (`day care`) — confirm day-care handling for pre/post-day logic.

---

## 8. Honesty about limits

- Matching was by **exact service code** within the mapped tariff — stronger than name matching, but if a package was re-coded between revisions it would show as "absent" rather than "renamed" (likely contributes to some of the 158 absences, esp. ICICI).
- Only one organization per tariff was queried (e.g. New India for GIPSA); other orgs on the same tariff are assumed to share the card, as the org lookup indicates.
- DB values came via the runtime view through the API, not raw SQL — anything the view filters out (inactive rows, other room-category codes) is invisible here.
- "±" thresholds: amounts compared exactly (< ₹0.50); the 0.90 / 1.18 ratios allow ±1% for the ₹100 rounding visible in the Excel.
- The DB contains packages *not* in the Excel (e.g. 312 GIPSA in DB vs 210 in Excel); those were not audited — this report only answers "is what the Excel says reflected in the DB".
