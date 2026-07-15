# "Ask AI" for Estimate Builder v3 — Plan

## What it is
A chat panel in the estimate builder (like the old EstimateBuilder's AI sidebar) where the FC/admin asks anything about **the data on screen or where it came from**, and gets a plain-language answer. Example: *"Where is this gross total coming from?"* → *"It's built from 683 similar TKR cases billed at KIMS (Cash tariff TR1). Room charges use your entered 4-day stay × the tariff's bed rates; pharmacy comes from the historical P50 of those cases; 3 items had no rate in this insurer's tariff so cash rates were used…"*

## Why it's newly feasible (and cheap)
The hard part — knowing the provenance — is **already built**: `resolved_context.flow` (payer→tariff→basis→route explanation), the bucket-provenance endpoint (basis + case counts per bucket), package-bill actuals, TR1 flags per row. Ask-AI is mostly *translation of existing structured data into prose*, which is exactly what an LLM is good at. Low hallucination risk because we hand it the facts.

## Architecture
```
Chat panel (workbench/preview toolbar: "Ask AI")
   │  question + context bundle (+ optional screenshot)
   ▼
Hospital_OS backend  →  Vertex AI Gemini (service-account — the frontend key is dead;
(new /api/ai/estimate-chat)   all AI is already proxied through the backend since the Vertex migration)
```

### Context bundle sent with every question (no arbitrary DB access — safe by construction)
1. **The current estimate JSON** (already client-side): `resolved_context` incl. `flow`, bucket totals, drivers, line items w/ `tr1_rate` flags, package offer, settlement, warnings.
2. **On-demand provenance** (fetched client-side when the question smells like "source/why/basis"): `bucket-provenance` (basis + case counts + P25/50/75 per bucket, package-bill actuals per payor group), `provenance` (cohort composition).
3. **System prompt**: "You are explaining a hospital cost estimate to its financial counselor. Answer ONLY from the provided data; say 'not in the data I can see' otherwise. Be concrete: name the basis, case counts, tariffs."

This deliberately does **not** give the AI SQL or generic DB access — every answer is grounded in the same audited endpoints the admin panel uses. ("Anything in our DB" beyond that = the AI says what it can't see; if a class of question recurs, we add that data to the bundle or a new read-only endpoint.)

### The screenshot tick ("include what I'm seeing")
- Checkbox in the chat panel; when ticked, capture the page client-side with `html2canvas` (npm, bundles fine — no CDN), downscale to ~1280px, attach as an image part to the same Gemini call (multimodal).
- Use case: "why is THIS row amber?", "what does this badge mean?" — the AI sees exactly the user's view.
- Privacy: the screenshot contains patient data but travels the same backend→Vertex path that already processes patient notes; nothing new leaves the boundary. Default OFF; per-message opt-in.

## Phases + effort
| Phase | Scope | Effort |
|---|---|---|
| 1 | Chat panel + backend `/api/ai/estimate-chat` route + estimate/flow context + 3 suggested questions ("Where does this data come from?", "Why is the patient paying this much?", "What's priced at cash rates and why?") | ~1 day |
| 2 | Provenance tool-fetch (bucket-provenance + package actuals folded in when relevant) + conversation memory within the session | ~0.5 day |
| 3 | Screenshot tick (html2canvas + multimodal call) | ~0.5 day |

## Open choices (defaults chosen, flag if you disagree)
- **Visibility**: everyone, or admin-only first? *Default: everyone for phase 1 (answers are grounded), screenshot tick for all too.*
- Streaming responses vs. single reply: *default single reply (simpler), streaming later.*
- Persist chat with the saved estimate: *default no (ephemeral).*
