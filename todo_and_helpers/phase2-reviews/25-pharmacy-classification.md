# Review — Pharmacy items classification accuracy

**Input reviewed:** `newinps_updated2.docx` → "Pharmacy Items Classification Accuracy" tab (item-level audit of drug / consumable / implant buckets + implant type/brand).
**What this tab decides:** whether our pharmacy item bucketing is correct. Verdict: broadly good, but the **production implant flag has a SQL defect** and implant type/brand isn't reliable yet.

## 1. ✅ Safe / broadly correct
- All 11,254 canonical items audited; **8,981 high-confidence**; only **551 review** (0.036% of 1.44M historical observations). Detailed FC mapping keeps the same bucket for **94.55%** (8,006/8,468).
- Sensible item calls to adopt: K-wires/fixation wires → implants; bone wax & SURGICEL → hemostatic consumables; PosiFlush/Polyflush → flushing consumables (not drugs); catheters/guidewires/balloons/sheaths → consumables unless the billed code includes the implant; VenaSeal adhesive → implant, its delivery accessories → consumables.

## 2. ⚠️ Could worsen currently-verified logic
- **The production implant flag is defective** — its whole-word `DRUG` test excludes `NON DRUG` while allowing plural `DRUGS`, so **none of the 54 NON-DRUG/IMPLANTS rows are flagged as implants, 1,436 high-confidence implants are missed, and some drugs get marked implants.** → **the existing flag must NOT drive FC implant selection.** If our pharmacy-implant bucket inherits this flag, implants are mis-bucketed (and the double-count guard on implants would then miss real implants). ⚠️ engine-check needed (below).
- **Implant type/brand is not reliable** — the classifier was built around TKR and reused everywhere: 89.3% of covered implants labelled "Other/Accessory Hardware/conflicting"; brand coverage 17.3%. Don't let it drive brand selection or brand-median pricing.

## 3. ⛔ Blocked / new work (N10)
- Apply the corrections (166 primary-class changes incl. 49 implant→consumable, 47 consumable→implant, 15 drug→implant; + 2,786 unmapped resolved: 1,602 drugs / 883 consumables / 46 implants / 255 review).
- Split into separate fields: **primary class · subtype · implant component type · manufacturer · product brand · model · size · laterality** (one flat class is insufficient). Store MRP / sale rate / observed rates separately. Auto-selectors contain only high-confidence items; the 551 review items stay quarantined (need an implant/vendor master, not more text matching).

## 4. Validation — to run
Check whether our FC Builder's **implant bucket / implant double-count guard inherits the defective production implant flag** (if so, implants are mis-bucketed → the "exclude implant family before adding the selected implant" guard misfires). Confirm our pharmacy buckets come from the corrected classification, not the flag.
