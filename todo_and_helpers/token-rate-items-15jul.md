# Token ₹1 items on insurer tariffs — the list you asked for (Q2)

You said: "one rupee is used for line items that should not be billed in
insurance — show me the items." Here they are: **10 distinct items** carry
₹0/₹1 rates on the insurer tariffs. The deciding column is the last one —
what these items ACTUALLY did on real insurer bills (fc.package_bill_lines,
payer_type = INSURANCE).

| code | item | token rate | TR1 cash rate | on actual insurer bills |
|---|---|---|---|---|
| EME0019 | MONITOR PER DAY | ₹1 | ₹850 | 91 lines, **P50 ₹990** |
| EME0088 | TRANSFUSION | ₹1 | ₹1,270 | 70 lines, **P50 ₹910** |
| EME5047 | MONITOR HALF DAY | ₹1 | ₹450 | 11 lines, **P50 ₹515** |
| RNS5005 | CSSD CHARGES FOR GA | ₹1 | ₹2,000 | 5 lines, **P50 ₹1,440** |
| OTI0015 | OT DISINFECTION CHARGES | ₹1 | ₹2,470 | 4 lines, **P50 ₹750** |
| OTI0025 | THREE CHIP CAMERA | ₹1 | ₹3,500 | 3 lines, **P50 ₹3,730** |
| OTI0101 | INSTRUMENT CHARGES (MEDIUM) | ₹1 | ₹5,380 | 2 lines, P50 ₹961 |
| OTI0018 | INSTRUMENT CHARGES (MAJOR) | ₹1 | ₹10,480 | 1 line, P50 ₹9,080 |
| ROM0093 | DMO CHARGES | ₹1 | ₹1,250 | 5 lines, **P50 ₹1** |
| ROM5189 | NURSING CHARGES | ₹1 | ₹5,000 | 2 lines, **P50 ₹1** |

## What the evidence says

- **Your theory holds for two items**: DMO CHARGES and NURSING CHARGES are
  billed at ₹1 on real insurer bills too — the ₹1 is deliberate ("folded
  into the room/package rate, not separately billable in insurance").
  → keep the token rate, annotate the row.
- **The other eight are missing rates, not not-billable items**: monitors,
  transfusion, CSSD, OT disinfection, camera, instrument charges all appear
  on actual insurer bills with real amounts close to the TR1 cash rate.
  → cash (TR1) fallback is right for these.

## Proposed rule (for your sign-off)

Token-rate row → check the billed evidence: if the item's actual insurer-bill
P50 is also ~₹1 ⇒ keep token + annotate; otherwise TR1 fallback (flagged
`tr1_rate` like the existing missing-rate fallback). Concretely that means:
fallback for EME0019, EME0088, EME5047, RNS5005, OTI0015, OTI0025, OTI0101,
OTI0018 and token-keep for ROM0093, ROM5189.
