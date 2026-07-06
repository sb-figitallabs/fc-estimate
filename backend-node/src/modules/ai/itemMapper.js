import { geminiJson } from './gemini.js';
import { query } from '../../db/pool.js';

/**
 * AI step 2: fuzzy-map requested service/pharmacy item descriptions to
 * canonical_item_key candidates. DB search proposes, Gemini ranks/decides,
 * result always carries the DB-grounded candidates (AI never invents keys).
 */
export async function mapItems(requests) {
  const results = [];
  for (const req of requests) {
    // word-wise AND match so "knee xray bedside" hits "X-RAY KNEE ... (BEDSIDE)"
    const words = req.description.trim().split(/\s+/).filter(Boolean);
    const conds = words.map((_, i) => `(item_name ILIKE $${i + 1} OR item_code ILIKE $${i + 1})`).join(' AND ');
    const params = words.map((w) => `%${w.replace(/x-?ray/i, 'RAY')}%`);
    const kind = req.kind === 'pharmacy' ? 'pharmacy' : 'service';
    const { rows: candidates } = kind === 'pharmacy'
      ? await query(
        `SELECT canonical_item_key, item_code, item_name, classification, fc_estimate_bucket, grouping
         FROM fc.pharmacy_item_mapping WHERE ${conds} LIMIT 12`, params)
      : await query(
        `SELECT canonical_item_key, item_code, item_name, fc_estimate_bucket, grouping
         FROM fc.service_item_mapping WHERE ${conds} LIMIT 12`, params);

    if (!candidates.length) {
      results.push({ ...req, resolved: null, candidates: [], note: 'no DB candidates — unresolved' });
      continue;
    }
    if (candidates.length === 1) {
      results.push({ ...req, resolved: candidates[0], candidates, note: 'single DB match' });
      continue;
    }
    const pick = await geminiJson(
      `User requested ${kind} item: "${req.description}"${req.context ? ` (context: ${req.context})` : ''}.
Candidates from the hospital item master:
${candidates.map((c, i) => `${i}: [${c.item_code}] ${c.item_name} (bucket=${c.fc_estimate_bucket})`).join('\n')}
Return JSON {"best_index": <int or null if none fits>, "confidence": "high"|"medium"|"low", "reason": "..."}.`,
      { system: 'You match free-text medical item requests to hospital item-master rows. Prefer exact clinical matches; return null best_index when nothing genuinely fits.' }
    );
    const resolved = pick.best_index != null ? candidates[pick.best_index] ?? null : null;
    results.push({ ...req, resolved, candidates, ai: pick });
  }
  return results;
}
