/**
 * Core estimate pipeline — orchestrates cohort → artifacts → controls → line items
 * (docs 03/04/09/10/14-17 + spec/BUILD_SPEC.md).
 */
import { query } from '../../db/pool.js';
import { resolveTariff } from '../resolve/payorTariff.js';
import { payorBucketCounts, resolveBasis } from '../resolve/payerBasis.js';
import { getCohort } from './cohort.js';
import {
  fetchCohortRows, basisCohorts, buildBasisSummary, buildServiceStats,
  buildPharmacyStats, buildActualBasisMetrics, buildPfPayorSummary,
  buildOtSlotMatrix, buildOrgDirectory, tariffRateLookup, pharmacyCatalogNames,
} from './artifacts.js';
import {
  cleanServiceRows, splitCleanedRows, prioritizeOptionalRows, splitRoboticOptional,
  roboticPresenceRate, roboticDefaultSelection, buildGroupingGaps, buildGroupedResidualCandidates,
} from './services.js';
import {
  buildOtConsumableShortlist, otConsumablesApplied, buildImplantHierarchy, resolveImplantEstimate,
} from './advanced.js';
import { resolveDrivers, computeLineItems } from './lineItems.js';
import { serviceLineCountAlert } from './rules.js';
import { packageOfferForEstimate } from '../packages/packages.service.js';
import { parseCoverage, applyCoverage, dedupeVariants, splitVariants } from '../packages/coverage.js';
import { settle, settleWithPackage } from '../insurance/settlement.js';

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

  // 5. cohort + artifacts
  const cohortDef = await getCohort(input.clinical.procedure);
  const cohortRows = await fetchCohortRows(cohortDef.whereSql, cohortDef.params);
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

  // 7. stats + reference lookups
  const [svcStats, pharmMap, svcMap] = await Promise.all([
    buildServiceStats(cohorts, tariff.tariff_cd), pharmacyMapping(), serviceMapping(),
  ]);
  const catalogNames = await pharmacyCatalogNames();
  const pharmacyStats = buildPharmacyStats(cohorts, catalogNames);
  const rates = await tariffRateLookup(tariff.tariff_cd);
  const otSlotRows = await buildOtSlotMatrix([tariff.tariff_cd]);
  const otSlots = new Map(otSlotRows.map((s) => [`${s.ot_mode}|${s.ot_slot_hours}`, s]));
  const otLadder = [...new Set(otSlotRows.filter((s) => s.ot_mode === 'normal').map((s) => s.ot_slot_hours))];

  const svcStatsForBasis = svcStats.filter((s) => s.basis_label === svcBasis);
  const svcByCode = new Map(svcStatsForBasis.map((s) => [s.item_code, s]));
  const pharmStatsForBasis = pharmacyStats.filter((s) => s.basis_label === pharmBasis);

  // 8. drivers
  const drivers = resolveDrivers(svcBasisRow, {
    icu_basis: controls.icu_basis ?? 'P50', icu_manual: controls.icu_manual,
    ward_basis: controls.ward_basis ?? 'P50', ward_manual: controls.ward_manual,
    ot_hours_basis: controls.ot_hours_basis ?? 'P50', ot_hours_manual: controls.ot_hours_manual,
  }, otLadder);

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
  const roboticPresence = roboticPresenceRate(svcStatsForBasis, procedureCode);
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

  // 12. add-on selection state
  const addOns = optional.map((o) => ({
    code: o.item_code, name: o.item_name, grouping: o.grouping, bucket: o.fc_estimate_bucket,
    presence: o.case_presence_rate,
    q25: o.quantity_p25, q50: o.quantity_p50, q75: o.quantity_p75,
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

  // 16. sections/totals for API consumers
  const bucketTotals = {};
  for (const row of lineItems.rows) {
    const v = row.selected[room.toLowerCase()] ?? row.selected.single;
    bucketTotals[row.bucket] = (bucketTotals[row.bucket] || 0) + v;
  }

  const estimate = {
    resolved_context: {
      payor_bucket: input.payment.payor_bucket,
      pricing_mode: pricingMode,
      tariff,
      family: cohortDef.family,
      family_kind: cohortDef.familyKind,
      cohort_case_count: cohortRows.length,
      payer_bases: bases,
      estimate_mode: mode,
      room_type: isDaycare ? 'Daycare (room N/A)' : room,  // display label
      room_key: room.toLowerCase(),                        // machine key into selected{general,twin,single}
      daycare: isDaycare,
      robotic: { selection: roboticSelection, presence_rate: roboticPresence },
      ot_slot: lineItems.rows.find((r) => r.name === 'OT Charges')?.otSlot,
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
    // full artifact payload for the workbook generator
    artifacts: {
      basisSummary, svcStats, pharmacyStats,
      actualMetrics: buildActualBasisMetrics(cohorts),
      pfSummary: buildPfPayorSummary(cohorts),
      otSlotRows, cohortRows, cleaned, autoIncluded, gaps,
      orgDirectory: await buildOrgDirectory(),
    },
    warnings,
    unresolved_items: [],
  };

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

  // 18. package coverage: per-line inclusion status + dual grand totals
  // (only when a package resolved and curated inclusion text exists)
  if (packageOffer?.package?.inclusions_text) {
    try {
      const model = parseCoverage(packageOffer.package.inclusions_text, packageOffer.package.exclusions_text);
      const coverage = applyCoverage(estimate, model);
      const pkgAmt = Number(packageOffer.package.package_amount) || 0;
      coverage.totals.package_amount = pkgAmt;
      coverage.totals.with_package = Math.round((pkgAmt + coverage.totals.payable_extras) * 100) / 100;
      packageOffer.coverage = coverage;
      // deduped display text (curated text may contain 2 source variants)
      const variants = splitVariants(packageOffer.package.inclusions_text);
      packageOffer.package.inclusions_display = variants[0] ?? packageOffer.package.inclusions_text;
      if (variants.length > 1) packageOffer.package.inclusions_variants = variants;
      // insurance settlement over the PACKAGE route (package + settled extras)
      if (input.insurance && input.payment.payor_bucket !== 'Cash') {
        try {
          packageOffer.insurance_settlement = settleWithPackage({
            packageAmount: packageOffer.package.package_amount,
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

  return estimate;
}
