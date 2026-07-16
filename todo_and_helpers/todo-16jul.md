# 16-Jul plan — morning call (10:45) + his flow note (16-jul.pdf) + midday calls (12:37, 12:50)

Direction of the day: validate the FLOW, not the numbers. Separate the three
layers we currently mix — flow / historic values / calculation logic — so a
wrong number can be traced to the layer that produced it. His words: "even if
numbers come out wrong, keep the logic — that's how we see where the flow
broke"; broad ranges are fine. Do this on the TEST surface, not production;
prod gets minor changes only. He is also running his own AI attempt in
parallel and will stop it once we show flow confidence — speed matters.

## TODO

- [ ] **1. Update the engine's local test frontend** so he can test the recent
  rounds from his test server (the engine's own standalone UI, separate from
  the /api/fc/* surface HO consumes) — ON HOLD until user gives the go.
- [x] **2. Package-bill historic metrics at bucket level** — DONE 16-Jul:
  `fc.package_bill_bucket_metrics` (migration 002 + backfill, run live: 176
  codes, 2,434 rows; 973 admissions have bill package names not in the
  master). Extras above the package classified with the estimate's own
  bucketing (package line excluded; implants split from pharmacy via
  pharmacy_item_mapping; service mapping → group-majority fallback).
  Rides the offer as `billed_actuals.bucket_extras`; HistoricPanel gains the
  "Package bill — historic metrics" section (HO feature branch `e830313`).
  GIPSA TKR sanity: Proc/OT P50 ₹1,21,300 (robotic), Implants ₹88k.
- [x] **3. Flow 2 — interactive SOP stepper (Phase A) — DONE 16-Jul** (engine 8572ecb, HO fab4c0e; live on the engine dev stack, UI on the feature branch):
  new parallel surface, nothing in the current flow touched. Engine
  `POST /api/flow2/evaluate` (stateless; full step trail; stops at the first
  human question; selections accumulate) + HO "Flow 2" admin view.
  Steps: payor→tariff / family match (payor-aware) / characterization
  (surgical-medical, daycare, robotic — from THIS hospital's history only,
  ask only when ambiguous) / billing identification via package master
  (incl-excl demoted to review-only) / FC_Historic template via his exact
  fallback ladder (every rung visible) / per-payor template summary.
  Numbers: `mode=historic` — pure percentiles of the selected case set, no
  tariff/LOS math; case-set FILTER CHIPS (payor scope / daycare / robotic /
  care type) re-derive everything live; per-bucket cases clickable → the IP
  case list with per-case flags (his "these 15 IPs, all cash, all robotic").
- [x] **4. Flow 2 Phase B** — DONE 16-Jul eve: mode=logic|both live (per-bucket verdicts vs the 75/125 band, __gross__ row, room-type select; logic build gets the audited decisions, never free text). Also same-day: combo path-per-treatment in Flow2 (tabs, per-path questions/selections, combined P50 strip) and matcher/rank caching (7s→0.04s round-trips, no mid-conversation flips). Original ask:: `mode=logic|both` — the logic layer as a
  side-by-side comparison per bucket ("historically X–Y; logic produced Z"),
  gross validation vs both bands, optional agent self-verify loop.
- [ ] **5. PF fallback (his note ¶2)**: same room category, standard
  single-procedure case with bill near the cohort P50 → take that bill's PF.
- [ ] **6. Range consistency audit**: he saw 76–123 vs a different band
  elsewhere, "83 to 120" rendering as 160–140, and an itemized total that
  doesn't sum (₹1.4L). Reconcile after #2's data lands in the views.
- [ ] **7. Search debounce**: type-ahead resolve should wait longer before
  firing (stage-1 has 600ms; he still finds it eager — try ~1s + min chars).
- [ ] **8. Multi-treatment combos** (persists from #10/15-Jul, now part of his
  flow doc): detect single vs multiple vs pkg+non-pkg at intake, announce,
  path per treatment. Flow2 Phase A ships a cheap fragment-detection signal
  only.
- [ ] **9. His hospital visit follow-up**: he's drilling into the hospital's
  own FC module for data we may not have — expect a new dataset/doc.

## Standing directives

- Flow doc (16-jul.pdf) OVERRIDES older documentation where they contradict.
- Robotic/daycare/surgical ambiguity: answered from history, never from the
  model's world knowledge — "does THIS hospital do it robotically".
- Inclusion/exclusion text: display for review, never trust for pricing —
  drive amounts from past billing metrics.
- Every step auditable: "I checked X, found Y, used these N cases".
