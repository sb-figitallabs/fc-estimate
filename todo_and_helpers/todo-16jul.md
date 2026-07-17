# 16-Jul plan — morning call (10:45) + his flow note (16-jul.pdf) + midday calls (12:37, 12:50)

Direction of the day: validate the FLOW, not the numbers. Separate the three
layers we currently mix — flow / historic values / calculation logic — so a
wrong number can be traced to the layer that produced it. His words: "even if
numbers come out wrong, keep the logic — that's how we see where the flow
broke"; broad ranges are fine. Do this on the TEST surface, not production;
prod gets minor changes only. He is also running his own AI attempt in
parallel and will stop it once we show flow confidence — speed matters.

## TODO

- [x] **1. Update the engine's local test frontend** — DONE 16-Jul eve: public/flow2.html (self-contained Flow 2 stepper on the engine's own UI, live at fc-estimate-dev.figitallabs.com/flow2.html, browser-driven verification) + nav links on index/packages pages. Original ask: so he can test the recent
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
- [x] **5. PF fallback (his note ¶2)** — DONE 16-Jul night: roomMatchedPfFallback
  (same room via inferRoomCategory + standard single-procedure + gross within
  ±15% of cohort P50 + PF>0; median PF, null under 3 cases). Rides as
  pf_analysis.room_matched_fallback with sample IPs + criteria; recommendation
  flips only when historic basis is thin (<5) or logic deviates >25% — priced
  totals never silently change. flow2 numbers.pf_fallback (logic|both only).
  Verified: GIPSA TKR Single 248→92 cases PF P50 ₹56,584; GMM Cash 119→3 → 
  ₹12,380 (recommendation correctly stays logic).
- [x] **6. Range consistency audit** — DONE 16-Jul night (HO e5387dc; audit in
  range-audit-16jul.md): all display-side, zero engine inversions. His
  "160 to 140" = the two headline totals shown under an actuals band with no
  bracket check; "rows don't sum" = a RANGE in the preview total cell + the
  single-room table missing package/total rows. Fixed: one shared bracket
  implementation, 'system range' labels, amber past-bills divergence line
  (first surface for conversion_check), preview footer = exact sum with a
  labelled expected-range beneath, base+buckets+custom = headline verified
  to the rupee, captions naming every band.
- [x] **7. Search debounce** — DONE 16-Jul night (HO c28fa5b): 600ms → 1100ms.
  Min chars kept at 3 — "tkr" alone is a legitimate complete wording.
- [x] **8. Multi-treatment combos — detection + announcement** — DONE 16-Jul
  night: resolve-treatment gains an additive combo block (fragments each
  resolved to family + package-or-not, billing_shape); Simple flow announces
  in his language + treatment picker chips (picking builds THAT fragment) +
  'estimating treatment 1 of 2' reminder. Single-treatment responses
  byte-identical (asserted). Verified live: 'lap chole + inguinal hernia' →
  package_plus_non_package (SGA5166 + non-package) — his exact example.
  Combined PRICING (interactions) remains the later phase; Flow2 already
  paths each treatment fully.
- [ ] **9. His hospital visit follow-up**: he's drilling into the hospital's
  own FC module for data we may not have — expect a new dataset/doc.

## Standing directives

- Flow doc (16-jul.pdf) OVERRIDES older documentation where they contradict.
- Robotic/daycare/surgical ambiguity: answered from history, never from the
  model's world knowledge — "does THIS hospital do it robotically".
- Inclusion/exclusion text: display for review, never trust for pricing —
  drive amounts from past billing metrics.
- Every step auditable: "I checked X, found Y, used these N cases".
