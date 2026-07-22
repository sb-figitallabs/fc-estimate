# FC Estimate Builder — Professional Fee, Multi-Treatment, and Extended-Stay Implementation Specification

Version: 1.0  
Date: 2026-07-20  
Status: Approved implementation specification  
Runtime database: `postgres` at `127.0.0.1:54322`  
Runtime schemas: `fc_curated`, `fc_clean`, and `fc_estimate`

## 1. Purpose

This document defines how the FC Estimate Builder must calculate and explain:

- Professional fees (PF).
- Multiple treatments and procedures.
- Multiple packages.
- Package plus open treatment.
- Medical management plus surgery.
- Package-LOS overstay charges.
- Ward- and ICU-based consultation charges.

The rules combine current hospital guidance with validation against clean historical IP billing. They are designed to be deterministic, versioned, explainable, and safe for production use.

Runtime code must use structured rules in the database. It must not parse this Markdown file.

## 2. Governing principles

### 2.1 Rule precedence

Use the following precedence whenever sources conflict:

1. Current approved hospital policy or signed payer agreement.
2. Package-, tariff-, organization-, or doctor-specific hospital rule.
3. Approved curated interpretation.
4. Historical billing behavior, clearly marked as empirical evidence.

### 2.2 Required routing dimensions

Every calculation must be routed by both:

1. Payer route:
   - Cash.
   - GIPSA Insurance.
   - Non-GIPSA Insurance.
   - Corporate.
2. Billing surface:
   - `LAN_ESTIMATE`: counselling/LAN/FC estimate logic.
   - `FINAL_INSURANCE`: final insurer-facing bill logic.

Do not infer final-insurance PF percentages from LAN service lines. Historical `services_json` is useful evidence but frequently represents the LAN or approximate billing surface rather than the final adjudicated insurance claim.

### 2.3 No silent assumptions

- A missing treatment mapping is not medical management.
- A calendar date is not sufficient to prove that two procedures were in the same sitting.
- A procedure name containing “LA” is not sufficient to prove local anaesthesia.
- Historical behavior cannot silently become a contractual package inclusion or exclusion.
- Doctor discretion, TPA negotiation, or an unapproved cap must be an explicit override or review outcome.

## 3. Historical validation summary

The following findings define the initial production posture.

| Rule | Historical result | Implementation status |
|---|---|---|
| Non-GIPSA, two comparable packages in the same sitting | 70 of 70 comparable equal-rate pairs used a 50% secondary-package amount | Active and validated |
| Package overstay consultation | 799 of 824 overstay admissions, 97%, had post-package primary-consultant charging | Active and validated |
| GIPSA package surgeon PF | Historical distribution supports 20% of package | Active and validated |
| Non-GIPSA package surgeon PF | Historical distribution supports 25% of package | Active and validated |
| Cash/LAN open surgeon PF | Historical central tendency is approximately 25% | Active and validated |
| Insurance assistant physician | 4,968 comparable bill-level pairs had a 50% median assistant-to-primary visit rate | Use tariff rate; reject universal 10% |
| DMO daily charging | Most admissions were equal to stay days or one/two units fewer | Use eligible billing days, not raw LOS |
| GIPSA same-sitting package reduction | Reliable comparable sample is too small and does not consistently show 50% | Configurable and provisional |
| Different-sitting packages at 100% | Policy-supported; historical session matching is incomplete | Active policy rule with evidence flag |
| Final-insurance open surgeon PF at 35% | Stated policy; current historical LAN surface does not validate it | Configurable policy rule |
| Local anaesthesia means no anaesthetist PF | Clinically valid; historical procedure wording is not reliable enough to determine anaesthesia type | Active only with verified anaesthesia type |

## 4. Canonical inputs

The Builder must have, derive, or explicitly mark as missing the following inputs.

### 4.1 Admission and payer inputs

- `admission_no` or estimate identifier.
- `payor_bucket`.
- `organization_cd` and organization name.
- `tariff_code`.
- `billing_surface`.
- Room eligibility and selected room category when applicable.

Payer routing must use `fc_clean.v_payer_organization_tariff`. GIPSA must remain organization- and TR290-driven.

### 4.2 Treatment-component inputs

Each treatment must become a separate component with:

- `component_id`.
- `clinical_concept_id` and normalized treatment name.
- `component_type`: `PROCEDURE`, `MEDICAL_MANAGEMENT`, or `PACKAGE`.
- `billing_mode`: `PACKAGE` or `OPEN`.
- `package_code`, if applicable.
- `service_code` or procedure code, if applicable.
- `session_key`.
- `session_date`.
- `full_eligible_amount`.
- Source and mapping evidence.
- Confidence and review status.

### 4.3 Session evidence

Use the following precedence to determine whether procedures belong to the same sitting:

1. Same active OT/cath-lab transaction or encounter identifier.
2. Approved clinical/session mapping.
3. Same documented operative session in the clinical record.
4. Manual resolution.

The same calendar date alone is insufficient. Procedures on the same date but in different documented sittings are treated as different sittings.

### 4.4 PF inputs

- Doctor identifier.
- PF role: primary physician, surgeon, assistant physician, assistant surgeon, anaesthetist, assistant anaesthetist, DMO, cross-consultant, or physiotherapist.
- Doctor engagement type when available: salaried/MG, honorary, or doctor-specific agreement.
- PF rule or tariff rate.
- Anaesthesia type and evidence.
- Applicable treatment component.
- PF base and explicit exclusions.
- Parent PF line for dependent fees.

### 4.5 Stay inputs

- Package LOS.
- Projected total LOS.
- Projected ward days.
- Projected ICU days.
- Day-level room ledger where available.
- Package start/end and treatment-period boundaries.

## 5. Required persisted calculation structures

The following structures may be implemented as tables or versioned equivalents. Names are recommended contracts.

### 5.1 `fc_estimate.treatment_components`

Minimum fields:

| Field | Meaning |
|---|---|
| `estimate_id` | Parent estimate |
| `component_id` | Stable treatment component identifier |
| `clinical_concept_id` | Canonical clinical treatment |
| `component_type` | Procedure, medical management, or package |
| `billing_mode` | Package or open |
| `package_code` | Package identity when applicable |
| `session_key` | Evidence-backed sitting/session identifier |
| `full_eligible_amount` | Amount before multi-treatment adjustment |
| `treatment_rank` | Rank by full eligible cost within the applicable sitting |
| `treatment_factor` | 1.00, 0.50, 0.25, or configured value |
| `adjusted_amount` | Amount after treatment handling |
| `rule_id` | Applied structured rule |
| `resolution_status` | Resolved, provisional, or review |
| `evidence_jsonb` | Source and mapping evidence |

### 5.2 `fc_estimate.professional_fee_calculations`

Minimum fields:

- `estimate_id`.
- `component_id`.
- `pf_line_id`.
- `pf_role`.
- `doctor_id`.
- `parent_pf_line_id` for dependent PF.
- `base_mode`.
- `base_amount`.
- `rate_type`: percentage, fixed, tariff, per-visit, or override.
- `rate_value`.
- `quantity`.
- `calculated_amount`.
- `rule_id`.
- `rule_version`.
- `source_id`.
- `confidence`.
- `resolution_status`.
- `calculation_trace_jsonb`.

### 5.3 `fc_estimate.stay_day_ledger`

Minimum fields:

- `estimate_id`.
- `stay_date` or projected day number.
- `room_type`: ward, ICU, daycare, or other.
- `within_package_los`.
- `excess_los_day`.
- `eligible_primary_visit_count`.
- `eligible_dmo_count`.
- Evidence or projection source.

### 5.4 `fc_estimate.rule_trace`

Every output must retain:

- Candidate rules considered.
- Rule selected.
- Payer, tariff, surface, treatment, and session inputs used.
- Full and adjusted amounts.
- Exclusions.
- Override details.
- Provisional or review warnings.

## 6. Multi-treatment calculation

### 6.1 General algorithm

1. Resolve all clinical treatment components.
2. Assign each component to an evidence-backed sitting/session.
3. Determine package/open billing mode and full eligible amount.
4. Partition components by sitting.
5. Rank components within each sitting by full eligible cost, highest first.
6. Select the payer-, tariff-, organization-, and surface-specific reduction schedule.
7. Assign one `treatment_factor` to every component.
8. Calculate the adjusted treatment amount.
9. Carry the same factor into the component’s PF base exactly once.

Do not reduce the treatment amount and then reduce the resulting PF a second time.

### 6.2 Cash

Rule ID: `MT-CASH-001`

- Every treatment and procedure is valued at 100%.
- Every package uses its full applicable cash-package value.
- `treatment_factor = 1.00` for every component, irrespective of sitting count.
- Doctor- or package-specific PF rules remain independently applicable.

### 6.3 Non-GIPSA insurance, same sitting

Rule ID: `MT-NGI-SAME-001`

Apply by descending full eligible cost:

| Rank | Factor |
|---:|---:|
| 1 | 1.00 |
| 2 | 0.50 |
| 3 | 0.25 |
| 4 and above | 0.25 |

This rule is active and historically validated for comparable two-package cases.

### 6.4 Non-GIPSA insurance, different sittings

Rule ID: `MT-NGI-DIFF-001`

- Each treatment/package in a separately evidenced sitting is valued at 100%.
- `treatment_factor = 1.00` for every sitting’s primary component.
- Policy status is active; retain the session evidence in the rule trace.

### 6.5 GIPSA insurance

Rule IDs: `MT-GIPSA-SAME-001` and `MT-GIPSA-DIFF-001`

- First resolve the active TR290/package agreement and its effective date.
- Use the agreement-specific multi-package schedule when available.
- The initial same-sitting policy default is 1.00, 0.50, 0.25, 0.25.
- The initial different-sitting policy default is 1.00 for every separately evidenced sitting.
- If no agreement-specific schedule is registered, mark the calculation `PROVISIONAL_POLICY` and expose the warning in the estimate.
- Do not present the default as historically certified GIPSA behavior.

### 6.6 Corporate

Rule ID: `MT-CORP-001`

- Use organization-specific agreements.
- Do not inherit Cash, GIPSA, or Non-GIPSA rules automatically.
- If no rule exists, route the treatment component to review and show its full unadjusted amount as context only.

## 7. Mixed package/open treatment handling

### 7.1 Package is the primary/higher-value treatment

Rule ID: `MT-MIX-PKG-PRIMARY-001`

1. Apply the full applicable package amount to the primary package.
2. Determine the open treatment’s full eligible amount under the applicable tariff.
3. Apply the secondary/tertiary treatment factor.
4. For the documented “percentage of primary package” method, calculate:

   `open_component_cap = primary_package_adjusted_amount × treatment_factor`

5. Use:

   `adjusted_open_amount = min(open_full_eligible_amount, open_component_cap)`

The cap prevents a reduced secondary treatment from exceeding its own full eligible open value. Store both values in the calculation trace.

### 7.2 Open treatment is the primary/higher-value treatment

Rule ID: `MT-MIX-OPEN-PRIMARY-001`

- Build the relevant treatment bill using open-tariff logic.
- Do not add the lower package rate on top of the open bill.
- If the TPA explicitly asks for package segregation, apply a sourced manual/TPA override and retain both pre- and post-override values.

### 7.3 Unresolved component separation

Rule ID: `MT-MIX-REVIEW-001`

If the Builder cannot reliably separate package and open components:

- Route the scenario correctly as `PACKAGE_PLUS_OPEN`.
- Do not invent the secondary amount.
- Display a review-required estimate range or unresolved component warning.
- Preserve all candidate mappings and values.

## 8. Medical management plus surgical treatment

### 8.1 Open surgery

Rule ID: `MT-MED-SURG-OPEN-001`

- Build a treatment-period ledger separating medical-management and surgical periods.
- Apply the relevant open tariff to billable lines.
- Assign each PF and service line to its supported treatment period.
- Do not double count a line across medical and surgical components.

### 8.2 Package surgery, package is primary

Rule ID: `MT-MED-SURG-PKG-001`

- Apply the surgical package.
- Remove package-covered items from separately billed components.
- Assign medical-management-period items outside the package component.
- Bill those medical items separately only when the applicable agreement permits it.
- Keep contractual package terms separate from empirical historical behavior.

### 8.3 Medical management is primary

Rule ID: `MT-MED-PRIMARY-001`

- Use open billing for the relevant admission unless the payer requests package segregation.
- A later package conversion must be recorded as a TPA/manual override.

### 8.4 Required period evidence

Use, in order:

1. Service/clinical occurrence date.
2. OT or cath-lab date and session.
3. Package start/end evidence.
4. Admission-note and treatment-plan evidence.
5. Manual review.

`bill_at` alone must not be treated as the clinical service date where `service_at` is missing.

## 9. Professional-fee rules

### 9.1 PF rule selection precedence

Rule ID: `PF-SELECT-001`

1. Approved doctor-specific rule.
2. Package-specific fixed PF.
3. Payer/tariff/organization-specific rule.
4. Treatment-family rule.
5. Approved general fallback.
6. Review with historical distribution as context.

### 9.2 Surgeon PF denominator

Rule ID: `PF-BASE-001`

The surgeon fee being calculated must not be included in its own denominator.

For open billing:

`surgeon_fee = surgeon_rate × eligible_bill_excluding_current_surgeon_fee_and_cross_consultations`

The calculation trace must list every included and excluded amount. Never calculate the percentage from a total that already includes the same surgeon fee.

If assistant-surgeon or anaesthesia fees are defined as children of the surgeon fee and are included in the surgeon denominator, solve the dependency simultaneously rather than using calculation order.

For one surgeon:

- `B` = all eligible denominator amounts other than the surgeon fee and its directly dependent PF lines.
- `a` = assistant-surgeon coefficient relative to surgeon PF.
- `n` = anaesthetist coefficient relative to surgeon PF.
- `q` = assistant-anaesthetist coefficient relative to anaesthetist PF.
- `r` = surgeon PF rate.
- `d = a + n + (q × n)`.

Then:

`surgeon_fee = (r × B) / (1 - (r × d))`

Apply this simultaneous formula only when the selected policy explicitly includes the dependent PF lines in the surgeon denominator. Otherwise use the ordinary non-circular formula and record `base_mode = EXCLUDE_DEPENDENT_PF`.

### 9.3 Open surgeon PF

| Rule ID | Route/surface | Default | Status |
|---|---|---:|---|
| `PF-SURG-CASH-OPEN-001` | Cash | 25% | Active and historically supported |
| `PF-SURG-LAN-OPEN-001` | LAN/estimate | 25% | Active and historically supported |
| `PF-SURG-INS-FINAL-001` | Final insurance | 35% | Configurable hospital policy; agreement may override |
| `PF-SURG-CORP-OPEN-001` | Corporate | Organization-specific | No universal fallback |

Honorary and doctor-specific agreements override these defaults.

### 9.4 Package surgeon PF

| Rule ID | Route | Default | Status |
|---|---|---:|---|
| `PF-SURG-GIPSA-PKG-001` | GIPSA | 20% of adjusted package amount | Active and historically supported |
| `PF-SURG-NGI-PKG-001` | Non-GIPSA | 25% of adjusted package amount | Active and historically supported |
| `PF-SURG-CASH-PKG-001` | Cash | Package/doctor-specific fixed amount or rate | No universal percentage |
| `PF-SURG-CORP-PKG-001` | Corporate | Organization/package-specific | No universal fallback |

For multiple packages, calculate package PF separately on every adjusted package component and then sum the results.

### 9.5 Multi-treatment PF adjustment

Rule ID: `PF-MULTI-001`

- Every PF line must be linked to a treatment component.
- Calculate PF from the component’s adjusted base.
- The component’s treatment factor must be applied exactly once.
- Package PF uses the adjusted package amount.
- Open PF uses the adjusted eligible open-treatment base.

### 9.6 Physician PF

Rule ID: `PF-PHYS-001`

Cash:

- Use doctor-specific percentage or fixed-visit rules.
- Where an approved 10% rule applies, calculate it from its explicitly defined eligible base.
- Do not assume 10% for every physician.

Insurance medical management:

- Primary physician: one ward visit per eligible day.
- Primary physician: two ICU visits per eligible day.
- Additional/cross consultant: normally one tariffed visit per consultant per day unless a specific rule supports more.

### 9.7 Assistant physician

Rule ID: `PF-ASST-PHYS-001`

- Do not use a universal 10% formula.
- For insurance, use the applicable tariffed assistant-physician service rate, including service `DM163` where applicable.
- Historical median is 50% of the paired primary-physician visit rate, but the tariff rate—not the empirical median—is authoritative.
- For Cash, use the doctor-specific or approved fixed rule.

### 9.8 DMO

Rule ID: `PF-DMO-001`

- Use the applicable tariff/fixed DMO rate.
- Quantity is once per eligible billing day, not automatically once per raw LOS day.
- Derive eligible days from the stay-day ledger and hospital applicability rules.
- Do not assume that both admission and discharge boundary days are chargeable.

### 9.9 Assistant surgeon and anaesthesia

| Rule ID | Route/surface | Assistant surgeon | Anaesthetist | Assistant anaesthetist |
|---|---|---:|---:|---:|
| `PF-DEP-LAN-001` | Cash/LAN | 15% of surgeon | 25% of surgeon | 25% of anaesthetist |
| `PF-DEP-INS-FINAL-001` | Final insurance | 25% of surgeon | 35% of surgeon | 25% of anaesthetist |

The LAN values are historically supported. Final-insurance values are configurable policy rules and may be overridden by the payer agreement.

### 9.10 Anaesthesia-type gate

Rule ID: `PF-ANAESTH-GATE-001`

- Verified local anaesthesia: anaesthetist and assistant-anaesthetist PF are zero unless a separately documented service justifies them.
- Verified GA/regional/sedation: apply the configured anaesthesia rule.
- Unknown anaesthesia type: do not infer zero; mark the PF line unresolved or use an approved estimate assumption visibly.

Anaesthesia type precedence:

1. Anaesthesia/OT record.
2. Structured clinical record.
3. Approved manual selection.
4. Procedure wording only as candidate evidence, never as the sole production fact.

### 9.11 Multiple surgeons

Rule ID: `PF-MULTI-SURG-001`

- Preserve each surgeon as a separate PF line.
- Package-plus-package PF is calculated from each applicable adjusted package component.
- Open-treatment allocation must follow the doctor-specific agreement or approved manual allocation.
- The suggested 35–40% combined level is a soft warning, not an automatic cap.
- Any enforced cap or split requires a sourced rule or approved override.

### 9.12 Cross-consultations and physiotherapy

Rule ID: `PF-CROSS-001`

- Cross-consultations use the applicable tariff and supported visit quantity.
- Physiotherapy uses the applicable per-session tariff.
- Cross-consultation amounts are excluded from the surgeon PF base where the selected surgeon rule requires that exclusion.

## 10. Extended package LOS

### 10.1 Excess-day calculation

Rule ID: `LOS-EXCESS-001`

`excess_los_days = max(0, projected_billable_los - applicable_package_los)`

Do not use only the admission-level difference when ward/ICU distribution is available. Build excess days from the stay-day ledger.

### 10.2 Post-package surgeon visits

Rule ID: `LOS-SURG-001`

- The package surgeon PF covers the applicable package LOS.
- Add one tariffed/fixed surgeon visit for every eligible excess day.
- Do not recalculate the full package surgeon percentage merely because LOS is exceeded.

### 10.3 Post-package physician visits

Rule ID: `LOS-PHYS-001`

- Excess ward day: one primary-physician visit.
- Excess ICU day: two primary-physician visits.
- Cross consultants follow their tariffed visit rules.

Example:

- Package LOS: five days.
- Projected stay: seven days.
- Excess distribution: one ward day and one ICU day.
- Surgeon excess visits: two.
- Primary physician excess visits: three, one ward plus two ICU.

### 10.4 Historical evidence handling

The historical evidence strongly supports the presence of post-package consultation charging. Exact quantity comparisons are less reliable because many historical PF lines contain `bill_at` without the true `service_at`. Runtime calculation must therefore use the projected stay-day ledger rather than reproducing bill-entry timestamps.

## 11. Overrides and adjustments

### 11.1 Allowed override types

- Doctor-specific approved PF.
- Honorary-doctor arrangement.
- Management-approved additional PF.
- TPA-requested package segregation.
- Final TPA reduction.
- Approved multiple-surgeon split or cap.
- Anaesthesia-type correction.
- Session/sitting correction.

### 11.2 Override requirements

Every override must include:

- Override type.
- Original calculated amount.
- Revised amount.
- Reason.
- Source/reference.
- User/approver.
- Timestamp.
- Rule version superseded.

The original governed calculation must remain visible and recoverable.

TPA reductions and doctor-requested additions occur after the base governed calculation. They must not overwrite the base rule result.

## 12. Rule status and estimate behavior

Use the following statuses:

| Status | Runtime behavior |
|---|---|
| `ACTIVE_VALIDATED` | Apply automatically |
| `ACTIVE_POLICY` | Apply automatically and show policy provenance |
| `PROVISIONAL_POLICY` | Apply configured default and show visible provisional warning |
| `CONTEXT_REQUIRED` | Do not calculate until required context is supplied |
| `REVIEW_REQUIRED` | Preserve candidates; do not publish a false precise amount |
| `OVERRIDDEN` | Publish approved override and retain original calculation |

The Builder must never hide a provisional or review status from the estimate trace.

## 13. Configuration requirements

Store versioned rules in `fc_curated.guideline_rules` and `fc_curated.professional_fee_rules`. Add structured multi-treatment configuration if not already present.

Each executable rule must include:

- Stable rule ID.
- Version.
- Payer bucket.
- Billing surface.
- Tariff and organization scope.
- Treatment/package scope.
- Doctor scope where applicable.
- Rate type and value.
- Base mode.
- Effective-from/effective-to dates.
- Source ID.
- Confidence.
- Status.
- Approval metadata.

Never hard-code percentages only in application code.

## 14. Calculation sequence

The implementation order is mandatory:

1. Resolve payer, organization, tariff, and billing surface.
2. Resolve clinical treatment components.
3. Resolve package/open status for every component.
4. Resolve sittings/sessions.
5. Determine full eligible component amounts.
6. Rank same-sitting components and apply treatment factors.
7. Resolve package inclusions/exclusions and medical/surgical periods.
8. Build the projected stay-day ledger.
9. Calculate base surgeon/physician PF.
10. Calculate dependent assistant and anaesthesia PF.
11. Add excess-LOS visits.
12. Add tariffed cross-consultations and physiotherapy.
13. Apply approved overrides and TPA adjustments.
14. Run validation checks.
15. Publish estimate totals, ranges, warnings, and complete rule trace.

## 15. Validation rules

Reject or flag the estimate when any of the following occurs:

- Treatment component has no canonical identity.
- Package has no applicable rate for payer/tariff/room/effective date.
- Same-sitting reduction is applied without session evidence.
- One treatment factor is applied more than once.
- Package and open amounts double count the same service line.
- Surgeon PF denominator contains the surgeon fee itself.
- Dependent PF creates an unresolved circular calculation.
- Local anaesthesia is inferred only from ambiguous procedure wording.
- Overstay visits are added within package LOS.
- Corporate logic falls through to an unrelated payer rule.
- Provisional GIPSA rules are published without a warning.
- An override has no source or approval record.

## 16. Acceptance tests

### 16.1 Multi-treatment tests

1. Cash, two treatments in one sitting:
   - Expected factors: 1.00 and 1.00.
2. Non-GIPSA, two ₹100,000 packages in one sitting:
   - Expected amounts: ₹100,000 and ₹50,000.
3. Non-GIPSA, three ₹100,000 packages in one sitting:
   - Expected amounts: ₹100,000, ₹50,000, and ₹25,000.
4. Non-GIPSA, two procedures on the same date but different OT session keys:
   - Expected factors: 1.00 and 1.00.
5. GIPSA without agreement-specific schedule:
   - Apply configured policy default.
   - Expected status: `PROVISIONAL_POLICY`.
6. Corporate without organization-specific rule:
   - Expected status: `REVIEW_REQUIRED`.

### 16.2 Mixed billing tests

1. Primary package ₹200,000; secondary open full value ₹80,000; factor 0.50:
   - Cap: ₹100,000.
   - Adjusted open amount: ₹80,000.
2. Primary package ₹200,000; secondary open full value ₹150,000; factor 0.50:
   - Cap: ₹100,000.
   - Adjusted open amount: ₹100,000.
3. Open treatment is primary:
   - Expected: open bill only; no additional package amount.

### 16.3 PF tests

1. Cash open surgeon:
   - Rate: 25%.
   - The calculated surgeon fee must not occur in its own base.
2. GIPSA package ₹200,000:
   - Surgeon PF: ₹40,000 before overrides.
3. Non-GIPSA package ₹200,000:
   - Surgeon PF: ₹50,000 before overrides.
4. Secondary Non-GIPSA package adjusted to ₹100,000:
   - Package PF uses ₹100,000, not the original full package value.
5. Insurance assistant physician:
   - Use the tariff service rate.
   - A 10% generic calculation must fail the rule-selection test.
6. Verified local anaesthesia:
   - Anaesthetist PF: zero unless a separately sourced exception exists.
7. Unknown anaesthesia type:
   - Expected status: `CONTEXT_REQUIRED` or visible approved assumption.

### 16.4 Extended-stay tests

1. Stay within package LOS:
   - No excess surgeon/physician visits.
2. Two ward days beyond package LOS:
   - Surgeon visits: two.
   - Primary physician visits: two.
3. One ward and one ICU day beyond package LOS:
   - Surgeon visits: two.
   - Primary physician visits: three.
4. Excess days entered only through `bill_at` without a stay-day ledger:
   - Do not infer exact room/day visit quantities silently.

### 16.5 Historical regression tests

- Reproduce the 100/50 pattern for the 70 validated Non-GIPSA equal-rate same-sitting pairs.
- Preserve the post-package consultation presence pattern for the validated overstay cohort.
- Confirm package PF distributions remain centred at 20% for GIPSA and 25% for Non-GIPSA.
- Confirm insurance assistant-physician calculations use tariff rates and do not default to 10%.
- Compare LAN and final-insurance outputs separately.

## 17. Builder output requirements

The user-facing estimate and developer trace must show:

- Payer and billing surface.
- Each treatment component.
- Package/open classification.
- Same/different sitting status and evidence.
- Full amount, factor, and adjusted amount.
- Every PF role, base, rate, quantity, and amount.
- Package LOS and excess ward/ICU days.
- Active rule IDs and versions.
- Provisional, context-required, and review warnings.
- Overrides and before/after values.

A single unexplained “PF amount” or “multi-treatment adjustment” field is not acceptable.

## 18. Initial production activation matrix

Activate immediately:

- Cash treatment factor 100%.
- Non-GIPSA same-sitting factors 100/50/25/25.
- Non-GIPSA different-sitting factors 100% per sitting.
- Cash/LAN open surgeon PF at 25%.
- GIPSA package surgeon PF at 20%.
- Non-GIPSA package surgeon PF at 25%.
- Insurance assistant-physician tariff lookup.
- Excess-package-LOS consultation calculation.
- Cash/LAN assistant-surgeon and anaesthesia relationships.
- Verified-local-anaesthesia gate.

Activate as configurable policy with visible status:

- GIPSA multi-treatment default schedule.
- Final-insurance open surgeon PF at 35%.
- Final-insurance assistant surgeon at 25%.
- Final-insurance anaesthetist at 35%.
- Different-sitting full-value treatment where session evidence is available.

Keep review/override driven:

- Corporate without an organization-specific agreement.
- Honorary or doctor-discretion arrangements without structured rules.
- Multiple-surgeon split or 35–40% soft cap.
- Package-plus-open cases without reliable component separation.
- Medical/surgical cases without supported treatment-period allocation.
- TPA-negotiated reductions and package segregation.
- Anaesthesia type that cannot be positively resolved.

## 19. Source references

- `Reyvant - General Doc 6 (6).docx`: hospital guidance covering PF, multiple treatments, package/open treatment, and extended LOS.
- `Billing Checklist-training.xlsx - Professional Charges (LAN).csv`: LAN professional-charge logic.
- `fc_clean.v_ip_clean`: clean historical IP cohort.
- `mart.main_table.services_json`: historical service/PF evidence; frequently a LAN or approximate surface.
- `mart.main_table.ot_json`: historical OT/session evidence.
- `fc_clean.v_package_rates_current`: current package-rate reference.
- `fc_clean.v_package_master`, inclusions, exclusions, and applicability views.
- `fc_clean.v_payer_organization_tariff`: payer and tariff routing.
- `fc_curated.guideline_rules` and `fc_curated.professional_fee_rules`: structured runtime governance.

## 20. Definition of done

The implementation is complete only when:

- All calculations use versioned structured rules.
- Every treatment and PF line has component-level lineage.
- Same-sitting reduction requires session evidence.
- PF bases are inspectable and exclude the PF being calculated.
- Package LOS overstay uses ward/ICU day evidence.
- LAN and final-insurance surfaces are independently testable.
- Provisional and manual logic remains visible.
- Historical regression and synthetic acceptance tests pass.
- No unresolved material scenario is published as a falsely precise production estimate.
