# Insurance edge-case suite — bugs found (2026-07-08)

Source: `backend-node/scripts/edge_insurance_suite.mjs` (32 cases) against `POST /api/estimate/build`.
Full numbers per case: `INSURANCE_EDGE_TESTS.pdf` · raw JSON: `backend-node/test_results/insurance_edge_results.json`.

**Verdict: settlement mathematics is sound** — the conservation invariant (insurer + patient = gross + upgrade-excess), cover ceilings, copay, sub-limit, top-up and proportionate-deduction math held on every case that produced a settlement (T01–T24, T26–T28). The 3 bugs below are all in the *edges around* the engine, not in the settlement arithmetic itself.

---

## BUG-1 · HIGH — full room names silently zero the settlement (and mis-price the estimate)

**Failing cases:** T25, T31, T32.

`room_type` is used directly as `room.toLowerCase()` to index the per-room amount maps `selected{general, twin, single}`. The schema comment itself documents the values as `GENERAL WARD | TWIN SHARING | SINGLE | DELUXE`, but any value other than exactly `General`/`Twin`/`Single` produces an unknown key, and every consumer degrades differently — **all silently**:

| Consumer | Behaviour on unknown key (e.g. `"Twin Sharing"`) |
|---|---|
| `buildEstimate` bucket totals (`buildEstimate.js:202`) | falls back to `selected.single` → estimate is quietly priced at **Single** rates |
| `settle()` (`settlement.js:57`) | every row reads ₹0 → gross ₹0 → **insurer ₹0 / patient ₹0**, no warning note |
| `applyCoverage()` (`coverage.js:100`) | every row reads ₹0 → all rows `not_included / zero` → `payable_extras` ₹0 → **with-package total = bare package amount** (looks deceptively perfect) |
| `settleWithPackage()` | inherits both problems above |

**Repro:** `{"controls":{"room_type":"Twin Sharing"}, "insurance":{"base_sum_insured":700000}}` → `final_estimate` ₹2,46,410 (Single price, not Twin) but `insurance_settlement.gross = 0`.

**Not user-visible today** (the web UI sends `General`/`Twin`/`Single`) — but any direct API consumer following the schema comment hits it.

**Proposed fix:** normalize once at input (`/twin/i → twin`, `/general/i → general`, `/single|deluxe/i → single`), reject anything unmatched with a 400, and add a guard in `settle()`: if `gross === 0` while `final_estimate > 0`, return an explicit error instead of an all-zero settlement.

---

## BUG-2 · HIGH — no insurance package's inclusion text is parseable → "with package" total is inflated / meaningless

**Symptom (24 of 32 cases, flagged ⚠):** for GIPSA THR, *with package* = ₹5,30,293 > *without package* = ₹3,80,393. The package route should almost never cost more than itemized.

**Root cause:** `parseCoverage()` understands only the curated `new2` bullet format (`HOSPITAL STAY | 4 day-ward…`, `PHARMACY IP | 25,000`, `NAME - QTY` allowances). Measured against the whole catalog:

| payor bucket | packages with inclusion text | parse yields **zero** coverage signal |
|---|---|---|
| cash | 90 | 14 |
| gipsa_insurance | 108 | **108 (100%)** |
| non_gipsa_insurance | 199 | **199 (100%)** |

GIPSA texts are in the PPN clause format (`L1: Standard inclusions - Doctor's fee, OT charges, … | L3: Special Investigations - … | L4: …`, pipe-separated); non-GIPSA texts use other layouts. With zero signal, every line item falls to `review → payable at full price`, so the package price is **added on top of** the full itemized total instead of absorbing it.

Note the semantics of the GIPSA `L1` clause: "standard inclusions" covers doctor fees, OT, anaesthesia, drugs, investigations, room rent, nursing — i.e. nearly the whole itemized estimate should be netted off, with typically only implants + NME as extras.

**Proposed fix (evaluate):**
1. Teach `parseCoverage()` the GIPSA clause grammar (`L1/L2/L3/L4` sections; map "standard inclusions" to the associated + PF + room + investigation row classes), or
2. Ask the manager for curated per-package inclusion structures for the insurance tariffs (same curation as the cash `new2` docs), or
3. Interim: when parse yields zero signal, show "package inclusions not machine-readable — with-package total unavailable" instead of an inflated number.

---

## BUG-3 · MEDIUM — zod validation errors return HTTP 500 instead of 400

**Failing cases:** T29 (negative `base_sum_insured`), T30 (sub-limit cap 0).

The route does `EstimateInput.parse(req.body)` inside try/catch → `next(err)`, and the error middleware (`src/index.js:37`) defaults to `err.status || 500`. A `ZodError` has no `status`, so client input errors surface as **server faults** with a raw zod issue array as the message.

**Proposed fix:** in the error middleware, map `err instanceof ZodError → 400` with a compact `field: message` list.

---

## Observations (not bugs — for awareness)

- **O-1 · Paise drift:** `check.insurer_plus_patient` vs `gross_plus_upgrade` differ by ₹0.01–0.02 on some cases (display rounding of row-level `round2`). Within tolerance; workbook should still use the exact fields.
- **O-2 · T12 copay 100%** behaves sanely (insurer ₹0, patient = everything) — no divide-by-zero.
- **O-3 · T21 SI ₹0** yields insurer ₹0 / patient = full bill with `beyond cover` labelled — reasonable, but the UI could warn "policy has no available cover".
- **O-4 · Daycare + room cap (T27):** cap logic runs against the daycare General-ward basis; no ward days → no deduction, copay only. Verify with manager that daycare claims should be cap-exempt (IRDAI daycare treatment usually has no room-rent component).
- **O-5 · Top-up cases (T22/T23)** matched hand-computed IRDAI expectations exactly (standard: pays above deductible threshold on the claim; super: prior consumed counts toward deductible).
