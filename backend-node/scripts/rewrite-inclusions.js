/**
 * Bulk AI rewrite of package inclusion/exclusion texts into patient-facing
 * clean columns, following the manager-approved ruleset in
 * incl-excl-rewrite-samples.md (Sample 0 canonical style).
 *
 * Target: fc.package_master.inclusions_text_clean / exclusions_text_clean,
 * plus inclusions_clean_variants (JSONB array) for packages whose curated
 * inclusions_text concatenates >1 source variant (splitVariants — repeated
 * "Hospital Stay" blocks): each variant gets its own standalone clean text,
 * aligned by variant index, so the FC can pick a variant on the workbench
 * and the preview shows that variant's patient-friendly version.
 * (fc.package_master is the base table behind fc.v_package_runtime_lookup,
 * which is where the engine reads inclusions_text / exclusions_text from).
 * The original inclusions_text / exclusions_text are NEVER touched — they
 * remain the audit copy.
 *
 * Usage:
 *   node scripts/rewrite-inclusions.js [--limit N] [--dry-run]
 *
 * Behaviour:
 *   - Self-bootstraps the columns (ADD COLUMN IF NOT EXISTS) — this also
 *     runs in --dry-run, since the candidate SELECT references the columns.
 *   - Picks rows with source text where BOTH clean columns are still NULL,
 *     OR rows with >1 source variant whose inclusions_clean_variants is
 *     still NULL — so the job stays resumable / idempotent, and a
 *     re-dispatch after a base-columns run fills just the variants column.
 *   - One Gemini call per row for the merged clean texts, plus one call per
 *     source variant (same ruleset, no Version A/B merging — each variant
 *     cleaned standalone). Concurrency 3 rows. On any Gemini failure the
 *     affected column(s) stay NULL and are retried on the next run.
 *   - --dry-run does everything except the UPDATE, and prints each rewrite.
 */
import 'dotenv/config';
import { pool, query } from '../src/db/pool.js';
import { geminiJson } from '../src/modules/ai/gemini.js';
import { splitVariants } from '../src/modules/packages/coverage.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : null;
if (limitIdx >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('--limit expects a positive integer');
  process.exit(1);
}

const CONCURRENCY = 3;

// Manager-approved ruleset (incl-excl-rewrite-samples.md, "Notes on cleanup
// decisions" + Sample 0), encoded as the system prompt. Split into parts so
// the per-variant pass can reuse the exact ruleset WITHOUT the Version A/B
// merging rules (each variant is cleaned standalone).
const RULES_HEAD = `You rewrite hospital surgical-package inclusion/exclusion texts into clean, patient-facing English for a treatment cost estimate. Follow this exact approved ruleset.

STYLE (canonical, compact)
- Output flat bullet lists only: one "- Label: value" line per bullet. No headings, no bold, no nested sub-bullets, no numbering.
- Combine IP and OT pharmacy into ONE line: "Pharmacy: IP medicines up to ₹15,000 + OT medicines up to ₹50,000". A single pharmacy cap becomes "Pharmacy: Up to ₹23,000".
- Caps are phrased "Up to ₹X". Write every rupee figure with the ₹ symbol and Indian comma grouping (e.g. ₹7,260).
- Room-wise figures use compact notation "₹7,260 (Twin) / ₹7,920 (Single)" (room labels like General Ward / Twin / Single / Deluxe / Suite in Title Case). When the amount is identical across all listed room types, collapse to the single number.
- Group the comma-run of OT/ward service items into thematic lines, using these labels where applicable: "OT & Procedure Charges", "Routine Consumables & Nursing", "Catheter Care", "Pre-operative Care", "Medical Records", "Monitoring", "Consultations". A procedure row (e.g. a robotic surgery item) becomes its own labeled line such as "Robotic Surgery: Unilateral Robotic TKR".
- Consultations all at count 1 read "Consultations (1 each): Physician, Endocrinology, Nephrology, Cardiology, Pulmonology". A lone consultation reads "Consultations: Diet consultation".
- Omit trivial "×1" counts; KEEP meaningful quantities: days, hours, session counts, "1 each" — e.g. "syringe pump (3 days)", "monitor (2 days)", "dressing (minor ×2)", "oxygen (2 hours)", "CTG monitor (half day)", "blood sugar checks (GRBS, 6)".
- OMIT cryptic internal codes (e.g. "OP-10") from the clean text entirely — they stay only in the original audit column.
- Clean OCR junk: stray "0 - 0," fragments, trailing commas and pipes, doubled separators.
- Fix obvious misspellings ("PHYCISIAN" -> Physician, "FOLEYS" -> Foley's) and use natural sentence casing, not ALL CAPS.
- "Assistants Surgeon & Anaesthesia: As per the policy" becomes "Assistant Surgeon & Anaesthesia: As per hospital policy". "DMO - 3" in inclusions becomes "Duty Medical Officer (DMO): 3 visits". "Investigations | NIL" becomes "Investigations: None included". "0 day-ICU" renders as "(no ICU)".

FIDELITY (hard rules)
- Every substantive item and EVERY rupee figure in the source MUST appear in the output. Nothing substantive dropped, nothing invented. Do not add coverage, items, figures or caveats that are not in the source.`;

const RULES_CONFLICT = `DUPLICATED / CONFLICTING BLOCKS
- If the stored text contains two duplicated blocks whose figures or counts CONFLICT (two tariff versions pasted together), do NOT silently pick one. Prepend this exact first line: "DATA FLAG: conflicting stored versions — needs reconciliation". Then keep both versions: either (a) two full lists labeled "Version A (current):" and "Version B (older stored block, retained for audit):" when the blocks differ broadly, or (b) one merged list where only the conflicting lines carry an inline note like "(a second stored version says ₹8,000 for both room types — under reconciliation)" when the blocks differ in only a few figures.
- Duplicated blocks that are identical in substance: merge silently into one list, no flag.`;

const RULES_TAIL = `EXCLUSIONS
- Rewrite each exclusion as a natural patient-facing bullet, e.g. "Cross-specialty consultations", "HIV, HBsAg & HCV disposable kit", "Attender food & beverages and additional patient orders", "Any medications or investigations not related to the procedure", "Diabetic management", "Special equipment charges", "Any stay, services, investigations, or consumables beyond the package duration (charged as per actuals)". If two stored exclusion lists exist, combine them and merge duplicates (conflict flag rules above still apply if they contradict).

OUTPUT
Return strict JSON only: {"inclusions_clean": string|null, "exclusions_clean": string|null}. Each string is the bullet list, lines separated by \\n, every line starting with "- " (except an initial DATA FLAG line, which has no bullet). Return null for a side whose source text is empty. No markdown fences, no commentary.`;

// Merged pass: full ruleset incl. the Version A/B conflict handling.
const SYSTEM = `${RULES_HEAD}\n\n${RULES_CONFLICT}\n\n${RULES_TAIL}`;
// Per-variant pass: same ruleset WITHOUT the conflict/merging section — the
// input is a single already-split source variant, cleaned standalone.
const SYSTEM_VARIANT = `${RULES_HEAD}\n\n${RULES_TAIL}`;

function buildPrompt(row) {
  return `Package: ${row.package_name} (tariff ${row.tariff_code}, code ${row.package_code})

STORED INCLUSIONS TEXT:
${row.inclusions_text?.trim() || '(none stored)'}

STORED EXCLUSIONS TEXT:
${row.exclusions_text?.trim() || '(none stored)'}

Rewrite per the ruleset and return the JSON.`;
}

function buildVariantPrompt(row, variantText, idx, total) {
  return `Package: ${row.package_name} (tariff ${row.tariff_code}, code ${row.package_code}) — source variant ${idx + 1} of ${total}, to be cleaned standalone

STORED INCLUSIONS TEXT:
${variantText?.trim() || '(none stored)'}

STORED EXCLUSIONS TEXT:
(none stored)

Rewrite per the ruleset and return the JSON.`;
}

async function main() {
  console.log(`rewrite-inclusions: target fc.package_master${dryRun ? ' [DRY RUN — no writes]' : ''}${limit ? ` [limit ${limit}]` : ''}`);

  // Schema bootstrap (idempotent; needed even for the dry-run SELECT below).
  await query(`ALTER TABLE fc.package_master
    ADD COLUMN IF NOT EXISTS inclusions_text_clean TEXT,
    ADD COLUMN IF NOT EXISTS exclusions_text_clean TEXT,
    ADD COLUMN IF NOT EXISTS inclusions_clean_variants JSONB`);

  // Candidate rows: base clean columns still pending, OR multi-variant rows
  // (two 'Hospital Stay' blocks == splitVariants > 1) whose per-variant clean
  // array is still pending — so a re-dispatch after the base run fills just
  // the new column without re-doing finished work.
  const { rows } = await query(
    `SELECT tariff_code, package_code, package_name, inclusions_text, exclusions_text,
            inclusions_text_clean, exclusions_text_clean, inclusions_clean_variants
     FROM fc.package_master
     WHERE ((coalesce(inclusions_text, '') <> '' OR coalesce(exclusions_text, '') <> '')
            AND inclusions_text_clean IS NULL AND exclusions_text_clean IS NULL)
        OR (inclusions_text LIKE '%Hospital Stay%Hospital Stay%'
            AND inclusions_clean_variants IS NULL)
     ORDER BY tariff_code, package_code
     ${limit ? `LIMIT ${limit}` : ''}`);

  console.log(`${rows.length} package(s) pending rewrite`);
  if (!rows.length) return;

  let done = 0; let ok = 0; let failed = 0;

  async function processRow(row) {
    const id = `${row.tariff_code}/${row.package_code}`;
    // Which parts does this row still need? (A re-dispatched run can pick up
    // a row for just one of the two — each part writes independently, so a
    // failure in one leaves the other's progress intact.)
    const needBase = row.inclusions_text_clean == null && row.exclusions_text_clean == null
      && ((row.inclusions_text?.trim() || '') !== '' || (row.exclusions_text?.trim() || '') !== '');
    const variants = splitVariants(row.inclusions_text);
    const needVariants = variants.length > 1 && row.inclusions_clean_variants == null;
    let rowOk = true;

    if (needBase) {
      try {
        const out = await geminiJson(buildPrompt(row), { system: SYSTEM });
        const inc = typeof out?.inclusions_clean === 'string' ? out.inclusions_clean.trim() : null;
        const exc = typeof out?.exclusions_clean === 'string' ? out.exclusions_clean.trim() : null;
        // A side that had source text must come back non-empty, else skip the
        // part (stays NULL -> picked up again on the next run).
        if (row.inclusions_text?.trim() && !inc) throw new Error('model returned empty inclusions_clean for non-empty source');
        if (row.exclusions_text?.trim() && !exc) throw new Error('model returned empty exclusions_clean for non-empty source');
        if (dryRun) {
          console.log(`\n--- ${id} — ${row.package_name} ---\n[inclusions_clean]\n${inc ?? '(null)'}\n[exclusions_clean]\n${exc ?? '(null)'}`);
        } else {
          await query(
            `UPDATE fc.package_master
             SET inclusions_text_clean = $3, exclusions_text_clean = $4
             WHERE tariff_code = $1 AND package_code = $2`,
            [row.tariff_code, row.package_code, inc, exc]);
        }
      } catch (err) {
        rowOk = false;
        console.error(`skip ${id} [base]: ${err.message}`);
      }
    }

    if (needVariants) {
      try {
        // One standalone call per source variant; the column is only written
        // when EVERY variant succeeds, so the stored array is always fully
        // aligned by variant index (partial failure -> stays NULL -> retried).
        const cleans = [];
        for (let vi = 0; vi < variants.length; vi += 1) {
          const out = await geminiJson(buildVariantPrompt(row, variants[vi], vi, variants.length), { system: SYSTEM_VARIANT });
          const inc = typeof out?.inclusions_clean === 'string' ? out.inclusions_clean.trim() : null;
          if (!inc) throw new Error(`model returned empty inclusions_clean for variant ${vi + 1}/${variants.length}`);
          cleans.push(inc);
        }
        if (dryRun) {
          console.log(`\n--- ${id} — ${row.package_name} [${variants.length} variants] ---`);
          cleans.forEach((c, vi) => console.log(`[inclusions_clean_variants[${vi}]]\n${c}`));
        } else {
          await query(
            `UPDATE fc.package_master
             SET inclusions_clean_variants = $3::jsonb
             WHERE tariff_code = $1 AND package_code = $2`,
            [row.tariff_code, row.package_code, JSON.stringify(cleans)]);
        }
      } catch (err) {
        rowOk = false;
        console.error(`skip ${id} [variants]: ${err.message}`);
      }
    }

    if (rowOk) ok += 1; else failed += 1;
    done += 1;
    if (done % 10 === 0 || done === rows.length) {
      console.log(`progress: ${done}/${rows.length} (ok=${ok}, skipped=${failed})`);
    }
  }

  // Simple worker pool, concurrency CONCURRENCY.
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next];
      next += 1;
      await processRow(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  console.log(`\ndone: ${ok} rewritten, ${failed} skipped (left NULL — re-run to retry), of ${rows.length} pending${dryRun ? ' [DRY RUN — nothing written]' : ''}`);
}

main()
  .catch((err) => { console.error('fatal:', err); process.exitCode = 1; })
  .finally(() => pool.end());
