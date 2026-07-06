import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/** Call Gemini and parse a JSON response. */
export async function geminiJson(prompt, { system } = {}) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      ...(system ? { systemInstruction: system } : {}),
      responseMimeType: 'application/json',
    },
  });
  const text = res.text;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function geminiText(prompt, { system } = {}) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    ...(system ? { config: { systemInstruction: system } } : {}),
  });
  return res.text;
}
