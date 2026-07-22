# Review — Labour room

**Input reviewed:** `newinps.docx` → "Labour Room" tab (hospital notes + Codex).
**What this tab decides:** labour-room is a maternal location add-on billed by occupancy duration, in addition to (never replacing) the ward/room charge.

## 1. ✅ Safe / additive
- The selected ward/room is still estimated normally; **add a labour-room charge by duration slot** (0–4 / 4–8 / 8–12h). Per the hospital rule: **<4h → occupied-bed charge only; ≥4h → labour-room charge + occupied ward charge**.
- Model as an **optional maternal add-on** with a duration input; apply package vs open handling afterward.

## 2. ⚠️ Needs data / confirm
- The hospital's "auto-bill at ≥4h" behaviour depends on **real-time bed transfer** to/from the labour ward. At **estimate time** there is no live transfer event — so confirm we take **expected/projected labour-room hours** as an FC input (default off unless a delivery pathway is selected).
- Labour-room is additive to room charges — must not be modelled as the room category for the stay.

## 3. ⛔ Blocked
- None hard-blocking, but confirm the labour-room service code(s) and the three duration-slot rates from the tariff before wiring the slots.

## 4. Note
Small, self-contained add-on; the only real question is the estimate-time input (projected hours) vs the billing-time behaviour (live bed transfer).
