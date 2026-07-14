/**
 * Core estimate pipeline — orchestrates cohort → artifacts → controls → line items
 * (docs 03/04/09/10/14-17 + spec/BUILD_SPEC.md).
 */
import { query } from '../../db/pool.js';
import { resolveTariff } from '../resolve/payorTariff.js';
import { payorBucketCounts, resolveBasis } from '../resolve/payerBasis.js';
import { getCohort, applyCareControls, roboticBaseOf } from './cohort.js';
import {
  fetchCohortRows, basisCohorts, buildBasisSummary, buildServiceStats,
  buildPharmacyStats, buildActualBasisMetrics, buildPfPayorSummary,
  buildOtSlotMatrix, buildOrgDirectory, tariffRateLookup, pharmacyCatalogNames,
} from './artifacts.js';
import {
  cleanServiceRows, splitCleanedRows, prioritizeOptionalRows, splitRoboticOptional,
  roboticPresenceInfo, roboticDefaultSelection, buildGroupingGaps, buildGroupedResidualCandidates,
  isRemoveCategory,
} from './services.js';
import {
  buildOtConsumableShortlist, otConsumablesApplied, buildImplantHierarchy, resolveImplantEstimate,
} from './advanced.js';
import { resolveDrivers, computeLineItems } from './lineItems.js';
import { serviceLineCountAlert } from './rules.js';
import { packageOfferForEstimate } from '../packages/packages.service.js';
import { parseCoverage, applyCoverage, dedupeVariants, splitVariants } from '../packages/coverage.js';
import { settle, settleWithPackage } from '../insurance/settlement.js';
import { round2 } from './stats.js';

async function pharmacyMapping() {
  const { rows } = await query(
    `SELECT item_code, item_name, classification, fc_estimate_bucket, grouping,
            present_in_ip_pharmacy, present_in_ot_pharmacy
     FROM fc.pharmacy_item_mapping`
  );
  return new Map(rows.map((r) => [r.item_code, r]));
}
async function serviceMapping() {
  const { rows } = await query(
    `SELECT item_code, item_name, fc_estimate_bucket, grouping, billing_head, sub_head,
            room_category_dependent
     FROM fc.service_item_mapping`
  );
  return new Map(rows.map((r) => [r.item_code, r]));
}

export async function buildEstimate(input) {
  const warnings = [];
  const controls = input.controls ?? {};

  // 1-4. payor + tariff resolution
  const tariff = await resolveTariff({
    payorBucket: input.payment.payor_bucket,
    organizationCd: input.payment.organization_cd,
  });
  warnings.push(...tariff.warnings);
  if (!tariff.tariff_cd) {
    return { resolved_context: { tariff }, warnings, unresolved_items: ['tariff'] };
  }
  const pricingMode = input.payment.payor_bucket === 'Cash' ? 'Cash / TR1' : 'Insurance / Org Tariff';

  // 5. cohort + artifacts — narrowed by the care-type / setting controls
  const cohortDef = applyCareControls(await getCohort(input.clinical.procedure), controls);
  let cohortRows = await fetchCohortRows(cohortDef.whereSql, cohortDef.params);
  if (!cohortRows.length && cohortDef._careFiltered) {
    // The chosen care type / setting has no cases — fall back to the family's
    // full cohort but keep the template-structure flags the user selected.
    warnings.push('Not enough cases for the chosen care type / setting — priced on the full cohort instead.');
    cohortDef.whereSql = cohortDef._baseWhereSql;
    cohortRows = await fetchCohortRows(cohortDef.whereSql, cohortDef.params);
  }
  if (!cohortRows.length) {
    warnings.push(`No historical cohort found for family ${cohortDef.family}`);
    return { resolved_context: { tariff, family: cohortDef.family }, warnings, unresolved_items: ['cohort'] };
  }
  const cohorts = basisCohorts(cohortRows);
  const basisSummary = buildBasisSummary(cohorts);

  // 6. payer basis (Auto by default; manual override respected)
  const counts = await payorBucketCounts(cohortDef.whereSql, cohortDef.params);
  const target = input.payment.payor_bucket;
  const auto = controls.payer_basis === 'Auto (Recommended)' || !controls.payer_basis;
  const mkBasis = () => (auto
    ? resolveBasis(target, counts, cohortDef.familyKind)
    : { selected_basis: controls.payer_basis, status: 'manual_override', confidence: 'n/a', reason: 'Manual override applied' });
  const bases = { service_basis: mkBasis(), pharmacy_basis: mkBasis(), pf_basis: mkBasis() };
  const svcBasis = bases.service_basis.selected_basis;
  const pharmBasis = bases.pharmacy_basis.selected_basis;
  const basisRowOf = (label) => basisSummary.find((b) => b.basis_label === label);
  const svcBasisRow = basisRowOf(svcBasis);
  const pharmBasisRow = basisRowOf(pharmBasis);

  // 6b. robotic-redirect suggestion (manager approved): GIPSA/Non-GIPSA insurers
  // historically price robotic procedures as the conventional base family's
  // package + a robotic add-on charge. When the robotic cohort is insurance-thin
  // (< 5 cases in the target bucket) but the base family's bucket cohort is
  // solid (>= 5), surface a one-click switch suggestion. Additive field —
  // reuses the payorBucketCounts already computed for the basis; only ONE extra
  // count query (the base family's cohort) when the payor/family gate matches.
  const suggestions = [];
  const roboticBaseFamily = roboticBaseOf(cohortDef.family);
  if (roboticBaseFamily && (target === 'GIPSA Insurance' || target === 'Non-GIPSA Insurance')) {
    const roboticCases = counts.counts[target] || 0;
    if (roboticCases < 5) {
      try {
        const baseDef = await getCohort(roboticBaseFamily);
        const baseCounts = await payorBucketCounts(baseDef.whereSql, baseDef.params);
        const baseCases = baseCounts.counts[target] || 0;
        if (baseCases >= 5) {
          suggestions.push({
            type: 'robotic_redirect',
            base_family: roboticBaseFamily,
            base_label: baseDef.templateName,
            payor_bucket: target,
            message: `${target} historically prices this as ${baseDef.templateName} + robotic add-on`,
            robotic_cases: roboticCases,
            base_cases: baseCases,
          });
        }
      } catch { /* best-effort suggestion — never blocks the build */ }
    }
  }

  // 7. stats + reference lookups
  const [svcStats, pharmMap, svcMap] = await Promise.all([
    buildServiceStats(cohorts, tariff.tariff_cd), pharmacyMapping(), serviceMapping(),
  ]);
  const catalogNames = await pharmacyCatalogNames();
  const pharmacyStats = buildPharmacyStats(cohorts, catalogNames);
  const rates = await tariffRateLookup(tariff.tariff_cd);
  // OT slot ladder: many insurer tariffs carry no "OT - X HOURS" rows at all,
  // which used to leave the ladder empty and silently price OT Charges at ₹0
  // (verified on dev: TR289 Bajaj → ot_slot.hours null, OT row ₹0). Mirror
  // tariffRateLookup's conservative TR1 fallback: ONLY when the org tariff has
  // zero slot rows, price OT on the TR1 (cash) ladder and flag + warn.
  let otSlotRows = await buildOtSlotMatrix(tariff.tariff_cd === 'TR1' ? ['TR1'] : [tariff.tariff_cd, 'TR1']);
  let otSlotTariff = tariff.tariff_cd;
  if (tariff.tariff_cd !== 'TR1') {
    const orgSlots = otSlotRows.filter((s) => s.tariff_code === tariff.tariff_cd);
    if (orgSlots.length) {
      otSlotRows = orgSlots;
    } else {
      otSlotRows = otSlotRows.filter((s) => s.tariff_code === 'TR1').map((s) => ({ ...s, tr1_fallback: true }));
      otSlotTariff = 'TR1';
      if (otSlotRows.length) {
        warnings.push(`Tariff ${tariff.tariff_cd} has no OT hour-slot rates — OT Charges priced on the TR1 (cash) OT slot ladder.`);
      }
    }
  }
  const otSlots = new Map(otSlotRows.map((s) => [`${s.ot_mode}|${s.ot_slot_hours}`, s]));
  const otLadder = [...new Set(otSlotRows.filter((s) => s.ot_mode === 'normal').map((s) => s.ot_slot_hours))];

  const svcStatsForBasis = svcStats.filter((s) => s.basis_label === svcBasis);
  const svcByCode = new Map(svcStatsForBasis.map((s) => [s.item_code, s]));
  const pharmStatsForBasis = pharmacyStats.filter((s) => s.basis_label === pharmBasis);

  // 8. drivers
  const drivers = resolveDrivers(svcBasisRow, {
    los_basis: controls.los_basis ?? 'P50', los_manual: controls.los_manual,
    icu_basis: controls.icu_basis ?? 'P50', icu_manual: controls.icu_manual,
    ward_basis: controls.ward_basis ?? 'P50', ward_manual: controls.ward_manual,
    ot_hours_basis: controls.ot_hours_basis ?? 'P50', ot_hours_manual: controls.ot_hours_manual,
    cath_hours_basis: controls.cath_hours_basis ?? 'P50', cath_hours_manual: controls.cath_hours_manual,
  }, otLadder);
  // Manual cath-lab hours only apply to cath-lab families with parseable billed
  // hours history — surface why the override was ignored instead of silently dropping it.
  if (controls.cath_hours_manual != null) {
    if (cohortDef.rows?.cathLab !== true) {
      warnings.push('Cath Lab hours ignored — this procedure family has no cath-lab charge row.');
    } else if (!(svcBasisRow.cath_hours_p50 > 0) && !(pharmBasisRow.cath_hours_p50 > 0)) {
      warnings.push('Cath Lab hours ignored — no billed cath-lab hour history in this cohort basis; the historical cath-lab amount is used instead.');
    }
  }

  // 9. cleaned services / add-ons / robotic
  const autoTemplate = cohortDef.coreTemplate === 'auto';
  const cleaned = cleanServiceRows(svcStatsForBasis, {
    excludeFixed: !autoTemplate,
    excludeCathLab: cohortDef.excludeCathLabFromTemplate === true,
  });
  const { auto: autoIncluded, optional: optionalRaw } = splitCleanedRows(cleaned);
  const prioritized = prioritizeOptionalRows(optionalRaw);
  const procedureCode = cohortDef.procedure?.code ?? null;
  const { optional, roboticRows } = splitRoboticOptional(prioritized, procedureCode);
  const roboticInfo = roboticPresenceInfo(svcStatsForBasis, procedureCode);
  const roboticPresence = roboticInfo.rate;
  const roboticSelection = controls.robotic && controls.robotic !== 'auto'
    ? (controls.robotic === 'yes' ? 'Yes' : 'No')
    : roboticDefaultSelection('auto', roboticPresence);

  // 10. grouped residuals
  const gaps = buildGroupingGaps(cohortRows, cleaned, svcMap);
  const grouped = buildGroupedResidualCandidates(gaps).map((g) => ({
    ...g,
    selected: (input.selections?.grouped?.[g.grouping]) ?? g.selected,
    insuranceExcluded: false, // grouping-level exclusion needs the insurance policy table (future extension)
  }));

  // 11. advanced pharmacy controls
  const shortlist = buildOtConsumableShortlist(pharmStatsForBasis, pharmMap)
    .map((s) => ({ ...s, selected: (input.selections?.ot_consumables?.[s.item_code]) ?? 'Exclude' }));
  const otApplied = otConsumablesApplied(shortlist, pharmBasisRow);
  const implantHierarchy = buildImplantHierarchy(cohortRows, pharmMap, cohortDef.implantProfile ?? 'knee');
  const implantControls = input.selections?.implants ?? { mode: 'Default P50' };
  const implantResolved = resolveImplantEstimate(implantControls, implantHierarchy, pharmBasisRow);

  // 12. add-on selection state — never offer 'remove'-category rows
  // (room-linked services already priced via the room logic rows)
  const addOns = optional.filter((o) => !isRemoveCategory(o.fc_estimate_bucket, o.grouping)).map((o) => ({
    code: o.item_code, name: o.item_name, grouping: o.grouping, bucket: o.fc_estimate_bucket,
    presence: o.case_presence_rate,
    q25: o.quantity_p25, q50: o.quantity_p50, q75: o.quantity_p75,
    amount: o.amount_cash_typical ?? 0, // typical ₹ contribution when included
    selected: (input.selections?.add_ons?.[o.item_code]) ?? 'Exclude',
  }));

  // 13. line items — daycare families have no ward stay: room selection is N/A
  // (normalized to General internally; totals are room-insensitive for daycare rows)
  const isDaycare = cohortDef.daycare === true;
  const room = isDaycare ? 'General' : (controls.room_type ?? 'Single');
  const mode = controls.estimate_mode ?? 'Typical';
  const lineItems = computeLineItems({
    mode, room, pricingMode,
    emergencyOt: controls.emergency_ot ?? 'No',
    mlc: controls.mlc ?? 'No',
    robotic: roboticSelection,
    drivers, basisRow: pharmBasisRow,
    svc: svcByCode, rates, otSlots,
    insuranceExcluded: new Set(), // seeded from insurance policy table when in insurance mode
    addOns, procedure: cohortDef.procedure,
    includeProcedure: cohortDef.includeProcedure ?? true,
    // 'auto' families derive their template rows from the cohort's default-included items
    templateRows: autoTemplate
      ? autoIncluded.map((r) => ({
        name: r.item_name, bucket: r.fc_estimate_bucket, sub: r.grouping, code: r.item_code,
      }))
      : undefined,
    advanced: { otConsumablesApplied: otApplied },
    implants: { resolvedTypical: implantResolved },
    grouped,
    familyRows: cohortDef.rows,
    ipPharmacyMode: cohortDef.ipPharmacyMode,
    cathLab: cohortDef.rows?.cathLab
      ? { p25: pharmBasisRow.cath_lab_p25 ?? 0, p50: pharmBasisRow.cath_lab_p50 ?? 0, p75: pharmBasisRow.cath_lab_p75 ?? 0 }
      : { p25: 0, p50: 0, p75: 0 },
  });

  // 14. service line count alert
  const baseCount = cohortDef.baseServiceCount ?? (autoIncluded.length + 10);
  const roboticCount = roboticSelection === 'Yes' ? 1 + roboticRows.length : 0;
  const includedAddOns = addOns.filter((a) => a.selected === 'Include').length;
  const currentCount = baseCount + roboticCount + includedAddOns;
  const slcAlert = {
    p25: svcBasisRow.service_line_p25, p50: svcBasisRow.service_line_p50, p75: svcBasisRow.service_line_p75,
    base: baseCount + roboticCount, selectedAddOns: includedAddOns, current: currentCount,
    status: serviceLineCountAlert({ current: currentCount, p25: svcBasisRow.service_line_p25, p75: svcBasisRow.service_line_p75 }),
  };

  // 15. side-by-side package offer (never replaces the itemized estimate)
  let packageOffer;
  try {
    packageOffer = await packageOfferForEstimate({
      cohortRows,
      tariff_cd: tariff.tariff_cd,
      organization_cd: input.payment.organization_cd,
      inputPackage: input.package,
    });
  } catch (err) {
    packageOffer = { status: 'lookup_error', error: err.message, package: null };
  }

  // curated inclusions can concatenate 2 source variants — expose the deduped
  // first variant for display (name|value stays on one line) plus the variants
  if (packageOffer?.package?.inclusions_text) {
    const parts = splitVariants(packageOffer.package.inclusions_text);
    packageOffer.package.inclusions_display = parts[0] ?? packageOffer.package.inclusions_text;
    packageOffer.package.inclusions_variants = parts;
  }

  // 16. sections/totals for API consumers
  const bucketTotals = {};
  for (const row of lineItems.rows) {
    const v = row.selected[room.toLowerCase()] ?? row.selected.single;
    bucketTotals[row.bucket] = (bucketTotals[row.bucket] || 0) + v;
  }

  // historic metrics (manager i6): curated bucket ranges for the selected basis —
  // relevant p25/p50/p75 only, labelled with basis + case count; UI compares
  // them against the live bucket_totals. Computed once, shared with artifacts.
  const actualMetrics = buildActualBasisMetrics(cohorts);
  const pfSummary = buildPfPayorSummary(cohorts);
  const HISTORIC_FIELDS = {
    total_amount_excluding_food_and_beverage_and_returns_plus_drug_admin: 'Gross total',
    pharmacy_total: 'Pharmacy (total)',
    ip_drugs: 'IP Drugs', ip_consumables: 'IP Consumables',
    ot_drugs: 'OT Drugs', ot_consumables: 'OT Consumables', implants: 'Implants',
    professional_fees: 'Professional Fees',
    investigations: 'Investigations',
    procedure_ot_charges: 'Procedure / OT Charges',
    room_charges: 'Room Charges',
    bedside_services: 'Bedside Services',
    ot_hours: 'OT hours',
    los_days: 'Length of stay (days)',
  };
  const metricOf = (basis, field) => actualMetrics.find((r) => r.basis_label === basis && r.field_key === field);
  const historicMetrics = {
    basis: svcBasis,
    basis_confidence: bases.service_basis.confidence,
    case_count: (cohorts[svcBasis] ?? []).length,
    buckets: Object.fromEntries(Object.entries(HISTORIC_FIELDS).flatMap(([field, label]) => {
      const m = metricOf(svcBasis, field);
      return m ? [[field, { label, p25: m.p25, p50: m.p50, p75: m.p75 }]] : [];
    })),
  };

  // PF analysis (manager i6): compare logic-derived PF with the historic P50;
  // if significantly different (>25%) the UI should offer the historic value.
  const logicPf = bucketTotals['Professional Fees'] ?? 0;
  const histPf = metricOf(bases.pf_basis.selected_basis, 'professional_fees');
  const pfDeviation = histPf?.p50 > 0 ? (logicPf - histPf.p50) / histPf.p50 : null;
  const pfAnalysis = pricingMode !== 'Cash / TR1' || !histPf
    ? { applicable: false, reason: pricingMode !== 'Cash / TR1' ? 'PF folded into tariff in insurance mode' : 'no historic PF data' }
    : {
        applicable: true,
        logic_pf: Math.round(logicPf * 100) / 100,
        historic_p50: histPf.p50,
        historic_p25: histPf.p25,
        historic_p75: histPf.p75,
        basis: bases.pf_basis.selected_basis,
        deviation_pct: pfDeviation == null ? null : Math.round(pfDeviation * 1000) / 10,
        significantly_different: pfDeviation != null && Math.abs(pfDeviation) > 0.25,
        recommended: pfDeviation != null && Math.abs(pfDeviation) > 0.25 ? 'historic_p50' : 'logic',
        final_estimate_with_historic_pf: Math.round((lineItems.finalEstimate - logicPf + (histPf.p50 ?? 0)) * 100) / 100,
      };

  // resolved_context.flow (manager model #5, 14-Jul): "the entire flow should
  // only be selected once we have the exact payer AND the treatment". Today the
  // family (treatment) picks the cohort/template and the payer picks tariff,
  // rates and statistical basis — this additive block EXPLAINS every one of
  // those flow decisions so the payer+treatment → flow choice is fully
  // transparent and auditable, even where the logic is still family-driven.
  const basisOut = (b) => ({
    basis: b.selected_basis,
    status: b.status,
    confidence: b.confidence,
    ...(b.case_count != null ? { case_count: b.case_count } : {}),
    reason: b.reason,
  });
  const flow = {
    treatment: {
      family: cohortDef.family,
      label: cohortDef.templateName,
      family_kind: cohortDef.familyKind,
    },
    payer: {
      payor_bucket: target,
      organization_cd: input.payment.organization_cd ?? null,
      organization_name: tariff.organization_name ?? null,
    },
    tariff: {
      tariff_cd: tariff.tariff_cd,
      tariff_name: tariff.tariff_name,
      source: tariff.source,               // cash_default | organization_tariff_mapping
      pricing_mode: pricingMode,
    },
    rates: {
      service_rates_tariff: tariff.tariff_cd,
      tr1_fallback_item_count: rates.tr1FallbackCount ?? 0, // org-tariff gaps back-filled from TR1
      ot_slot_ladder_tariff: otSlotTariff,
      ot_slot_ladder_tr1_fallback: otSlotTariff !== tariff.tariff_cd,
    },
    cohort: {
      scope: 'clinical_family_all_payors', // membership is treatment-wide; the payer enters via component_basis
      case_count: cohortRows.length,
      payor_mix: counts.counts,
      care_filtered: cohortDef._careFiltered === true,
    },
    component_basis: {
      mode: auto ? 'auto' : 'manual_override',
      services: basisOut(bases.service_basis),
      pharmacy: basisOut(bases.pharmacy_basis),
      professional_fees: basisOut(bases.pf_basis),
      drivers: {
        basis: svcBasis,
        note: 'LOS / ICU / ward / OT-hour / cath-hour percentiles ride the service basis',
      },
    },
    template: {
      layout: autoTemplate ? 'auto_from_cohort' : 'fixed_workbook_parity',
      ...(autoTemplate ? { derived_from_basis: svcBasis } : {}),
      row_flags: cohortDef.rows ?? {},
    },
    billing_route: {
      itemized: true, // the itemized (open-billing) estimate is always produced
      package_status: packageOffer?.status ?? 'no_package_exists',
      package_source: packageOffer?.source ?? null,
      package_code: packageOffer?.package?.package_code ?? null,
      package_tariff: packageOffer?.package?.tariff_code ?? null,
    },
    robotic: {
      selection: roboticSelection,
      redirect_suggested: suggestions.some((s) => s.type === 'robotic_redirect'),
      ...(roboticBaseFamily ? { base_family: roboticBaseFamily } : {}),
    },
  };

  const estimate = {
    resolved_context: {
      payor_bucket: input.payment.payor_bucket,
      pricing_mode: pricingMode,
      tariff,
      flow,
      family: cohortDef.family,
      family_kind: cohortDef.familyKind,
      cohort_case_count: cohortRows.length,
      payer_bases: bases,
      estimate_mode: mode,
      room_type: isDaycare ? 'Daycare (room N/A)' : room,  // display label
      room_key: room.toLowerCase(),                        // machine key into selected{general,twin,single}
      daycare: isDaycare,
      robotic: {
        selection: roboticSelection,
        presence_rate: roboticPresence,
        // exact provenance counts (manager i14): robotic charge seen in
        // cases_with_robotic of basis_case_count admissions of the selected
        // service basis — null when no robotic signal row exists in history
        cases_with_robotic: roboticInfo.case_count,
        basis_case_count: roboticInfo.basis_case_count ?? (cohorts[svcBasis]?.length ?? null),
        basis: svcBasis,
      },
      ot_slot: lineItems.rows.find((r) => r.name === 'OT Charges')?.otSlot,
      // cath-lab families only: selected/typical billed cath-lab hours + ₹/hour
      cath_lab: lineItems.rows.find((r) => r.name === 'Cath Lab Charges')?.cathHours ?? null,
    },
    drivers,
    line_items: lineItems.rows,
    subtotal: lineItems.subtotal,
    grand_total: lineItems.grandTotal,
    final_estimate: lineItems.finalEstimate,
    bucket_totals: bucketTotals,
    package_offer: packageOffer, // coverage attached below once final totals exist
    add_ons: addOns,
    grouped_adjustments: grouped,
    advanced_controls: {
      ot_consumables: { shortlist, applied: otApplied, p25: pharmBasisRow.ot_consumables_p25, p50: pharmBasisRow.ot_consumables_p50, p75: pharmBasisRow.ot_consumables_p75 },
      implants: { hierarchy: implantHierarchy, resolved: implantResolved, controls: implantControls, p25: pharmBasisRow.implants_p25, p50: pharmBasisRow.implants_p50, p75: pharmBasisRow.implants_p75 },
    },
    service_line_count: slcAlert,
    historic_metrics: historicMetrics,
    pf_analysis: pfAnalysis,
    // full artifact payload for the workbook generator
    artifacts: {
      basisSummary, svcStats, pharmacyStats,
      actualMetrics,
      pfSummary,
      otSlotRows, cohortRows, cleaned, autoIncluded, gaps,
      orgDirectory: await buildOrgDirectory(),
    },
    warnings,
    unresolved_items: [],
  };
  if (suggestions.length) estimate.suggestions = suggestions; // additive — absent when not applicable

  // 17. insurance settlement: insurer share vs patient share (itemized claim)
  if (input.insurance && input.payment.payor_bucket !== 'Cash') {
    try {
      estimate.insurance_settlement = settle({
        lineItems: lineItems.rows,
        roomKey: room.toLowerCase(),
        drivers,
        insurance: input.insurance,
        grossTotal: lineItems.finalEstimate,
      });
    } catch (err) {
      estimate.insurance_settlement = { error: err.message };
    }
  }

  // Package tariff differs per room type: use the room's tier from
  // room_amounts (derived from fc.package_master.room_rates_jsonb), falling
  // back to the scalar package_amount (= General Ward tier) when the jsonb
  // is missing/empty for that tier.
  const pkgAmountForRoom = (pkg, rk) => Number(pkg?.room_amounts?.[rk] ?? pkg?.package_amount) || 0;

  // 18. package coverage: per-line inclusion status + dual grand totals
  // (only when a package resolved and curated inclusion text exists)
  if (packageOffer?.package?.inclusions_text) {
    try {
      const model = parseCoverage(packageOffer.package.inclusions_text, packageOffer.package.exclusions_text);
      const coverage = applyCoverage(estimate, model);
      const pkgAmt = pkgAmountForRoom(packageOffer.package, room.toLowerCase());
      coverage.totals.package_amount = pkgAmt;
      coverage.totals.with_package = Math.round((pkgAmt + coverage.totals.payable_extras) * 100) / 100;
      packageOffer.coverage = coverage;
      // insurance settlement over the PACKAGE route (package + settled extras)
      if (input.insurance && input.payment.payor_bucket !== 'Cash') {
        try {
          packageOffer.insurance_settlement = settleWithPackage({
            packageAmount: pkgAmt,
            coverageRows: coverage.rows,
            lineItems: lineItems.rows,
            roomKey: room.toLowerCase(),
            drivers,
            insurance: input.insurance,
          });
        } catch (err) {
          packageOffer.insurance_settlement = { error: err.message };
        }
      }
    } catch (err) {
      packageOffer.coverage = { error: err.message };
    }
  }

  // 19. per-room side-by-side data (manager: show all room types at once).
  // Line-item and grand totals already carry all rooms; only the cheap tail —
  // package coverage and insurance settlement — is room-specific, so we replay
  // just that math per room in-memory. NO extra engine work / DB calls.
  if (!isDaycare) {
    const insuranceOn = input.insurance && input.payment.payor_bucket !== 'Cash';
    const model = packageOffer?.coverage && !packageOffer.coverage.error
      ? parseCoverage(packageOffer.package.inclusions_text, packageOffer.package.exclusions_text)
      : null;
    estimate.by_room = {};
    for (const rk of ['general', 'twin', 'single']) {
      // per-room package tariff (room_rates_jsonb tier, scalar fallback)
      const pkgAmt = pkgAmountForRoom(packageOffer?.package, rk);
      const entry = { final_estimate: round2(lineItems.grandTotal.selected[rk] ?? 0) };
      if (model) {
        try {
          const cov = applyCoverage({ ...estimate, resolved_context: { ...estimate.resolved_context, room_key: rk } }, model);
          entry.coverage = {
            package_amount: pkgAmt,
            with_package: round2(pkgAmt + cov.totals.payable_extras),
            payable_extras: round2(cov.totals.payable_extras),
            rows: cov.rows.map((r) => ({ index: r.index, status: r.status, final_amount: r.final_amount })),
          };
        } catch { /* leave coverage off this room */ }
      }
      if (insuranceOn) {
        try {
          const s = settle({ lineItems: lineItems.rows, roomKey: rk, drivers, insurance: input.insurance, grossTotal: lineItems.grandTotal.selected[rk] ?? 0 });
          if (!s.error) entry.settlement = {
            insurer_total: s.insurer_total, patient_total: s.patient.total,
            top_up_claim: s.top_up_claim,
            patient: s.patient, // full breakdown: nme, copay, proportionate_deduction, sub_limit_overflow, room_upgrade_excess, beyond_cover
          };
          if (model) {
            const ps = settleWithPackage({ packageAmount: pkgAmt, coverageRows: (entry.coverage?.rows ?? []).map((r) => ({ ...r })), lineItems: lineItems.rows, roomKey: rk, drivers, insurance: input.insurance });
            if (!ps.error) entry.package_settlement = { insurer_total: ps.insurer_total, patient_total: ps.patient_total };
          }
        } catch { /* leave settlement off this room */ }
      }
      estimate.by_room[rk] = entry;
    }
  }

  return estimate;
}
