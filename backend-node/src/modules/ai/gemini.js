import { GoogleGenAI } from '@google/genai';

// Prefer Vertex AI (service-account auth, same setup as Hospital_OS backend);
// fall back to API-key mode when VERTEX_AI_PROJECT is not configured.
const ai = process.env.VERTEX_AI_PROJECT
  ? new GoogleGenAI({
    vertexai: true,
    project: process.env.VERTEX_AI_PROJECT,
    location: process.env.VERTEX_AI_LOCATION || 'global',
  })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

/** Call Gemini and parse a JSON response. temperature 0: matching must be
 * deterministic — the same intake wording has to resolve to the same
 * family/package on every run (15-Jul call, todo #22). */
export async function geminiJson(prompt, { system } = {}) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      ...(system ? { systemInstruction: system } : {}),
      responseMimeType: 'application/json',
      temperature: 0,
    },
  });
  const text = res.text;
  try {
    return JSON.parse(text);
  } catch {
    // Even with responseMimeType json, Gemini sometimes emits TWO JSON objects
    // back-to-back (deterministic per prompt at temperature 0 — e.g. the
    // wording "DJ stent removal"). A greedy {…} regex spans both and still
    // fails, so take the FIRST balanced object instead.
    const first = firstBalancedJson(text);
    if (first) return JSON.parse(first);
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** First balanced top-level {...} in a string, honoring string literals. */
function firstBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export async function geminiText(prompt, { system } = {}) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    ...(system ? { config: { systemInstruction: system } } : {}),
  });
  return res.text;
}
