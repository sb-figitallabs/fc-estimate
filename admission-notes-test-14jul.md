# Admission-notes intake test — 14 Jul

20 real KIMS Gachibowli admission-request photos (`~/Downloads/Admission Notes/`)
run end-to-end against dev: **photo → AI intake extraction → package-gate
classification** (`/api/estimate/intake` → `/api/lookup/package-gate`).
Raw per-note JSON: `results.json` alongside the photos' converted copies.

## Headline numbers

| Stage | Result |
|---|---|
| Procedure text extracted from photo | **19 / 20** (95%) |
| Payor read from note | 19/20 (17 Insurance, 2 Cash — matches the tick-boxes) |
| Procedure family resolved | **17 / 19** correct or defensible (89%) |
| Package-gate route (Cash basis) | 7 exact_package · 12 package_with_review |
| Top package candidate clinically right | **11 / 19** (58%) — the weak spot |

## What worked

- **The manager's own scenario appears in the real notes** — IMG_6809/6810 say
  literally "URSL + DJ Stenting" → gate resolves **[URO5011] URSL AND DJ
  STENTING - PA ₹58,000, exact_package** with 16 billed TR1 cases. The exact
  case he demoed as broken now classifies correctly from a photo.
- LSCS ×3 → LSCS (CAESAREAN SECTION) exact_package; B/L RA TKR → TKR
  BILATERAL exact_package + Robotic TKR Bilateral family; Lap. Appendectomy
  (the one Cash note) → LAP. APPENDECTOMY - PA exact_package end-to-end.
- Spine note (Posterior decompression & discectomy…) → Spine Surgery
  (Decompression/Fusion) family + SPINE FIXATION package — the family the
  manager flagged as unmatchable earlier now hits.
- **Payor honesty**: 17 notes tick "Insurance" but never name the insurer —
  the gate correctly returns `blocked_no_tariff` ("needs organization")
  instead of guessing. Where the note DID name one ("Bajaj", IMG_6799), the
  name→org mapping resolved (ORG57) and the gate ran on the right tariff.

## What broke (ranked)

1. **Alias scoring picks bad packages on abbreviations/misspellings** —
   the word-overlap scorer has no clinical sense:
   - "Emergency lap **appendicectomy**" → LAP. MYOMECTOMY (the British
     spelling misses the APPENDECTOMY alias; "LAP" matched anything).
   - "LAP TEP / Robotic TAPP" (hernia) → LAP. MYOMECTOMY. TEP/TAPP aliases
     don't exist.
   - "B/L TRR" (TKR misread/shorthand) → TURBT (letter soup).
   Family resolution was right in all three — only the package candidate was
   wrong. **Fix: rank alias candidates with the AI (resolvePackageText
   already does this — the gate currently takes raw aliasCandidates[0]), and
   enrich package_alias with common abbreviations/spellings.**
2. **Medical-management admissions shouldn't package-match at all** —
   "Medical Management for TBI" pulled CAROTID ENDARTERECTOMY as a candidate.
   The gate should skip the package chain when the family is medical
   (family_kind === 'medical') and the wording says management, not surgery.
3. **One extraction miss** (IMG_6795): legible note, Neuro Surgery, surgery
   field is a scrawled "CVD/CVJ" — intake returned nothing. It should return
   the raw text with low confidence instead of empty.
4. Hys. D&C notes match LAVH packages (plausible but not the procedure) —
   same root cause as #1.

## What this says about the flow (manager's framing)

- Step 1 of his ask — *"whatever the user enters, we reach a proper point
  knowing what we have and what's missing"* — **works**: every note lands on
  an audited chain with explicit statuses, and nothing silently guesses.
- The remaining accuracy gap is concentrated in ONE spot: **package-candidate
  ranking**, not extraction, not family matching, not routing. AI-ranking the
  alias candidates (already built in resolvePackageText) + an alias
  enrichment pass would fix 5–6 of the 8 misses in this set.

## Recommended next actions — ALL DONE (14-Jul evening)

1. ~~Gate: AI-rank candidates; skip package chain for medical wording~~ ✅
   The gate now AI-ranks multi-candidate alias hits (and treats them as NO
   package when none genuinely fits clinically), and medical-management
   wording skips the package chain entirely.
2. ~~Data: alias enrichment batch~~ ✅ `scripts/enrich-package-aliases.js`
   ran on dev: **272 curated variants** (appendicectomy, TEP/TAPP, B/L TKR,
   HYS D&C, caesarean spellings…) + **153 billed-name backfills** →
   fc.package_alias now 5,466 rows (tagged `Curated Enrichment 14-Jul` /
   `Billed-name backfill 14-Jul` for review or rollback).
3. ~~Intake: never return empty~~ ✅ Prompt now demands a best-effort
   transcription (uncertain readings marked "(?)"). AND the real root cause
   of the IMG_6795 miss surfaced: the engine's **2MB JSON limit silently
   413'd the one 2.4MB photo** — raised to 20MB (matches the HO proxy).

## Re-test after fixes (same failing inputs)

| Input | Before | After |
|---|---|---|
| Emergency lap appendicectomy | LAP. MYOMECTOMY ✗ | **LAP. APPENDECTOMY - PA, exact_package** ✓ |
| LAP TEP / Robotic TAPP | LAP. MYOMECTOMY ✗ | **LAP. INGUINAL HERNIA - UNILATERAL - PA** ✓ |
| B/L TRR | TURBT ✗ | AI rejects the noise → **non_package_cohort** (honest) ✓ |
| Medical Management for TBI | CAROTID ENDARTERECTOMY ✗ | **package chain skipped** — cohort flow ✓ |
| Hys. D&C. | LAVH ~ | **HYSTEROSCOPY AND D & C - PA, exact_package** ✓ |
| IMG_6795 photo | empty extraction ✗ | "GUD." + Neuro Surgery + Cash extracted (413 fixed) ✓ |
| URSL + DJ stenting (regression) | URO5011 ✓ | URO5011 exact_package — unchanged ✓ |
| dj stenting (regression) | URO5443 with-review ✓ | unchanged ✓ |
