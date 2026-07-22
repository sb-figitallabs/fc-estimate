# TODO — Render the NME advisory line in the estimate-builder frontend

**Status:** backend DONE + deployed to dev (2026-07-22). Frontend NOT started — pick up later.
**Owner of the decision already made:** surface as a **separate advisory patient-payable line** showing **P50 "typical when present" + the probability it applies** (chosen over risk-adjusted expected-value / P75). Do NOT fold it into any total.

## Context — what the backend now returns

Tab-2 NME Phase-1 is built and live on the engine `dev` branch (`feat/nme-phase1` → `dev`, commit `3e89141`). The estimate response now carries an **advisory** `expected_nme` object, driven by historical HIMS NME cohort profiles (`fc.nme_profile`, built by `scripts/backfill-nme.js` from `Estimate-Variance-Report`'s `HIMS NME Amount`).

Two places on the estimate response:
- `estimate.expected_nme` — for the **open-bill** route.
- `packageOffer.expected_nme` — for the **package** route (much lower — packages bundle most NME).

Present **only for non-Cash** estimates (Cash → the field is absent; guide §7 keeps Cash out of the insurance NME model).

### Shape (from `src/modules/insurance/nmeProfile.js`)
```jsonc
{
  "expected_nme": 12156.48,      // P50 — typical NME WHEN it occurs (the headline number)
  "positive_prob": 0.8571,       // share of comparable cases that incur ANY NME
  "p50": 12156.48,
  "p75": 16356,                  // conservative buffer, if you want a range
  "p80": 16436.38,
  "cohort_level": 1,             // 1 = exact (payer+package+dept+LOS+ICU), 2 = dept, 3 = payer+package global
  "sample": 35,                  // cohort admissions behind the number
  "blended": false,              // true = 15–29 sample, treat as soft
  "basis": "HIMS NME history · Non-GIPSA Insurance · Open Bill · ORTHOPAEDICS · LOS 3-5 · ICU 1-2 (n=35)"
}
```

## What to build (frontend)

1. In the estimate view, under the insurance/patient-payable section, add a distinct **"Expected non-medical (NME)"** line — clearly labelled as **advisory / not part of the settled bill**.
   - Headline: `~₹{expected_nme}` (round to nearest ₹100 for display).
   - Sub-label: `seen in {round(positive_prob*100)}% of comparable cases`.
   - Tooltip/expander: show `basis` + `sample`; if `blended` is true, add a "small sample — indicative" caption.
2. Package vs open-bill: when a package offer is shown, use `packageOffer.expected_nme`; otherwise `estimate.expected_nme`. If the field is absent (Cash, or no cohort), render nothing.
3. Never add `expected_nme` into any displayed total (bill total, patient total, insurer share). It sits on its own, visually separated, with the "advisory" framing.
4. Optional (nice-to-have): show the P75 as a "could be up to ₹{p75}" range hint.

## Which frontend?
The estimate builder that consumes the fc-estimate engine response. Confirm whether that's the Hospital_OS `EstimateBuilder` (being wired to the engine) or the engine's own frontend — the field lives on the engine's estimate JSON either way.

## Open backend follow-ups (not blocking the frontend)
- **International Open-Bill L3** is a 2-sample ₹150k outlier (positive_prob only 0.6%, so rarely triggers) — winsorize/quarantine extremes at treatment/payer level before trusting tiny-sample high percentiles.
- **Phase-2** (tariff completeness, open-bill NME reconstruction) needs the companion exports the manager flagged: clean admission spine, open-bill service lines, pharmacy issue/return/net lines. The FC folder alone only unblocks admission-level NME.
- Report the **present-IP overlap (16,389 / 16,399)** back to the manager — it resolves his pre-ingest "lots of unpresent IPs" review concern.

## Reference
- Engine: `~/Downloads/handoof/backend-node` — `migrations/003_nme_source_and_profile.sql`, `scripts/backfill-nme.js`, `src/modules/insurance/nmeProfile.js`, `src/modules/engine/buildEstimate.js` (fields at the two settlement points).
- Manager inputs: `~/Downloads/handoof/knowledge_inputs/i23.md`, `~/Downloads/FC_Data_Developer_Ingestion_Guide.md`.
- Chronicle entry: `~/Downloads/handoof/backend-node/docs/chronicle.md` (2026-07-22).
