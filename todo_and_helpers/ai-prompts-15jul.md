# FC Estimate Builder — the AI prompts in the flow (as asked on the 17:58 call)

All three flow-path calls run on **Gemini 3.1 Pro** (`gemini-3.1-pro-preview`,
Vertex AI, global endpoint) with `responseMimeType: application/json` and
**`temperature: 0`** — fixed on 15-Jul eve (#22). Before the fix no temperature
was sent (model default 1.0), which is why the same input could pick different
packages on different runs. Verified after the fix: "Spine help for
discectomy" now returns the identical family list on repeated runs.

There are 3 AI calls in the matching flow, in this order:

---

## 1. Intake interpretation — free text / admission note → structured input

**When it runs:** the FC types intake text or uploads an admission note.
**Input sent:** the raw note text and/or the uploaded PDF/image, plus this
system prompt (the family list is injected live from the DB — currently ~170
entries, shortened here):

```
You convert hospital financial-counselling intake material (free-text
notes and/or an uploaded admission note) into structured JSON for the FC Estimate Builder.
Extract patient details, clinical details (procedure, department, doctor), payment details
(cash vs insurance, insurer name) and any stated insurance-policy details.

Known procedure families (use the exact key; omit if none fits):
- <family_key>: <family label>     ← one line per family, ~170 lines, from the live registry

Return JSON: {
  patient: {name, age, gender},
  clinical: {procedure, procedure_text, department_name, doctor_name, los_days, icu_days},
  payment: {payor_bucket: "Cash"|"GIPSA Insurance"|"Non-GIPSA Insurance"|"Corporate", organization_name},
  insurance: {base_sum_insured, consumed, ncb, copay_pct, room_rent_cap_per_day, room_eligibility: "General"|"Twin"|"Single"},
  flags: {emergency_ot: boolean, mlc: boolean},
  notes: string[]
}.
clinical.procedure_text: ALWAYS include the procedure/surgery/treatment wording verbatim from the
note whenever any is mentioned (e.g. "Lap ovarian cystectomy"), even when no known family fits.
If the surgery/procedure field contains ANY writing at all — even barely legible handwriting —
NEVER leave procedure_text empty: return your best transcription and mark uncertain readings
with "(?)" (e.g. "CVJ (?)"); an imperfect transcription the FC can correct beats an empty field.
clinical.procedure: only when one of the known family keys clearly fits — never force a match.
clinical.los_days / icu_days: length of stay and ICU days as plain integers if the note states them.
If the note implies insurance, set payor_bucket to the best-guess bucket and include the insurer
name verbatim in payment.organization_name. Amounts must be plain numbers in rupees.
Do not invent values; omit unknown fields. Set flags.mlc true only for medico-legal cases
(accidents, assault, poisoning); flags.emergency_ot true only for emergency surgery.
```

**Guardrails after the call (code, not AI):** if the returned `procedure` is
not an exact known family key it is demoted to `procedure_text` (the UI then
says "not in our database" instead of silently trusting it); the insurer name
is grounded against `fc.organization_tariff_mapping` in the DB — the AI only
suggests, the DB decides the organization/tariff code.

---

## 2. Family matching — doctor's wording → procedure family

**When it runs:** resolving the treatment (gate, resolve-treatment API, and
the estimate build all share this one call — one brain).
**Input sent (user message):** `Doctor's wording: <the raw treatment text>`
**System prompt** (same live family list injected):

```
You map a doctor's free-text treatment/surgery wording to a hospital's
known procedure families for cost estimation.

Known procedure families (use the exact key):
- <family_key>: <family label>     ← one line per family, from the live registry

Return STRICT JSON: { "matches": [{ "family": "<exact key from the list>",
"confidence": "high"|"medium"|"low", "reason": "<one line why it matches>" }] }.
Return at most the top 3 matches ordered best-first; fewer if fewer plausibly fit,
and an empty array if nothing fits. Never invent family keys not in the list.
```

**Guardrails after the call (code, not AI):** invented keys are dropped; then
the **payor-aware reorder** runs in plain code — a match with zero cases for
the selected payor group never wins; a robotic family with no payor history is
replaced by its base family + robotic add-on. So the AI proposes clinically,
the payor logic disposes.

---

## 3. Package candidate ranking — treatment text → hospital package

**When it runs:** after the payor→tariff mapping, when the alias search over
the package master returns more than one candidate for that tariff.
**Input sent (user message):**

```
Raw treatment text: "<treatment>" (tariff <tariff_code>).
Candidate hospital packages:
0: [<package_code>] <package_name>
1: [<package_code>] <package_name>
...                                  ← up to 5 alias-search hits, best-scored first
Return JSON {"best_index": <int or null if none genuinely matches clinically>, "confidence": "high"|"medium"|"low", "reason": "..."}
```

**System prompt:**

```
You match raw treatment descriptions to hospital package catalog rows. Prefer exact clinical matches; return null when nothing genuinely fits. Never invent packages.
```

**Guardrails after the call (code, not AI):** `best_index: null` ⇒ the alias
hits are treated as noise and NO package is offered (better no match than a
wrong one); candidates are deduped by **package code** before ranking (same
code = one package, regardless of name).

---

## How the pieces chain (the flow)

```
intake text / admission note
   │  (prompt 1 — structured extraction; DB grounds insurer + family key)
   ▼
treatment text + payor
   │  payor → payor group (Cash / GIPSA / Non-GIPSA) → tariff code   [pure DB]
   │  package master check on that tariff                            [pure DB]
   ├─ package path:    alias search → (prompt 3 — clinical ranking) → package offer
   └─ family path:     (prompt 2 — family match) → payor-aware reorder [pure code]
   ▼
fallback ladder + cohort → estimate build
```

Only the three prompts above involve AI; every payor/number decision
(payor group, tariff, case counts, quartiles, rates, fallback ladder) is
deterministic DB/code. Ask-AI and the Flow-view narrative use separate
prompts that don't affect matching.
