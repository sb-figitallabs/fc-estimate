# FC Estimate Builder — decisions needed to proceed (15-Jul)

Context: the auto-verification harness from today's flow document is live. It
built **207 estimates with zero manual input** (all 170 families on Cash +
GIPSA wherever the family has 15+ GIPSA cases) and compared every gross total
and every bucket against the historic P25–P75 bands. Result: 25 estimates sit
fully inside their bands, 182 have at least one component outside. The good
news: the 182 collapse into a handful of systematic causes, each needing one
decision from you. Full run output is in `verification-report-15jul.md`.

---

## 1. Professional Fees on insurer tariffs — the biggest single error

**What happens today:** on every GIPSA/insurer estimate, Professional Fees is
priced from the insurer tariff's consultation rate, which is a token entry.

**Example — TKR Unilateral, GIPSA:** our estimate prices Professional Fees at
**₹745**. Actual GIPSA TKR bills carry PF of **₹48,641–₹60,456** (P25–P75).
The same pattern repeats on 34 of the 182 flagged builds: THR shows ₹770 vs
₹50k–₹72k, Lap Cholecystectomy ₹790 vs ₹30k–₹47k, LSCS ₹740 vs ₹25k–₹34k.

**Question:** what should be the PF source on insurer tariffs?
- (a) the cohort's **historic PF P50** (we already compute it — the "use
  historic PF" figure the workbench offers), or
- (b) the **cash tariff's surgeon-fee slabs** (the room-wise surgeon/anaesthetist
  amounts that exist in package details), or
- (c) a **rate sheet you have** that we should ingest.

One rule fixes all 34 rows; I'll re-run the harness to prove it.

## 2. Token ₹0/₹1 OT rows on medical admissions

**What happens today:** insurer tariffs carry ₹0/₹1 token rates for OT-type
rows on medical families, and per the earlier decision we keep token rates
as-is. So e.g. **General Medical Management (GIPSA)** shows Procedure/OT of
**₹1** while actual bills run **₹2,790–₹11,725**. 54 builds are flagged
for this.

**Question:** keep the token rates (and annotate the row as "token rate per
tariff"), or fall back to the cash (TR1) rate the way we already do for
missing service rates? The fallback is my recommendation — it's the same
rule the tariff already follows when a rate is absent, and a ₹1 rate is
absent in all but name.

## 3. Empty Investigations / Pharmacy on medical & infusion families

**Example 1 — Pediatric Medical Management (GIPSA):** our Investigations
bucket shows **₹1,250**; actual bills carry **₹9,365–₹60,600**. The itemized
template for medical families simply has no investigation lines. 31 builds.

**Example 2 — Immunotherapy (Cash):** our Pharmacy bucket is **₹0**; actual
bills carry **₹45,886–₹2,29,792** — the drug itself, i.e. the whole point of
the admission, is missing from the template. Same for Chemotherapy. 6 builds.

**Question:** OK to fill these buckets from the cohort's historical
quartiles (the same mechanism we already use for pharmacy residuals), with a
"historical estimate" annotation? The alternative is authoring explicit rate
lines per family, which is slower and needs a source.

## 4. Session-based treatments getting room charges

**Example — Hemodialysis Management (GIPSA):** our estimate lands at
**₹2,04,284** — of which **₹1,77,040 is Room Charges** from LOS × ward rate.
Actual dialysis bills run **₹22,556–₹48,506** with essentially zero room
charges: patients come per session, they don't occupy a ward for days.
Routine Newborn Care shows the same pattern (₹31k of room on a ₹9–19k
treatment).

**Question:** confirm we should suppress LOS-driven room charges for
session-recurrent / daycare-style families (dialysis, phototherapy, newborn
care), pricing them per session like the daycare families already work.

## 5. Non-Medical Expenses (NME) — what it really is today

You asked how we fetch NME. I traced it fully (`nme-derivation.md`):

- NME today = a **fixed list of 7 item names** (drug administration, medical
  records, ward consumables, dressing, diet consultation, MLC charges,
  warmer). Whatever those lines cost in the estimate becomes the NME figure.
- Classic NME items — **gloves, admission kits, disposables — are currently
  treated as insurer-payable**, which understates the patient's share.
- The record files you gave us include an **actual `nme_amount` per billed
  admission** — we ingested it, but nothing uses it yet.

**Question:** should we (a) drive NME from the historical `nme_amount`
(per family + payor quartiles, same as other buckets), (b) get a proper NME
master list from the hospital, or (c) both — master list for line-level
classification, history as the sanity band?

## 6. Robotic classification — must it run per payor group? (data says yes)

We ran the presence analysis you specified (90% rule, overall vs per payor):

| family | Cash | GIPSA | Non-GIPSA |
|---|---|---|---|
| Robotic TKR Uni R / L | 100% | 100% | 100% |
| Robotic TKR Bilateral | 95% | 95% | 95% |
| THR / Hemiarthroplasty | 39% | 42% | 37% |
| **TKR Bilateral (Conventional)** | **0%** | **61%** | **69%** |
| TKR Unilateral (Conventional) | 0% | 0% | 23% |

The robotic families and THR are consistent across payors. But the
conventional TKR cohorts diverge sharply — because the robotic families were
curated as Cash-only, **insurer robotic cases live inside the conventional
cohorts** (that's the 61%/69%). An overall-level rule would average this away
and underquote insurer robotic patients.

**Question:** confirm (a) the 90% classification runs **per payor group**,
and (b) for conventional cohorts where an insurer payor shows high robotic
presence (the 61–69% cases), the robotic add-on should default to **Include**
for that payor.

## 7. Clarifying question UX (from your flow doc)

For treatments that historically appear as both surgical & medical, or both
daycare & non-daycare, the flow doc says: ask the user, then build only from
that cohort. Planned UI: when such a family is picked, an inline prompt —
*"This procedure is seen both as Daycare (210 cases) and Inpatient (85
cases) — which is this admission?"* — with two buttons; the choice locks the
cohort.

**Question:** OK as described? And if the FC ignores the prompt, should we
default to the larger cohort (my suggestion) or block the build until they
answer?

## 8. Production deploy — go / no-go

Everything above is already live on the dev server for your review. For the
production push we planned: my recommendation is to answer **Q1 (insurer
PF)** first — it's a one-rule fix, I'll re-run the 207-build harness as
proof, and then we promote with the insurer numbers defensible. Cash-path
numbers are already in good shape (most Cash builds sit in-band; the flagged
ones are the medical-family gaps from Q2/Q3).

**Question:** deploy tonight fixing forward, or hold for the Q1 fix + harness
re-run (adds a few hours)?

---

## Reminders (things waiting on your side)

- **TPA master list** (so the TPA field stops being free text).
- **Insurance Excel mapping documentation** you mentioned this morning, so the
  agent can map/override correctly.
- Confirming the **9 Packages-Excel questions stay closed** — per your
  instruction they're replaced by the package-bill-lines verification, which
  is now what the conversion alert runs on.
