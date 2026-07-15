// Temp: transcribe 14-Jul 16:06 meeting recording via Vertex (same pattern as meet1).
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const DIR = '/private/tmp/claude-501/-Users-apple-workspace-code-Hospital-OS/c4f5ba9d-0f52-4f30-a929-80a652a129b2/scratchpad/meet2';
const ai = new GoogleGenAI({ vertexai: true, project: process.env.VERTEX_AI_PROJECT, location: 'us-central1' });

const audio = readFileSync(`${DIR}/audio.mp3`).toString('base64');
const res = await ai.models.generateContent({
  model: 'gemini-2.5-pro',
  contents: [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'audio/mp3', data: audio } },
      { text: `This is a work meeting between a Manager and Shubham (developer) about a hospital cost-estimate builder tool. The conversation is mostly Hindi/Hinglish with English technical terms.

Transcribe the ENTIRE recording into ENGLISH, as a dialogue with speaker labels (**Manager:** / **Shubham:**). Translate Hindi to natural English but keep technical terms (family, payor, GIPSA, TR1, bucket, daycare, estimate, template names, procedure names, rupee amounts) exactly as spoken. Include everything the Manager reads or types out loud. Do not summarize — full transcript.` },
    ],
  }],
  config: { maxOutputTokens: 65000, temperature: 0.2 },
});
const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
writeFileSync(`${DIR}/transcript.txt`, text);
console.log('WROTE', text.length, 'chars');
