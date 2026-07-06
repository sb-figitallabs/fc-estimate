# Professional Fee Logic

This document explains how professional-fee behavior should be treated in the strengthened non-package FC handoff.

## Core Principle

PF is not uniform across all finalized non-package builders.

The handoff should distinguish between:
- implementation-target PF logic
- review-only PF context

The developer should not assume one PF model applies identically to every family.

## Reviewed Family Split

From `scripts_reference/export_fc_professional_fee_analysis.py`, reviewed family behavior is:

Implementation-target or modeled-PF compare families:
- `robotic_tkr_unilateral_right`
- `robotic_tkr_unilateral_left`
- `robotic_tkr_bilateral`
- `total_hip_replacement_thr_hemiarthroplasty`

Review-only PF families:
- `general_medical_management`
- `chemotherapy_systemic_therapy_infusion`
- `chemotherapy_systemic_therapy_infusion_daycare_surgical`
- `chemotherapy_systemic_therapy_infusion_daycare_medical`
- `chemotherapy_systemic_therapy_infusion_daycare_all`
- `coronary_angio_cag_cat_1_daycare_surgical`
- `coronary_angio_cag_cat_1_daycare_all`

## What “Implementation-Target” Means Here

For the reviewed surgical implant-heavy families:
- PF is part of the estimate conversation, not only an offline review artifact
- modeled PF is compared against historical PF context
- workbook flows carry explicit surgeon / assistant / anesthetist-style PF fields

This does not mean PF is entirely tariff-driven.
It means the builder intentionally exposes PF inputs and historical context as part of the estimate logic.

## What “Review-Only” Means Here

For reviewed medical and daycare families:
- PF is preserved as historical context
- PF can inform review and validation
- PF is not a mandatory fully-modeled estimate component in the same way as the reviewed surgical families

The UI can still surface PF context, but should not invent a stronger PF estimate branch than what the reviewed finalized builder actually used.

## Reviewed PF Components

Observed PF analysis breaks down PF into:
- collectible historical total
- named PF total
- general-needed total
- surgeon named total
- assistant surgeon named total
- anesthetist named total
- assistant anesthetist named total
- consultant / physician named total

The reviewed outputs also track:
- p25
- p50
- p75
- dominant PF shape

## Payor-Basis Interaction

PF basis is resolved through the same basis-selection framework as other components:
- `Cash`
- `GIPSA Insurance`
- `Non-GIPSA Insurance`
- `Corporate`
- `Insurance All`
- `All Payers`

But PF can resolve to a different basis than service or pharmacy when cohorts differ.

The developer should preserve PF basis as its own component-level resolved field.

## Estimate Behavior Expectations

For modeled-PF compare families:
- preserve explicit PF inputs where the finalized builder exposed them
- preserve historical p25 / p50 / p75 PF context
- preserve the resolved PF basis
- make clear whether the displayed PF total is user-entered, historically guided, or mixed

For review-only families:
- preserve historical PF context and payor-basis evidence
- do not force a synthetic PF formula into the estimate body if the finalized builder did not

## Surgical Vs Medical Guidance

Surgical non-daycare:
- strongest reviewed PF modeling behavior
- named-role PF breakdown is most relevant

Surgical daycare:
- preserve PF context, but only elevate it if the reviewed finalized family uses it materially

Medical non-daycare:
- PF is generally more review-oriented in the reviewed sources

Medical daycare:
- PF should remain contextual unless a reviewed family explicitly promotes it into estimate logic

## UI Guidance

Recommended UI treatment:
- show PF as a separate section
- show resolved PF basis
- show p25 / p50 / p75 historical PF context
- show role-based PF inputs only where the family uses them
- label review-only PF clearly so the user does not mistake it for a fully modeled estimate branch

## Source Evidence

Primary source-of-truth references:
- `scripts_reference/export_fc_professional_fee_analysis.py`
- `scripts_reference/build_general_medical_management_cash_fc_estimate_builder.py`
- `scripts_reference/build_chemotherapy_cash_fc_estimate_builder.py`
- `scripts_reference/export_robotic_tkr_fc_estimate_builder.py`
