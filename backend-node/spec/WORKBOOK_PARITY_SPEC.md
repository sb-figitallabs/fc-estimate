All extraction is complete. Here is the parity spec summary.

## Artifacts (all in `/private/tmp/claude-501/-Users-apple-workspace-code-Hospital_OS/7423305f-e4f7-4d04-b8a5-29b0983a823e/scratchpad/`)

| File | Contents |
|---|---|
| `parity_spec.json` (2.8 MB) | Per-sheet: dimensions, freeze/gridlines/zoom/tab color, col widths, row heights, merges, data validations, conditional formatting, styled cell map (with fonts/fills/borders/alignment/number formats + cached values), normalized formula patterns with examples, unlocked cells |
| `full_cell_data.json` (1.4 MB) | **Every cell of every sheet**: raw value, or `{f: formula, v: cached value}` — the complete data payload for the generator, including the full Reference sheet (31,642 cells) and Pharmacy Template (9,105 cells) |
| `report.txt` | Human-readable per-sheet dump with style-token legend (49 styles) |
| `formula_families.txt` | Formula patterns collapsed by literal-masking, per sheet |
| `reference_columns.txt` | Column-by-column map of the Reference sheet (header, row range, samples) |
| `lid_archetypes.txt` | Full formulas for every Line Item Detail row archetype |
| `layouts.txt` | Compact grid layouts of all secondary sheets |

Extraction scripts: `extract_parity.py`, `report.py`, `distill.py` (same dir).

---

# PARITY SPEC — `fc_estimate_builder_robotic_tkr_unilateral_right_cash_tr1.xlsx`

## Workbook-level facts

- 16 visible sheets, order exactly as listed in the task. Produced by a LibreOffice-compatible writer (`fileVersion appName="Calc"`); an exceljs rebuild should set `fullCalcOnLoad` so formulas recalc.
- **No** merged cells, **no** conditional formatting, **no** frozen panes, **no** tab colors, **no** sheet protection, **no** user-defined names anywhere.
- **Hidden defined names**: `_xlnm._FilterDatabase` (i.e., **AutoFilters**) on: Grouping Review `A12:G16`, Estimate Breakdown `A3:J90`, Pharmacy Template `A3:R520`, Service Template `A3:P30`, Pharmacy Metrics `A3:R29`, IP FC Actuals `A4:AF30`. In exceljs: `ws.autoFilter = ref`.
- **Gridlines hidden on every sheet except Reference** (Reference: `showGridLines=true`). Zoom 100 everywhere.
- **Hidden columns**: Service Add-Ons `M`; Grouped Adjustments `O`; Implant Selection `R,S,T`; Line Item Detail `F`.
- Row heights: every populated row carries an explicit height of **15.0**; exceptions (instruction/wrap rows): Builder r9=39.55, r20–28 = 77.6/102.95/90.25/64.9/64.9/115.65/90.25/128.35/39.55; Estimate Summary r3=229.85, r56=26.85, r58=77.6, r59=115.65; other sheets' exceptions are in `parity_spec.json → sheets[*].row_heights`.

## Visual style system (fonts / fills / hex)

Font everywhere in styled regions: **Cambria 11**. Unstyled Reference body: Calibri default.

| Role | Fill | Font | Border |
|---|---|---|---|
| Sheet title bar (row 1, styled across used cols) | `#1F4E78` | bold, white `#FFFFFF` | thin `#D9D9D9` |
| Section header / column header | `#D9EAF7` | bold | thin `#D9D9D9` |
| Body / label cells | `#F4F6F8` | regular (labels sometimes bold) | thin `#D9D9D9` |
| **Input cells** (dropdown/manual) | `#FFF2CC` | regular | Builder inputs: **medium `#4F81BD`** box; elsewhere thin `#D9D9D9` |
| Computed/resolved result | `#EAF4EA` | bold on Builder (with medium `#4F81BD`), regular elsewhere | as noted |
| Actuals-lookup cells (P25/P75 cols) | `#EAF1FB` | regular | thin `#D9D9D9` |
| Alert/attention | `#FCE4D6` | bold | thin `#D9D9D9` |
| Status-good | `#E2F0D9` | bold | thin `#D9D9D9` |

Number formats used: `General`, `#,##0`, `#,##0.0`, `#,##0.00`, `0.00`, `0.0%`. The exact style per cell is in `parity_spec.json`; the 49-entry deduped legend is at the end of `report.txt`.

Alignment: title/labels left+vcenter; data cells center+vcenter; instruction rows left+vcenter+wrap.

## Inputs vs computed

No protection is applied, so "unlocked" is moot; inputs are identified by yellow fill + data validation:

| Sheet | Input cells | Dropdown list (formula1) |
|---|---|---|
| Builder | B4 | `"General,Twin,Single"` |
| Builder | B5 | `"Low,Typical,High"` |
| Builder | E2 | `"Cash / TR1,Insurance / Org Tariff"` |
| Builder | E3 | `"Auto (Recommended),Cash,GIPSA Insurance,Non-GIPSA Insurance,Corporate,Insurance All,All Payers"` |
| Builder | B6, E6 (one DV, sqref `B6 E6`) | `"No,Yes"` |
| Builder | B8 (allowBlank) | `"Yes,No"` |
| Builder | E11:E13 | `"P25,P50,P75,Manual"` |
| Builder | G2 (allowBlank) | `Reference!$DU$2:$DU$1000` (org codes) |
| Builder | F11:F13 (manual values), E8 (=1, robotic presence rate, fmt `0.0%`) | none (free entry) |
| Advanced Controls | H8:H17 | `"Include,Exclude"` |
| Service Add-Ons | I7:I33 | `"Include,Exclude"` |
| Grouped Adjustments | L7:L9 | `"Include,Exclude"` |
| Implant Selection | B4 | `"Default P50,Family Override,Brand Override,Exact Item Override"` |
| Implant Selection | B5 / B6 / B7 | `'Implant Selection'!$R$2:$R$9` / `$S$2:$S$9` / `$T$2:$T$65` (hidden helper cols) |

Everything else is either a static data cell or a formula.

## Per-sheet layout + formula inventory

### 1. Builder (A1:G28)
Widths A24/B18/C12/D18/F20/G24. Row 1 title bar. Left block: labels A2–A8 with inputs B2 (procedure text, static "Robotic TKR Unilateral - Right"), B4/B5/B6/B8. Right block: D/E and F/G resolver pairs rows 2–8. Driver grid rows 9–13 (headers r9: Driver|P25|P50|P75|Selection|Manual Value|Selected Value), resolved OT rows 14–17, "How To Use" instructions rows 19–28.
Key formulas (full text in JSON):
- `B3 =E2`; `E4 =IF(E2="Cash / TR1","Cash",IFERROR(INDEX(Reference!$DT$2:$DT$1000,MATCH(G2,Reference!$DU$2:$DU$1000,0)),""))`; E5 same with `$DX` →"TR1"; G3 org name via `$DV`; G4 tariff name via `$DY`.
- G5/G6/G7 resolved pharmacy/service/pf basis: `=IF(E3<>"Auto (Recommended)",E3,IFERROR(INDEX(Reference!$GP$2:$GP$800,MATCH("pharmacy_basis"&"|"&E4,Reference!$GD$2:$GD$800,0)),"Cash"))` (literal `service_basis` / `pf_basis` per row). G8 reason text via `$GS`.
- ICU/Ward percentile lookups B11:D12: `=INT((IFERROR(INDEX(Reference!$BI$2:$BI$500,MATCH(Builder!G6,Reference!$AZ$2:$AZ$500,0)),0)))+IF(MOD((…same…),1)>0.3,1,0)` — column letters per cell: B11→BI, C11→BJ, D11→BK, B12→BL, C12→BM, D12→BN. LOS rows: `B10=B11+B12` etc. `G11/G12 = INT(IF(E11="P25",B11,IF(E11="P50",C11,IF(E11="P75",D11,F11))))+0.3-rounding`.
- OT hours B13:D13 and G13: same percentile lookup (BO/BP/BQ) **snapped to nearest OT slot ladder** `Reference!$K$300:$K$331` via a MATCH/INDEX nearest-neighbor expression (full text: report.txt lines 96–101, or JSON).
- `B14` = G13 snapped to slot; `B15/B16` slot code/label: `=IF(B14="","",IFERROR(INDEX(Reference!$EQ$2:$EQ$1000,MATCH(Builder!E5&"|"&IF(B6="Yes","emergency","normal")&"|"&(B14),Reference!$EL$2:$EL$1000,0)),""))` (`$ER` for label); `B17 =IF(B6="Yes","Emergency","Normal")`.

### 2. Estimate Summary (A1:R59)
Widths A24/B18/E20/F12/G18/H14/L24/M14/P24/Q16/R14. Zones: KPI mirror A2:B11 (`=Builder!…`); Final Estimate D2/E2: `E2 =IF(B2="General",'Line Item Detail'!W75,IF(B2="Twin",'Line Item Detail'!X75,'Line Item Detail'!Y75))`; explainer D3:E3 (wrap, r3 height 229.85). Room×Mode matrix D6:G9: `E7='Line Item Detail'!N75` … mapping N–V75 (Gen/Twin/Single × Low/Typ/High). Drivers panel I6:J20 (`=Builder!G10…B17`, `='Advanced Controls'!C6`, `='Implant Selection'!F6`, `='Service Add-Ons'!C5`, `='Grouped Adjustments'!C5/E5`). Cohort counts L6:M11 (`INDEX(Reference!$BA..$BE,MATCH(Builder!G6,$AZ))`). Bucket table A12:B21: `B13..B20 =IF(B2="General",SUMIF('Line Item Detail'!$B$2:$B$73,A13,'Line Item Detail'!$W$2:$W$73),IF(B2="Twin",…$X…,…$Y…))`; `B21=E2`; `B22` historic PF P50 (`$FF`/`$FC`); `B23=B21-B19+B22`. Pharmacy P50-by-basis grid L13:R23 (`INDEX($CK/$CN/$CB/$CE/$CH,MATCH("<basis literal>",$AZ))` for the 6 payer literals). PF-by-payer A25:E32 (`$FD..$FG` by payer literal). PF mix panel L24:P34 (`$FE..$GC` by `Builder!G7`). Service-count checks I24:J29 (`='Service Add-Ons'!P10/P5/P6/P7/P11`). Actuals snapshot A36:F59: rows 38–57 `=IFERROR(INDEX(Reference!$HH/$HI/$HJ,MATCH(Builder!G6&"|"&"<field_key>",Reference!$HA$2:$HA$1000,0)),0)` — basis cell is G6 for service fields, G5 for pharmacy fields, G7 for PF; field keys: los_days, icu_days, ward_days, ot_hours, service_line_count, room_charges, room_charges_per_day, investigations, procedure_ot_charges, bedside_services, ip_drugs, ip_drugs_per_day, ip_consumables, ip_consumables_per_day, ot_drugs, ot_consumables, implants, pharmacy_total, drug_administration_charges, professional_fees. Row 58 historic PF (`$FE/$FF/$FG`); row 59 component-mix total: `=IF(AND(Builder!G5=Builder!G6,Builder!G6=Builder!G7),INDEX-lookup of total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin, else sum of 7 component lookups)`.

### 3. Estimate vs IP FC Actuals (A1:J43)
Widths A28/B22/C16/J18. Header r4 `Metric|Comparison Basis|Selected Estimate|Actual P25|Actual P50|Actual P75|Delta vs P25|Delta vs P50|Delta vs P75|Status`. Rows 5–21 metrics (list in layouts.txt): B=`Builder!G6/G5/G7` per component; C mostly `='Estimate Summary'!B13…` , pharmacy sub-rows C10–C16 use `SUMIF('Line Item Detail'!$A$2:$A$73,"<item name>",$W/$X/$Y)` room-switched, per-day rows divide by `Builder!G10`; D/E/F = HH/HI/HJ lookups; `G=C-D`, `H=C-E`, `I=C-F`; `J5:J21 =IF(AND(OR(C5<D5,C5>F5),ABS(H5)>MAX(5000,0.2*MAX(E5,1))),"Material Gap",IF(C5<D5,"Below Range",IF(C5>F5,"Above Range","Within Range")))`. Driver block r24–28 (C=`Builder!G10..G13`, G=simpler Below/Above/Within). Cohort block r31–34 (BA–BE lookups; H Scope static text). Notes rows 37–43.

### 4. Advanced Controls (A1:H17)
Widths A40/B12/D14/F18/G14. Anchors r4–5: `B5/C5/D5 = INDEX(Reference!$CD/$CE/$CF,MATCH(Builder!G5,$AZ))`. Applied value `C6 =IF(COUNTIF(H8:H17,"Include")=0,C5,IF(IFERROR(SUMIF(H8:H17,"Include",F8:F17)/SUM(F8:F17),0)<=0.3,B5,IF(…<=0.5,C5,D5)))`. Item table r7 header, r8–17 (10 OT-consumable items, names in layouts.txt): `B = INDEX(Reference!$DO,MATCH(Builder!G5&"|"&A{r},$DR))` with per-row numeric fallback; `C =IF(B>0,D/B,0)`; `D = INDEX($DP,…)` w/ fallback; `E = INDEX($DL,…)` presence w/ fallback; `F =E*B*C/100`; `G8 =F8/SUM($F$8:$F$17)`, `G9:G17 =G8+F9/SUM($F$8:$F$17)` (running share); H dropdown default "Exclude".

### 5. Service Add-Ons (A1:P33)
Widths A40/B18/C12/G14/I12/J14/M14(hidden)/O28/P16. Totals r5: `B5/C5/D5 =SUMIF(I7:I33,"Include",J/K/L)`. Table r6 header, r7–33 = 27 optional items (codes in hidden col M, listed in layouts.txt): `C` presence `INDEX(Reference!$CW,MATCH(Builder!G6&"|"&M{r},$CQ))` w/ per-row fallback; `D/E/F` qty P25/P50/P75 via `$CX/$CY/$CZ`; `G` room-switched tariff rate `=IF(Builder!B4="General",INDEX($EG,MATCH(Builder!E5&"|"&M{r},$EB)),IF(Builder!B4="Twin",$EH…,$EI…))`; `H =E*G` typical gross with insurance-exclusion guard; `J/K/L =IF(AND(Builder!E2="Insurance / Org Tariff",INDEX($EZ,MATCH(M{r},$EX))="Yes"),0,D|E|F * G)`; `I` dropdown. Side panel O/P rows 5–11: P5/P6/P7 = `$BR/$BS/$BT` service-line quartiles; `P8 =36+IF(Builder!B8="Yes",1,0)`; `P9 =COUNTIF(I7:I33,"Include")`; `P10=P8+P9`; `P11 =IF(P10<P5,"Below historical P25",IF(P10>P7,"Above historical P75","Within historical range"))`.

### 6. Grouped Adjustments (A1:Q9)
Widths A30/B22/C14/D16/L12/M16/N34/O13(hidden). Totals r5: `B/C/D =SUMIF(L7:L9,"Include",I/J/K)`, `E5 =COUNTIF(L7:L9,"Include")`. Table r6 header (…N=Why), rows 7–9 = groupings Coagulation Tests / Inflammatory Marker Tests / Haematology Counts with **static** C (presence), D/E/F (group P25/50/75 exact), G (captured-by-default), N ("Auto common-case residual"); formulas: `H =IF(Builder!B5="Low",O,IF(…"Typical",P,Q))`; `I/J/K =MAX(0,D-G-O | E-G-P | F-G-Q)`; `M =IF(L="Include",IF(Builder!B5="Low",I,IF(…,J,K)),0)`; hidden O/P/Q `=SUMIFS('Service Add-Ons'!$J:$J|$K:$K|$L:$L,'Service Add-Ons'!$B:$B,$A{r},'Service Add-Ons'!$I:$I,"Include")`.

### 7. Grouping Review (A1:P16) — all static
Header r4, one flagged group r5 (Haematology Counts, material_gap); child detail table r12–16 (static values, see layouts.txt). AutoFilter A12:G16.

### 8. Implant Selection (A1:AR90)
Widths A18/C42/D10/E18/F14/I2/K18/L22/M14/N12/P14/Q16/R14/S18/T13; hidden R/S/T (dropdown source lists: R2:R9 family incl. "All", S2:S9 brands incl. "All", T2:T65 item codes incl. "None"). Controls: B4 mode, B5 family, B6 brand, B7 item code; `C7 =IF(B7="None","",IFERROR(INDEX($AN$2:$AN$200,MATCH(B7,$AM$2:$AM$200,0)),""))`. Anchors `F5/G5/H5 = INDEX(Reference!$CG/$CH/$CI,MATCH(Builder!G5,$AZ))`. Resolver `F6 =IF(B4="Default P50",$G$5,IF(B4="Family Override",IFERROR(INDEX($AB$2:$AB$50,MATCH(B5,$U$2:$U$50,0)),$G$5),IF(B4="Brand Override",IFERROR(INDEX($AI$2:$AI$100,MATCH(B5&"|"&B6,$AJ$2:$AJ$100,0)),fallback…),IFERROR(INDEX($AR$2:$AR$200,MATCH(B7,$AM$2:$AM$200,0)),fallbacks…))))`. Display tables: Family Summary A11:I18 (static); Brand View K10:Q26 (static + `Q12:Q26 =IF($B$5="All","Yes",IF(K12=$B$5,"Yes","No"))`); Exact Item View K27:S90 (static + `S28:S90 =IF($B$5="All","Yes",IF($B$6="All",IF(K28=$B$5,"Yes","No"),IF(AND(K28=$B$5,L28=$B$6),"Yes","No")))`). Hidden data blocks: U:AB family stats (r2–8), AD:AJ brand stats w/ AJ=`Family|Brand` key, AK:AR item stats (r2–64). All static — full data in `full_cell_data.json`.

### 9. Estimate Breakdown (A1:J90)
Widths A34/B22/C18/D14/E34/F12/G14/J16. AutoFilter A3:J90. Header r3; bucket section-title rows: A4 Room Charges, A15 Investigations, A28 Procedure / OT Charges, A38 Bedside Services, A47 Drug Administration Charges, A50 Pharmacy, A57 Professional Fees, A63 Optional Add-Ons (blank spacer row before each). Data rows 5–13,16–26,29–36,39–45,48,51–55,58–61 (mapped rows of Line Item Detail 2–43+71–73) and 64–90 (add-ons, LID rows 44–70): `A/C/D/E ='Line Item Detail'!A{src}/C/D/E`; B static bucket; `H =Builder!B4`; `J =IF(Builder!B4="General",'Line Item Detail'!W{src},IF(…Twin…,X,Y))`; `F` Included?/Excluded/Excluded-for-Insurance logic and `G`/`I` qty/rate mode-aware displays (three variants — exact patterns in formula_families.txt §Estimate Breakdown).

### 10. Line Item Detail (A1:Y75) — calculation engine
Widths A34/B20/C18/D14/E24/F12(hidden)/G12/H10/K12/W14. Header r1: `Line Item|Parent Bucket|Sub-Bucket|Source|How|Item Code|Selected Qty|Qty Low|Qty Typical|Qty High|Rate General|Rate Twin|Rate Single|General Low|General Typical|General High|Twin Low|Twin Typical|Twin High|Single Low|Single Typical|Single High|Selected Total General|Selected Total Twin|Selected Total Single`. Rows 2–73 items (full inventory printed above in my analysis; A–E static text, F static code), r74 `Subtotal Before Professional Fees` `=SUM(N2:N34,N39:N73)` per col N–Y, r75 `Grand Total` `=N74+SUM(N35:N38)` per col.
Row archetypes (complete formulas in `lid_archetypes.txt`):
- **Template rows** (auto-included services): `G =IF(Builder!B5="Low",H,IF(…,I,J))`; `H/I/J = INDEX(Reference!$CX/$CY/$CZ,MATCH(Builder!G6&"|"&F{r},$CQ))` w/ fallback; `K/L/M =0+INDEX($EG/$EH/$EI,MATCH(Builder!E5&"|"&F{r},$EB))` w/ hardcoded fallback rate; `N..V = insuranceExclusionGuard(qtyP×rateRoom)` (N=H*K, O=I*K, P=J*K, Q=H*L … V=J*M); `W/X/Y = mode-switch over N..V`.
- **Logic day-rows** (ICU/Ward/LOS × rate): G/H/I/J = `Builder!G12,B12,C12,D12` (ward), `G11,B11,C11,D11` (ICU), `G10,B10,C10,D10` (LOS); K/L/M rate lookups (ICU rows use `$EJ` icu rate column); W/X/Y use `G×K/L/M`.
- **Bed Charges r7**: K/L/M lookup three explicit room item codes `ROM0001/ROM0024/ROM0036`; no insurance guard.
- **Robotic r13**: adds `IF(Builder!B8="Yes",…,0)` inside guard.
- **OT r17**: `F17=Builder!B15`, qty cells = `Builder!G13`; K/L/M lookup by `Builder!E5&"|"&Builder!B15`; N–V map directly to K/L/M (rate = total).
- **Cath Lab r18**: static qty 1; `N/O/P =Reference!T4/U4/V4`; Q–V mirror; `X18=W18,Y18=W18`.
- **MLC r33**: qty `=IF(Builder!E6="Yes",1,0)`, code HSP0047.
- **Drug Admin r34**: `=IF(Builder!E2="Insurance / Org Tariff",0,0.125*SUM(N39,N40,N41,N42,N43))` per column.
- **PF r35–38**: Surgeon `0.25*{col}74`; Assistant Surgeon `0.15*{col}35`; Anesthetist `0.25*{col}35`; Assistant Anesthetist `0.25*{col}37` — all zeroed in insurance mode.
- **History pharmacy r39/40**: qty = LOS driver (`Builder!G10/B10/C10/D10`); `N =G39*INDEX($CJ,MATCH(Builder!G5,$AZ))`, O→`$CK`, P→`$CL` (r40: `$CM/$CN`); K/L/M display per-day P50; Q–V mirror N–P; W/X/Y mode-switch.
- **OT Drugs r41**: N/O/P = `$CA/$CB/$CC` bucket quartiles.
- **OT Consumables r42**: N/P = `$CD/$CF`; **O/R/U = `'Advanced Controls'!C6`**.
- **Implants r43**: N/P = `$CG/$CI`; **O/R/U = `'Implant Selection'!F6`**.
- **Add-on rows r44–70**: template pattern + `IF('Service Add-Ons'!I{7+idx}="Include",…,0)` inside guard.
- **Grouped residual r71–73**: `K/L/M ='Grouped Adjustments'!M{7+idx}`; `N =IF(AND(Builder!E2="Insurance / Org Tariff",ISNUMBER(SEARCH("excluded for insurance",LOWER('Grouped Adjustments'!N7)))),0,IF('Grouped Adjustments'!L7="Include",'Grouped Adjustments'!I7,0))` (O→J7, P→K7); Q–V mirror; W/X/Y mode-switch.

### 11–15. Data sheets (uniform static tables)
All share: r1 title (`#1F4E78` bar), blank r2, header row (`#D9EAF7` bold, wrap) then body rows (`#F4F6F8`, thin `#D9D9D9`), AutoFilter on header:last:
- **Pharmacy Template** A1:R520 (517 items; header r3, cols: Item Code…Observed Rate Values).
- **Service Template** A1:P30 (27 services; header r3; cols incl. tariff General/Twin/Single/ICU, Room Dependent).
- **Pharmacy Metrics** A1:R29 (26 admissions; per-IP pharmacy metrics).
- **IP FC Actuals** A1:AF30 (26 admissions × 32 cols of actual billed buckets).
- **Professional Fees Review** A1:P31: static review (template PF signals r6–11, payer-wise PF summary r13–20, modeled-vs-historical r22–31: Modeled P25 79,533.49 / P50 82,036.01 / P75 84,994.8325 / Diff P50 16,015.185 / MAPE 17.185).

### 16. Reference (A1:HJ1035) — lookup engine, unstyled (Calibri, gridlines on) except A1 title
Column-block map (full detail in `reference_columns.txt`):
| Cols | Rows | Block |
|---|---|---|
| A:I | 3–213 | Stacked labeled mini-tables: LOS/ICU/Ward/OT quartiles (r3–8), Pharmacy bucket quartiles (r10–16), IP pharmacy per-LOS-day (r18–21), service-line-count quartiles (r23–25), Cleaned Services Template (r27–85 incl. Optional Service Rows r57–85), TR1 Tariff Rates (r87–147), Implant Reference (r149–213) |
| J:R | 298–331 | OT tariff slot ladder (`K300:K331` = ot_slot_hours used by Builder snapping; item codes/names + general/twin/single/icu rates) |
| S:V | 2–4 | Cath-lab family metrics (T4/U4/V4 = P25/50/75, all 0 here) |
| AZ:CP | 2–7 | Cohort stats by basis_label (6 payer rows): counts BA–BE, LOS/ICU/ward/OT p25-75 BF–BQ, service-line BR–BT, pharmacy buckets BU–CI, per-day CJ–CO, cath CP |
| CQ:DE | 2–319 | Service item stats keyed `basis|item_code` (CQ key; CW presence; CX–CZ qty p25/50/75; DB–DE tariff rates) |
| DG:DR | 2–1035 | Pharmacy item stats keyed `basis|code|name` (DO ot_qty, DP ot_amount, DQ overall amount, DR `basis|name` key) |
| DT:DZ | 2–44 | Insurance org directory (DU org code → DV name, DX tariff code, DY tariff name, DT payor bucket) |
| EB:EJ | 2–1004 | Tariff rate matrix keyed `tariff|item` (EG general, EH twin, EI single, EJ icu) |
| EL:EV | 2–355 | OT slot matrix keyed `tariff|mode|hours` (EQ code, ER label, ES–EV rates) |
| EX:FA | 2–23 | Insurance-excluded item list (EZ = "Yes" flag) |
| FC:GC | 2–7 | PF stats by payor bucket (FD count; FE–FG collectible p25/50/75; FH–GB named-role totals; GC dominant shape) |
| GD:GS | 2–73 | Basis resolver keyed `component|payor` (GP selected_basis, GS reason) |
| HA:HJ | 2–145 | Actuals percentiles keyed `basis|field_key` (HE min, HF max, HG avg, HH p25, HI p50, HJ p75) |

## Key cached values (numeric validation targets)

| Cell | Value |
|---|---|
| Builder B4/B5/E2/E3/B6/E6/B8 | Single / Typical / Cash · TR1 / Auto (Recommended) / No / No / Yes |
| Builder E4/E5/G4/G5/G6/G7 | Cash / TR1 / KIMS / Cash / Cash / Cash |
| Builder B10:D10 (LOS p25/50/75) | 2 / 3 / 5 → G10 = **3** |
| Builder B11:D11 (ICU) | 2 / 2 / 3 → G11 = **2** |
| Builder B12:D12 (Ward) | 0 / 1 / 2 → G12 = **1** |
| Builder B13:D13 (OT hrs) | 2.5 / 3 / 3 → G13 = **3**; B14=3, B15=OTC0010, B16="OT - 3 HOURS", B17=Normal |
| Estimate Summary **E2 Final Estimate** | **597612.06545752** |
| ES matrix E7:G9 (Gen/Twin/Single × L/T/H) | 555166.729905518 / 579449.25295752 / 685465.150770312; 561243.761155518 / 587765.90920752 / 696021.432020312; 566487.761155518 / 597612.06545752 / 710469.744520312 |
| ES buckets B13:B21 | Room 45280; Investigations 14940; Proc/OT 158660; Bedside 5200; Pharmacy 189805.03625; DrugAdmin 23725.62953125; PF 160001.39967627; Optional 0; Grand 597612.06545752 |
| ES B22 / B23 | 98192 / 535802.66578125 |
| ES M7 cohort / J16 / J17 / J19 / J20 / J25 | 26 / 72382.9 / 89130.16 / 7280 / 3 / 37 |
| LID W74 / U74 (subtotal) | 424310.66578125 / 437610.66578125 |
| LID U75 / W75 / Y75 | 597612.06545752 / 579449.25295752 / 597612.06545752 |
| Advanced Controls B5/C5/D5/C6 | 66040.54 / 72382.9 / 107563.63 / 72382.9 |
| Implant Selection F5/G5/H5/F6 | 89130.078 / 89130.16 / 98838.05 / 89130.16 |
| Grouped Adjustments B5/C5/D5/E5 | 6042.5 / 7280 / 7830 / 3 |
| Service Add-Ons B5/C5/D5, P5–P11 | 0/0/0; 36.25 / 39 / 41 / 37 / 0 / 37 / "Within historical range" |
| EvA J5 status | "Within Range" (C5=45280 vs 41910/45064/54051) |

Caveats for the rebuild: dropdown DVs use `showDropDown=0` in XML (normal Excel arrow semantics); openpyxl reports quantity fallbacks per formula (they vary row-by-row — take exact formulas from `full_cell_data.json`, not from the pattern templates); `Builder!G2` is blank (cached B6 mirror shows 0), so cash-mode defaults drive all cached numbers.