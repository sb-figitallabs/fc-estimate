# Estimate pipeline — clinical vs commercial parts

Per the manager's 17-Jul ask: the same estimate, split into the two halves. The clinical part answers *"what happens to the patient and what services does that consume?"* with **no package/PF confusion**; the commercial part answers *"who pays, on what negotiated terms?"*. The UI mirrors this split on the flow-2 results (Clinical/Commercial strip).

```mermaid
flowchart TB
  subgraph CLINICAL["🩺 CLINICAL PART — the treatment itself (IP-approximate-bill level)"
    ]
    A[Doctor's wording] --> B["Treatment identification<br/>(family registry + AI matcher,<br/>payor-aware case counts)"]
    B --> C["Characterization<br/>surgical / medical · daycare / inpatient ·<br/>robotic · emergency"]
    C --> D["Stay & theatre drivers<br/>LOS + breakdown (ward / ICU),<br/>OT hours, cath-lab hours<br/><i>source: cohort P50s — or the package master's<br/>duration when a package attaches (A1)</i>"]
    D --> E["Service-wise amounts<br/>pharmacy buckets (IP drugs/day, IP consumables/day,<br/>OT drugs, OT consumables, implants),<br/>investigations, bedside, cross-consultations"]
    E --> F(["IP APPROXIMATE BILL<br/>gross of all charges, P25–P75 band"])
  end

  subgraph COMMERCIAL["💼 COMMERCIAL PART — who pays, on what terms"]
    G["Payor → tariff mapping<br/>Cash = TR1 · insurer = org tariff<br/>(organization_tariff_mapping)"] --> H["Package vs non-package<br/>gate: alias + master-name search,<br/>AI clinical ranking, per-candidate<br/>match verdicts (B1), FC override (B2)"]
    H --> I["Package terms<br/>per-room price from Service-All tariff (A2),<br/>duration from package master (A1),<br/>inclusions / exclusions (MOU · GIPSA Excel pending)"]
    H --> J["Non-package route<br/>FC-historic fallback ladder<br/>(billed history of this payor)"]
    I --> K["Professional fees<br/>surgical: % cascade / historic reference ·<br/>medical: physician visits (rule sheet pending) ·<br/>cross-consults separate (D3)"]
    J --> K
    K --> L(["PACKAGE BILL / WITH-PACKAGE QUOTE<br/>package + payable extras, billed band"])
  end

  F -. "shown side by side (C2)" .- L

  subgraph SHARED["🔁 SHARED SPINE"]
    M["mart.main_table — HIMS billing history"] --> B
    M --> E
    N["fc.package_master + fc.service_tariff_rate_matrix"] --> I
    O["fc.robotic_admission_classification"] --> C
  end
```

## Field provenance (E2)

| Field | Source |
|---|---|
| IP numbers, billed amounts, payor bucket, tariff codes | **HIMS extract** (as billed) |
| Family/template tags, care type, daycare, robotic flags | **derived** by our classification jobs |
| Package prices per room, package duration, pre/post days | **hospital masters** (Service-All tariff, package master) |
| Inclusions/exclusions | MOU extraction (cash/non-GIPSA); GIPSA Excel pending |
| PF | logic + billed history (visit-fee sheet pending for medical) |
