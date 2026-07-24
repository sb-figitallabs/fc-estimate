# Combo reduction + multi-package LOS — historical validation

**Date:** 2026-07-24
**Scope:** READ-ONLY validation of two manager rulings against the hospital's own
package-bill history in `fc.package_bill_admissions` / `fc.package_bill_lines`
(the loaded `pkg_detl` + bill-line snapshots, 17,002 admissions; 4,969 package
bills). No code or data was changed.

**Data source of truth for combos:** a multi-package admission is stored with a
**comma-separated `package_name`** (e.g. `"CABG,MITRAL VALVE (MVR) ... 50% Discount"`).
`billedActualsForPackage()` already excludes `package_name LIKE '%,%'` precisely
because these are combo bills. There are **613 combo admissions** (all
`open_bill_or_pkg_bill = 'Package Bill'`): 566 two-fragment, 44 three-fragment,
3 four-fragment.

---

## 1. Combo reduction — does history support "whole procedure reduced + PF at same %"?

### 1a. The reduction is real, explicit, and exactly 50% / 25% of the *procedure* line

The discount is not inferred — the hospital **writes it into the line and the
package name**: a procedure billed at half carries the literal suffix
`"...50% Discount"` (or `"...25% Discount"`).

| Metric | Count |
|---|---|
| Combo admissions | 613 |
| carrying `50% Discount` | 354 |
| carrying `25% Discount` | 23 |
| carrying any other % | 0 |

Line-level proof (the discounted line is **exactly 0.500×** the full sibling
procedure):

- `IPGB2526002165` "TKR-LEFT, TKR-RIGHT50% Discount": LEFT `319,600` (full) +
  RIGHT `159,800` = **0.500×**. (The *bilateral robo* line `230,000` is billed **full**, not halved.)
- `IPGB2526003841` "CABG, MVR REPLACEMENT50% Discount": CABG `284,130` (full) +
  MVR `142,065` = **0.500×**.
- Aggregate over same-procedure bilateral pairs where both the full and the
  `Discount` line are present: `ratio_p25 = ratio_p50 = ratio_p75 = 0.500`.

**Verdict on "entire procedure reduced":** ✅ **Confirmed.** The *whole procedure
price line* is reduced by the factor, not just a PF sub-component. For a
**package** procedure that price line is all-inclusive (it bundles the surgeon
PF), so halving the line halves the embedded PF automatically — which is exactly
the manager's "reduce the procedure, and PF goes with it at the same %."

### 1b. …but *separately-billed* PF lines are NOT reduced

Where PF is billed as its own line (anaesthesia, assistant surgeon, consultant
visits — not embedded in the package price), history does **not** discount it:

| Discounted combos (n=354) | value |
|---|---|
| with a separate ANAESTHESIOLOGY PF line | 240 |
| total anaesthesia PF lines | 416 |
| **discounted** anaesthesia PF lines | **0** |

So the manager's "…then on top of it the PF is calculated with the same
percentages" is **only half-true**: PF *embedded in a package price* rides the
discount; **separately-billed PF (anaesthesia/assistant) stays at full price.**

### 1c. Cash-exemption is correct; insurance reduces

| Payer (tariff) | Combos | With 50/25% discount | % discounted |
|---|---|---|---|
| Non-GIPSA (TR≠1,290) | 261 | 234 | **89.7%** |
| GIPSA (TR290) | 126 | 107 | **84.9%** |
| Cash (TR1) | 226 | 13 | **5.8%** |

**Verdict:** ✅ The engine's rule (`reduce = GIPSA || (Non-GIPSA && sitting==same)`,
**Cash never reduces**) matches history. Cash combos are billed at full for both
procedures ~94% of the time; insurance combos are discounted ~85–90%.

### 1d. The engine's structural error: it factors the WHOLE gross, not just the fee

The reducible fee (`pkg_amount`, the procedure/package-price component) is only
**~60% of gross** — the rest is implants, pharmacy, room, consumables and
investigations, which history bills at **full for each procedure** (a bilateral
uses two physical implant sets; both billed full — see the robo line above):

```
pkg_amount / pkg_gross_amount  (median):  combo 0.606,  single 0.635
```

`flow2.service.js` (~line 188) multiplies each path's **whole cohort gross P50**
(`numbers.gross.approximate_bill.p50`, which already includes implants/pharmacy/
room) by `[1, 0.5, 0.25]`. Real multipliers tell the story — bilateral TKR,
combo gross vs single-TKR gross by payer:

| Payer | n | discounted | single P50 | combo P50 | real multiplier |
|---|---|---|---|---|---|
| Non-GIPSA | 119 | 115 | 399,853 | 710,807 | **1.78×** |
| Cash | 9 | 8 | 280,752 | 679,474 | 2.42× |
| GIPSA | 3 | 0 | 365,794 | 566,544 | 1.55× (n=3, weak) |

The engine's `reduce=true` produces `1 + 0.5 = 1.50×`. History for the
*discounted insurance* case is **1.78×** — the engine **under-quotes by ~16%**,
because it wrongly discounts the second procedure's full-priced implants/pharmacy.
The error is worst when the two procedures are **comparable in value** (bilateral,
CABG+MVR) and mild when one dominates (CAG+PTCA: engine ≈ 363k vs actual 330k,
because CAG is tiny). The old `unadjusted_reference` (2.0×) is actually *closer*
to the real bilateral bill than the reduced figure.

### Recommendation — Q1

1. **Keep** the payer/sitting gating (`Cash` never, `GIPSA` always,
   `Non-GIPSA` same-sitting) — validated.
2. **Change** the reduction to apply the factor to the **procedure-fee
   component only**, not the whole gross P50. The manager's "(base×factor) +
   (embedded-PF×factor)" is right *for the fee*; the implants/pharmacy/room of
   the secondary procedure must stay at full.

---

## 2. Multi-package LOS — same-sitting = sum or max?

### 2a. Governed package LOS availability
`fc.package_bill_admissions.pkg_defined_ward_stay / pkg_defined_icu_stay` are
**100% NULL** (0 / 17,002). Actual stay is available for all rows
(`patient_ward_stay`, `patient_icu_stay`; total LOS = ward + icu). Governed
per-package LOS exists only in `fc.package_master` (**220 / 1,149 codes**, the
GIPSA workbook subset).

### 2b. Every historical combo is SAME-SITTING; different-sitting is absent

Distinct operative-day count (OT CHARGES + anaesthesia line dates) per combo:

| distinct OT/anaesthesia days | combos |
|---|---|
| 1 | 290 |
| 2+ | **0** |

The manager's different-sitting example (**TKR day-1 → THR day-4**) does **not
exist**: `KNEE REPLACEMENT AND HIP REPLACEMENT` combos = **0 rows**. All 613
combos are single-sitting (single anaesthesia / single OT day).

### 2c. Same-sitting combo LOS ≈ MAX(individual), NOT sum

Standalone single-procedure LOS P50: **CAG 0 (daycare), PTCA 2, TKR 3–4,
THR 4, CABG 7, MVR 8.**

| Combo family | n | combo LOS P50 (p25–p75) | component singles | SUM would be | MAX would be |
|---|---|---|---|---|---|
| CAG+PTCA | 320 | 2 (2–4) | CAG 0, PTCA 2 | 2 | **2 ✓** |
| TKR bilateral | 131 | 4 (4–5) | TKR 3 each | 6 | **~3–4 ✓** |
| CABG+MVR | 1 | 9 | CABG 7, MVR 8 | 15 | **8 ✓** |
| All combos | 613 | **3** (p75 4) | single-proc median ≈ 3 | — | matches single |

The all-combo LOS median (3, p75 4) is indistinguishable from a single procedure.
A second same-sitting procedure adds roughly 0–1 day — nowhere near doubling.

**Verdict:** For **same-sitting** combos, actual LOS ≈ **MAX(individual package
LOS)**, *not* the sum. Same-sitting clubbing (sum) is **NOT** supported by
history. **Different-sitting** (sum) is **inconclusive — no such cases exist.**

### Recommendation — Q2

- If/when combo LOS is modeled (it currently is **not** — the `combined` block
  only sums grosses and explicitly notes "Shared LOS/OT overlap still not
  modeled"): **same-sitting → `MAX(pkg_defined_ward_stay)` and
  `MAX(pkg_defined_icu_stay)` across the packages, not the sum.**
- **Different-sitting → sum** may be retained as the manager's rule, but flag it
  as **hospital-assumption, not evidence-backed** (0 historical cases). Gate it
  behind `selections.sitting === 'different'`.

---

## 3. Exact code-change plan

### 3.1 `flow2.service.js` — combo reduction (the real fix)

Current (`evaluateFlow2`, combined block ~L181–203):

```js
const p50s = paths.map((p) => p.numbers.gross.approximate_bill.p50);
const unadjusted = p50s.reduce((t, v) => t + v, 0);
...
const FACTORS = [1, 0.5, 0.25];
const adjusted = reduce
  ? [...p50s].sort((a, b) => b - a).reduce((t, v, i) => t + v * (FACTORS[i] ?? 0.25), 0)
  : unadjusted;
```

**Change:** factor only the **procedure-fee** portion of each secondary path;
keep its non-fee extras (implants/pharmacy/room) at full. Split each path's P50:

- **Package paths** — fee is known: `path.numbers.package.package_amount`
  (already surfaced). `extras = grossP50 − packageAmount`.
- **Non-package paths** — no separable fee; use the measured **fee share ≈ 0.60**
  as a proxy: `fee = grossP50 * 0.60`, `extras = grossP50 * 0.40`.

```js
// per path: { fee, extras, gross }
const parts = paths.map((p) => {
  const gross = p.numbers.gross.approximate_bill.p50;
  const pkgAmt = p.numbers?.package?.package_amount;
  const fee = pkgAmt != null && pkgAmt > 0 && pkgAmt <= gross ? pkgAmt : gross * 0.60;
  return { gross, fee, extras: gross - fee };
});
// highest procedure keeps fee 100%; secondaries get fee×factor; extras always full
const ordered = [...parts].sort((a, b) => b.fee - a.fee);
const FACTORS = [1, 0.5, 0.25];
const adjusted = reduce
  ? ordered.reduce((t, part, i) => t + part.fee * (FACTORS[i] ?? 0.25) + part.extras, 0)
  : unadjusted;
```

This yields ~1.8× for a discounted bilateral (matches the 1.78× history) instead
of 1.50×. Keep `unadjusted_reference`. Update the `note` to say the factor
applies to the **procedure fee only**; implants/pharmacy/room are not reduced.
(Optional: expose separately-billed anaesthesia PF as never-reduced — but the
cohort gross already bundles it, so no separate handling is needed here.)

**Caveat to flag for the manager before implementing:** this changes the headline
for every reducing combo. Combos are 3.6% of volume (613/17,002) and *all*
same-sitting; the fee-share proxy (0.60) is a hospital-wide median, so
non-package combos will be approximate. Recommend confirming the 0.60 share and
the "extras never reduced" principle with the hospital before shipping.

### 3.2 `packages.service.js` — combo LOS (only if combo LOS gets modeled)

`withPackageLos()` (L235–248) attaches per-package `pkg_defined_ward_stay /
pkg_defined_icu_stay` for the single-package T10 ledger. There is **no combo-LOS
function today**. If one is added, for a same-sitting package set it must take:

```js
combo_ward_los = Math.max(...pkgs.map(p => p.pkg_defined_ward_stay ?? 0));
combo_icu_los  = Math.max(...pkgs.map(p => p.pkg_defined_icu_stay  ?? 0));
// different-sitting (manager rule, no historical evidence): sum instead of max
```

Do **not** sum for same-sitting. (Data availability caveat:
`pkg_defined_*` is populated for only 220/1,149 master codes, so a MAX-of-defined
model will often fall back to the cohort actual-LOS ledger regardless.)

### 3.3 If validation is considered too thin → safe interim

Combo LOS: the engine does not compute it today, so **no regression risk** —
just do not "fix" it toward sum. Combo pricing: if the manager prefers not to
change the headline now, the **honest interim is to surface `unadjusted_reference`
as the primary** for comparable-value combos (it is closer to reality: 2.0× vs
the reduced 1.5× for bilaterals), OR ship 3.1. Either way, the current
whole-gross `×0.5` under-quotes and should not be presented as the confident
number for same-value multi-procedure combos.

---

## 4. Reproducibility — SQL + row counts

All queries run read-only against `DATABASE_URL` (schema `fc`). Scripts:
`scripts/tmp-explore-0{1,2,3}.js`, `scripts/tmp-analyze-{combo,2,3,4}.js`
(temporary; safe to delete).

- **Combo count / split:** `SELECT open_bill_or_pkg_bill, count(*),
  count(*) FILTER (WHERE package_name LIKE '%,%') FROM fc.package_bill_admissions
  GROUP BY 1;` → Package Bill 4,969 (613 comma-combos); Open Bill 12,033 (0).
- **Discount presence:** `count FILTER (WHERE package_name ~* '50% ?Discount')`
  = 354; `'25% ?Discount'` = 23; of 613.
- **Discount magnitude (line):** join `package_bill_lines` `"<X>50% Discount"`
  to full `"<X>"` sibling → `disc_rate/full_rate` p25/p50/p75 = 0.500/0.500/0.500.
- **Fee share:** `percentile_cont(0.5) OVER (pkg_amount / pkg_gross_amount)` =
  0.606 (combo), 0.635 (single).
- **Payer × discount:** Non-GIPSA 234/261 (89.7%), GIPSA 107/126 (84.9%),
  Cash 13/226 (5.8%).
- **Separate PF not discounted:** among 354 discounted combos, 416 anaesthesia
  lines across 240 combos, **0** carry `Discount`.
- **Sitting:** `count(DISTINCT create_dt::date)` over OT CHARGES + anaesthesia
  lines per combo → 290 combos = 1 day, **0** combos ≥ 2 days.
- **LOS:** standalone P50 CAG 0 / PTCA 2 / TKR 3–4 / THR 4 / CABG 7 / MVR 8;
  CAG+PTCA combo (n=320) P50 2; TKR bilateral (n=131) P50 4; CABG+MVR (n=1) 9;
  all combos (n=613) P50 3, p75 4, max 22.
- **Bilateral TKR multiplier:** Non-GIPSA 710,807/399,853 = 1.78× (n=119);
  Cash 2.42× (n=9); GIPSA 1.55× (n=3).
- **TKR+THR staggered combos:** `package_name ~* 'KNEE' AND ~* 'HIP'` = **0 rows.**
