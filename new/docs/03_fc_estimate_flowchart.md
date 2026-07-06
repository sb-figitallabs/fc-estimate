# FC Estimate Flowchart

## End-To-End Flow

1. Collect UI input.
2. Identify payor context.
3. Resolve organization context.
4. Resolve tariff.
5. Resolve stay and management context.
6. Resolve room or ward context.
7. Resolve consultation lines.
8. Resolve service lines.
9. Resolve pharmacy lines.
10. Fetch applicable rates.
11. Apply item-level FC logic.
12. Build totals and warnings.
13. Return estimate payload.

## Decision Flow

```mermaid
flowchart TD
    A["Collect user inputs"] --> B["Determine payor bucket"]
    B --> C{"Cash / General?"}
    C -->|Yes| D["Use TR1 / KIMS"]
    C -->|No| E["Resolve organization_cd to tariff_cd"]
    E --> F{"Tariff found?"}
    F -->|No| G["Return unresolved tariff warning"]
    F -->|Yes| H["Determine stay type and management type"]
    D --> H
    H --> I["Determine room / ward context"]
    I --> J["Resolve consultation lines"]
    J --> K["Resolve service lines by canonical_item_key"]
    K --> L["Resolve pharmacy lines by canonical_item_key"]
    L --> M["Fetch tariff / consultation / pharmacy rate context"]
    M --> N["Apply FC bucket and grouping logic"]
    N --> O["Apply cash vs insurance rules"]
    O --> P["Build totals, warnings, unresolved rows"]
    P --> Q["Return estimate response to UI"]
```

## Output Expectations

The builder should return:
- resolved tariff context
- itemized estimate sections
- totals by section and FC bucket
- warnings
- unresolved items that need review
