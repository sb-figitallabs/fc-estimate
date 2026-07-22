/**
 * Core estimate pipeline — orchestrates cohort → artifacts → controls → line items
 * (docs 03/04/09/10/14-17 + spec/BUILD_SPEC.md).
 */
import { query } from '../../db/pool.js';
import { resolveTariff } from '../resolve/payorTariff.js';
import { payorBucketCounts, resolveBasis } from '../resolve/payerBasis.js';
import { getCohort, applyCareControls, roboticBaseOf, roboticAddonItemsOf } from './cohort.js';
import {
  fetchCohortRows, basisCohorts, buildBasisSummary, buildServiceStats,
  buildPharmacyStats, buildActualBasisMetrics, buildPfPayorSummary,
  buildOtSlotMatrix, buildOrgDirectory, tariffRateLookup, pharmacyCatalogNames,
  shortStayBucketQuartiles, P6_SHORT_STAY_MIN_CASES,
} from './artifacts.js';
import {
  cleanServiceRows, splitCleanedRows, prioritizeOptionalRows, splitRoboticOptional,
  roboticPresenceInfo, roboticDefaultSelection, buildGroupingGaps, buildGroupedResidualCandidates,
  isRemoveCategory, isRoboticText, isRoboticWording, resolveRoboticAddonPricing, ROBOTIC_PROMPT_THRESHOLD,
  roomMatchedPfFallback,
} from './services.js';
import {
  buildOtConsumableShortlist, otConsumablesApplied, buildImplantHierarchy, resolveImplantEstimate,
} from './advanced.js';
import { resolveDrivers, computeLineItems } from './lineItems.js';
import { serviceLineCountAlert } from './rules.js';
import { P3_NAMED_DRUG_FAMILIES, p3NamedDrugEnabled, P3_MIN_DRUG_AMOUNT, matchNamedDrugs } from '../ai/namedDrug.js';
import { packageOfferForEstimate, computePackageQuote } from '../packages/packages.service.js';
import { parseCoverage, applyCoverage, dedupeVariants, splitVariants } from '../packages/coverage.js';
import { settle, settleWithPackage } from '../insurance/settlement.js';
import { lookupExpectedNme } from '../insurance/nmeProfile.js';
import { buildEmergencyOverlay } from './emergency.js';
import { buildPositiveCaseOverlay } from './positiveCase.js';
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

  // 7b. package offer — resolved BEFORE the drivers (A1, manager 17-Jul) so
  // the package master's duration can drive the LOS default. Semantics are
  // unchanged from the old step-15 position: gate-driven selection when the
  // doctor's wording is available, cohort-dominant fallback, medical guard.
  const treatmentTextEarly = input.clinical.treatment_text?.trim();
  let packageOffer;
  const noExplicitPackage = !input.package?.package_code && !input.package?.package_name && !input.package?.text;
  // #5 (flow parity): medical-management families never auto-attach a package
  // — same guard as the flow gate. An explicit user-chosen package still wins.
  const medicalNoPackage = noExplicitPackage && cohortDef.familyKind === 'medical';
  if (medicalNoPackage) {
    packageOffer = { status: 'no_package_exists', source: 'medical_family_guard', package: null };
  } else {
  try {
    let inputPackage = input.package;
    let gatePicked = false;
    if (noExplicitPackage) {
      try {
        const { rankPackageCandidates } = await import('../resolve/familyResolve.js');
        // #2 (flow parity): with no doctor's wording, rank on the family's own
        // label — so the build names the same package the flow view would,
        // instead of the cohort-dominant heuristic. Cohort-dominant remains
        // the fallback when ranking finds nothing.
        const rankText = treatmentTextEarly || cohortDef.templateName || cohortDef.family;
        const { candidates } = await rankPackageCandidates({
          treatment: rankText, tariff_code: tariff.tariff_cd, organization_cd: input.payment.organization_cd,
          // B3: an explicit robotic answer biases the pick to the robotic package
          robotic: controls.robotic === 'yes' ? 'yes' : controls.robotic === 'no' ? 'no' : undefined,
        });
        if (candidates[0]) {
          inputPackage = { package_code: candidates[0].package_code, package_name: candidates[0].package_name };
          gatePicked = true;
        }
      } catch { /* gate match unavailable — cohort-dominant fallback below */ }
    }
    packageOffer = await packageOfferForEstimate({
      cohortRows,
      tariff_cd: tariff.tariff_cd,
      organization_cd: input.payment.organization_cd,
      inputPackage,
    });
    if (gatePicked && packageOffer) packageOffer.source = treatmentTextEarly ? 'gate_match' : 'gate_match_family_label';
  } catch (err) {
    packageOffer = { status: 'lookup_error', error: err.message, package: null };
  }
  }

  // A1 (manager 17-Jul): package LOS comes from the package master —
  // package_duration is the stay default when a package is attached and the
  // FC gave no manual stay. 0 = daycare-style package (no LOS default forced;
  // the family's daycare handling applies). Cohort quartiles remain the band.
  const pkgDurRaw = Number(packageOffer?.package?.package_duration);
  const pkgLosDefault = controls.los_manual == null && Number.isFinite(pkgDurRaw) && pkgDurRaw > 0
    ? pkgDurRaw : null;
  let losSource = controls.los_manual != null ? 'manual' : 'cohort_p50';
  if (pkgLosDefault != null) losSource = 'package_master';

  // 8. drivers
  const drivers = resolveDrivers(svcBasisRow, {
    los_basis: pkgLosDefault != null ? 'manual' : (controls.los_basis ?? 'P50'),
    los_manual: controls.los_manual ?? pkgLosDefault ?? undefined,
    icu_basis: controls.icu_basis ?? 'P50', icu_manual: controls.icu_manual,
    ward_basis: controls.ward_basis ?? 'P50', ward_manual: controls.ward_manual,
    ot_hours_basis: controls.ot_hours_basis ?? 'P50', ot_hours_manual: controls.ot_hours_manual,
    cath_hours_basis: controls.cath_hours_basis ?? 'P50', cath_hours_manual: controls.cath_hours_manual,
  }, otLadder);
  if (losSource === 'package_master') {
    warnings.push(`Stay defaulted to the package master's duration — ${pkgDurRaw} day${pkgDurRaw === 1 ? '' : 's'} for [${packageOffer.package.package_code}] (pre ${packageOffer.package.pre_days ?? 0} / post ${packageOffer.package.post_days ?? 0}); cohort history stays as the reference band.`);
  }
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
  let roboticSelection = controls.robotic && controls.robotic !== 'auto'
    ? (controls.robotic === 'yes' ? 'Yes' : 'No')
    : roboticDefaultSelection('auto', roboticPresence);

  // 9b. robotic add-on charge (15-Jul #27). The gate's payor-aware resolution
  // can return "base family + robotic add-on" (GIPSA/Non-GIPSA robotic
  // redirect) — the BUILT estimate must then carry the robotic charge, priced
  // from the payor tariff's contracted robotic item (TR290 "ROBO (TKR) -
  // UNILATERAL" ₹1,20,000) with cohort billed history as fallback. Absent an
  // explicit ask, the per-payor rule (15-Jul #9) drives the default: presence
  // >90% for THIS payor basis ⇒ included; ≥30% ⇒ optional row + convert prompt.
  const treatmentText = input.clinical.treatment_text?.trim();
  const roboticDeclined = controls.robotic === 'no';
  const roboticRequired = !roboticDeclined && (
    input.clinical.robotic_addon === true ||  // gate resolution carried robotic_addon: true
    controls.robotic === 'yes' ||             // caller explicitly asked robotic
    isRoboticWording(treatmentText)           // doctor's wording says robotic (negation-guarded, P2)
  );
  if (roboticRequired) roboticSelection = 'Yes';
  // families whose robotic charge is already priced elsewhere in the build:
  // robotic families carry it on their roboticControlled procedure row; auto
  // families with >90% presence carry it as a default-included template row.
  const roboticOnProcedureRow = (cohortDef.includeProcedure ?? true)
    && /ROBO/i.test(cohortDef.procedure?.label || '');
  const roboticInTemplate = autoTemplate && autoIncluded.some((r) =>
    r.item_code !== procedureCode
    && isRoboticText(r.item_code, r.item_name, r.grouping, r.fc_estimate_bucket));
  let roboticAddon = null;
  if (!roboticOnProcedureRow && !roboticInTemplate && !roboticDeclined) {
    let addonStatus = null, addonReason = null;
    if (roboticRequired) {
      addonStatus = 'included';
      addonReason = input.clinical.robotic_addon === true ? 'gate_robotic_addon'
        : controls.robotic === 'yes' ? 'explicit_robotic_yes' : 'treatment_text_robotic';
    } else if (roboticPresence > 90) {
      addonStatus = 'included';
      addonReason = 'payor_presence_above_90';
    } else if (roboticPresence >= ROBOTIC_PROMPT_THRESHOLD) {
      addonStatus = 'optional';
      addonReason = 'payor_presence_significant';
    }
    if (addonStatus) {
      const pricing = resolveRoboticAddonPricing({
        addonItems: roboticAddonItemsOf(cohortDef.family), roboticRows, rates,
      });
      if (pricing) {
        roboticAddon = { ...pricing, status: addonStatus, included: addonStatus === 'included', reason: addonReason };
        if (roboticAddon.included) roboticSelection = 'Yes';
      } else {
        roboticAddon = {
          status: 'unpriced', included: false, reason: addonReason,
          source: null, item_code: null, item_name: null,
        };
        warnings.push('Robotic add-on applies but neither the payor tariff nor billed history carries a robotic charge to price it — add the amount manually.');
      }
    }
  }

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
    // 15-Jul Q4: session-based families (dialysis, phototherapy, newborn care)
    // suppress LOS-driven room rows — they bill per visit, not per ward day.
    sessionBased: cohortDef.sessionBased === true,
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
    roboticAddon: roboticAddon && roboticAddon.status !== 'unpriced' ? roboticAddon : undefined,
    grouped,
    familyRows: cohortDef.rows,
    ipPharmacyMode: cohortDef.ipPharmacyMode,
    cathLab: cohortDef.rows?.cathLab
      ? { p25: pharmBasisRow.cath_lab_p25 ?? 0, p50: pharmBasisRow.cath_lab_p50 ?? 0, p75: pharmBasisRow.cath_lab_p75 ?? 0 }
      : { p25: 0, p50: 0, p75: 0 },
  });

  // D3 (manager 17-Jul): cross-consultations (diet etc.) are their own thing —
  // tagged and sub-grouped apart from the operating surgeon's PF on every
  // build; the PF scaling/override paths below skip them.
  for (const r of lineItems.rows) {
    if (r.bucket === 'Professional Fees' && /CONSULT/i.test(r.name || '')) {
      r.cross_consult = true;
      r.sub = 'Cross Consultations';
    }
  }

  // 13a. robotic add-on finalization: selected-room amount + convert prompt.
  if (roboticAddon && roboticAddon.status !== 'unpriced') {
    const rk = room.toLowerCase();
    if (roboticAddon.pricing === 'tariff') {
      roboticAddon.amount = roboticAddon.rate?.[rk] ?? roboticAddon.rate?.single ?? 0;
    }
    const fmt = (v) => `₹${Math.round(v ?? 0).toLocaleString('en-IN')}`;
    const srcLabel = roboticAddon.source === 'tariff_contracted'
      ? `contracted on tariff ${tariff.tariff_cd}`
      : roboticAddon.source === 'cohort_history'
        ? `typical billed robotic amount, basis ${svcBasis}`
        : 'TR1 (cash) rate — no contracted robotic item on this tariff';
    if (roboticAddon.included) {
      warnings.push(`Robotic add-on included: ${roboticAddon.item_name} ${fmt(roboticAddon.amount)} (${srcLabel}).`);
    } else {
      roboticAddon.prompt = `${Math.round(roboticPresence)}% of ${svcBasis} cases had robotic — convert to robotic?`;
      warnings.push(`Robotic add-on available (${roboticAddon.item_name} ${fmt(roboticAddon.amount)}, ${srcLabel}): ${roboticAddon.prompt}`);
    }
  }

  // 13b. Insurer PF from the historic P50 (15-Jul answers, Q1): insurer
  // tariffs price Professional Fees at token consultation rates (₹740 vs
  // actual ₹15k–₹1.4L) — "let's use the historic PF P50 for the time being".
  // Every PF line is scaled per room so the bucket lands exactly on the P50
  // and lines still reconcile with totals; bands shift by the same delta.
  const actualMetricsEarly = buildActualBasisMetrics(cohorts);
  let pfSource = 'tariff';
  // Medical-management families (rows.surgical === false) carry a single
  // physician-visits PF row that lineItems leaves at 0 — it is priced here
  // from billed PF history for EVERY pricing mode, Cash included (17-Jul
  // manager feedback #4: the surgical 25% cascade fabricated surgeon fees).
  const medicalPfFamily = cohortDef.rows?.surgical === false;
  // Only medical-management families price PF from billed history (visit-based,
  // all modes). Surgical families — cash AND insurance — now use the rule
  // cascade (manager 21-Jul T1: insurance PF is rule-based FINAL-bill, historic
  // kept as reference only, not the override).
  if (medicalPfFamily) {
    const histPfRow = actualMetricsEarly.find(
      (r) => r.basis_label === bases.pf_basis.selected_basis && r.field_key === 'professional_fees'
    );
    if (histPfRow?.p50 > 0) {
      // D3 (manager 17-Jul): cross-consultations (diet etc.) are handled
      // separately from the operating surgeon's PF — they keep their own
      // amounts and are never scaled/overridden with surgeon PF. The historic
      // target still covers the whole billed PF bucket, so the surgeon-side
      // rows absorb the remainder after the fixed consult amounts.
      const allPfRows = lineItems.rows.filter((r) => r.bucket === 'Professional Fees');
      for (const r of allPfRows) {
        if (/CONSULT/i.test(r.name || '')) { r.cross_consult = true; }
      }
      const consultRows = allPfRows.filter((r) => r.cross_consult);
      const pfRows = allPfRows.filter((r) => !r.cross_consult);
      const roomKeys = ['general', 'twin', 'single'];
      for (const rk of roomKeys) {
        const consultTotal = consultRows.reduce((t, r) => t + (r.selected?.[rk] ?? 0), 0);
        const pfTotal = pfRows.reduce((t, r) => t + (r.selected?.[rk] ?? 0), 0);
        const target = Math.max(0, histPfRow.p50 - consultTotal);
        const delta = target - pfTotal;
        if (!Number.isFinite(delta) || Math.abs(delta) < 1) continue;
        let bandDelta = [delta, delta, delta];
        if (pfTotal > 0) {
          const f = target / pfTotal;
          for (const r of pfRows) if (r.selected?.[rk] != null) r.selected[rk] = Math.round(r.selected[rk] * f * 100) / 100;
        } else if (pfRows[0]?.selected) {
          // no PF lines priced — carry history on the first PF row (net of the
          // fixed cross-consult amounts), bands from quartiles
          pfRows[0].selected[rk] = target;
          const band = [
            Math.max(0, (histPfRow.p25 || histPfRow.p50) - consultTotal),
            target,
            Math.max(0, (histPfRow.p75 || histPfRow.p50) - consultTotal),
          ];
          if (Array.isArray(pfRows[0].cells?.[rk])) pfRows[0].cells[rk] = [...band];
          bandDelta = band;
        } else {
          continue; // no PF rows at all for this family — nothing to scale
        }
        if (Array.isArray(lineItems.grandTotal[rk])) {
          lineItems.grandTotal[rk] = lineItems.grandTotal[rk].map((v, i) => Math.round((v + bandDelta[i]) * 100) / 100);
        }
        if (lineItems.grandTotal.selected?.[rk] != null) {
          lineItems.grandTotal.selected[rk] = Math.round((lineItems.grandTotal.selected[rk] + delta) * 100) / 100;
        }
      }
      lineItems.finalEstimate = lineItems.grandTotal.selected?.[room.toLowerCase()] ?? lineItems.finalEstimate;
      pfRows.forEach((r) => { r.historic_pf = true; });
      pfSource = 'historic_p50';
      warnings.push(medicalPfFamily
        ? `Medical management — Professional Fees priced from billed physician-fee history (P50 ₹${Math.round(histPfRow.p50).toLocaleString('en-IN')}, basis ${bases.pf_basis.selected_basis}); the visit-based fee sheet will refine this.`
        : `Professional Fees priced from the historic P50 (₹${Math.round(histPfRow.p50).toLocaleString('en-IN')}, basis ${bases.pf_basis.selected_basis}) — the insurer tariff carries token PF rates.`);
    }
  }

  // 13c. Historical backfill for empty buckets on medical families (15-Jul
  // answers, Q3 — "could be a good fallback for now"): the itemized template
  // for medical/infusion cohorts often carries NO investigation lines and no
  // drug line (Immunotherapy Pharmacy ₹0 vs actual ₹45k–₹2.3L). When a money
  // bucket is empty but the cohort's history isn't, add ONE clearly-annotated
  // row at the historical P25/P50/P75.
  if (cohortDef.familyKind === 'medical') {
    const BACKFILL = [
      ['investigations', 'Investigations'],
      ['pharmacy_total', 'Pharmacy'],
    ];
    // P6 trivial-stay floor (problems-register-16jul): the backfill quartiles
    // below are whole-cohort medians — stay-independent, so a 1-day medical
    // observation inherited the full cohort's median diagnostics load (NARESH:
    // Investigations ₹20,790 on a ₹7.9k bill, +421%). When the requested LOS
    // sits at/below this basis' P25 stay AND the same-stay-band sub-cohort is
    // rich enough (≥ P6_SHORT_STAY_MIN_CASES), the backfilled buckets price
    // from that sub-cohort's quartiles instead. Medical families only (this
    // block never runs for surgical/daycare familyKind); sub-cohort quartiles,
    // NEVER linear LOS scaling (would gut correct 2–3 day estimates and
    // mis-model fixed per-admission costs). Kill switch: P6_LOS_BANDING=off.
    let shortStay = null;
    // p25 < p50 guard: when the cohort's P25 stay IS its typical stay
    // (P25 == P50), a "short stay" is indistinguishable from a normal one —
    // banding there would move typical-stay estimates, not trivial ones.
    if (process.env.P6_LOS_BANDING !== 'off'
        && Number.isFinite(drivers.los?.p25)
        && drivers.los.p25 < (drivers.los?.p50 ?? drivers.los.p25)
        && (drivers.los?.selected ?? Infinity) <= drivers.los.p25) {
      const band = shortStayBucketQuartiles(
        cohorts[svcBasis], drivers.los.p25, BACKFILL.map(([f]) => f)
      );
      if (band.cases >= P6_SHORT_STAY_MIN_CASES) shortStay = band;
    }
    const modeVal = (p25, p50, p75) => (mode === 'Low' ? p25 : mode === 'Typical' ? p50 : p75);
    for (const [field, bucket] of BACKFILL) {
      const bucketNow = lineItems.rows
        .filter((r) => r.bucket === bucket)
        .reduce((t, r) => t + (r.selected?.single ?? 0), 0);
      const m = actualMetricsEarly.find((r) => r.basis_label === svcBasis && r.field_key === field);
      if (bucketNow > 0 || !(m?.p50 > 0)) continue;
      const band = shortStay?.fields?.[field];
      const residualBasis = shortStay
        ? `short-stay sub-cohort (${shortStay.cases} cases, LOS ≤ P25 ${drivers.los.p25}d)`
        : null;
      if (band && !(band.p50 > 0)) {
        // The typical same-stay-band case had NO such charges — an honest
        // short-stay answer is no backfill row at all, said out loud.
        warnings.push(`${bucket} had no template lines and the ${residualBasis} typically billed none — backfill skipped (whole-cohort P50 would have been ₹${Math.round(m.p50).toLocaleString('en-IN')}, basis ${svcBasis}).`);
        continue;
      }
      const cells = band
        ? [band.p25 ?? band.p50, band.p50, band.p75 ?? band.p50]
        : [m.p25 ?? m.p50, m.p50, m.p75 ?? m.p50];
      const sel = modeVal(...cells);
      lineItems.rows.push({
        index: lineItems.rows.length,
        name: `${bucket} — historical estimate`,
        bucket, sub: bucket, source: 'Historical',
        how: band
          ? `No ${bucket.toLowerCase()} lines in this cohort's template — filled from the ${svcBasis} basis ${residualBasis} P25/P50/P75 of actual bills (requested stay is at/below the cohort's P25).`
          : `No ${bucket.toLowerCase()} lines in this cohort's template — filled from the ${svcBasis} basis P25/P50/P75 of actual bills.`,
        code: null, historical_estimate: true,
        ...(band ? { residual_basis: residualBasis } : {}),
        qty: { selected: 1, low: 1, typ: 1, high: 1 }, rate: {},
        cells: { general: cells, twin: [...cells], single: [...cells] },
        selected: { general: sel, twin: sel, single: sel },
      });
      for (const rk of ['general', 'twin', 'single']) {
        if (Array.isArray(lineItems.grandTotal[rk])) {
          lineItems.grandTotal[rk] = lineItems.grandTotal[rk].map((v, i) => Math.round((v + cells[i]) * 100) / 100);
        }
        if (lineItems.grandTotal.selected?.[rk] != null) {
          lineItems.grandTotal.selected[rk] = Math.round((lineItems.grandTotal.selected[rk] + sel) * 100) / 100;
        }
      }
      lineItems.finalEstimate = lineItems.grandTotal.selected?.[room.toLowerCase()] ?? lineItems.finalEstimate;
      warnings.push(band
        ? `${bucket} had no template lines — filled from the ${residualBasis}: P50 ₹${Math.round(band.p50).toLocaleString('en-IN')} instead of the whole-cohort ₹${Math.round(m.p50).toLocaleString('en-IN')} (basis ${svcBasis}).`
        : `${bucket} had no template lines — filled from historical actuals (P50 ₹${Math.round(m.p50).toLocaleString('en-IN')}, basis ${svcBasis}).`);
    }
  }

  // 13d. P3 (problems-register-16jul): named high-cost drugs invisible to
  // daycare infusion pricing (SHOURYA "DAY CARE INJ STELMA 90 MG IV" -87%).
  // For the explicit infusion-class family whitelist ONLY, a high-confidence
  // pharmacy-master match of a drug named in the treatment wording adds a
  // `named_drug` line (MRP × qty) and REPLACES the cohort pharmacy figure:
  //   pharmacy bucket ← max(cohort pharmacy P50, drug line + non-drug residual)
  // — replace, not add, so cohorts whose history already carries drug spend
  // (chemo/immunotherapy) never double-count: their P50 side of the max()
  // wins and the historic drug rows shrink to the remaining allowance.
  // Non-whitelisted families never enter this block (byte-identical builds);
  // a weak/ambiguous match adds NO line — only a confirm-from-the-pharmacy-
  // list warning. Kill switch: P3_NAMED_DRUG=off.
  let namedDrug = null;
  if (p3NamedDrugEnabled() && P3_NAMED_DRUG_FAMILIES.has(cohortDef.family) && treatmentText) {
    try {
      const nd = await matchNamedDrugs(treatmentText);
      const priced = nd.matches.filter((m) => m.price > 0 && m.qty > 0);
      const drugAmt = round2(priced.reduce((t, m) => t + m.price * m.qty, 0));
      const fmt = (v) => `₹${Math.round(v ?? 0).toLocaleString('en-IN')}`;
      if (priced.length && drugAmt >= P3_MIN_DRUG_AMOUNT) {
        // drug-side pharmacy rows (IP/OT Drugs + the 13c historical backfill
        // row) carry the cohort's historic drug spend — the named drug
        // replaces them up to the max() target; consumables/implants are the
        // "non-drug pharmacy residual" and stay untouched.
        const isDrugSide = (r) => r.bucket === 'Pharmacy'
          && (/DRUGS/i.test(r.name || '') || r.historical_estimate === true);
        const drugRows = lineItems.rows.filter(isDrugSide);
        const nonDrugRows = lineItems.rows.filter((r) => r.bucket === 'Pharmacy' && !isDrugSide(r));
        const pharmMetric = actualMetricsEarly.find((r) => r.basis_label === pharmBasis && r.field_key === 'pharmacy_total')
          ?? actualMetricsEarly.find((r) => r.basis_label === svcBasis && r.field_key === 'pharmacy_total');
        const cohortPharmP50 = pharmMetric?.p50 > 0 ? pharmMetric.p50 : 0;
        const sumSel = (rows, rk) => rows.reduce((t, r) => t + (r.selected?.[rk] ?? 0), 0);
        const math = {};
        for (const rk of ['general', 'twin', 'single']) {
          const drugCur = sumSel(drugRows, rk);
          const nonDrugCur = sumSel(nonDrugRows, rk);
          const current = round2(drugCur + nonDrugCur);
          const candidate = round2(drugAmt + nonDrugCur);
          // never lower an already-larger bucket — max() with `current` too
          const target = Math.max(cohortPharmP50, candidate, current);
          const remaining = round2(Math.max(0, target - drugAmt - nonDrugCur));
          const f = drugCur > 0 ? remaining / drugCur : 0;
          for (const r of drugRows) {
            if (r.selected?.[rk] != null) r.selected[rk] = round2(r.selected[rk] * f);
            if (Array.isArray(r.cells?.[rk])) r.cells[rk] = r.cells[rk].map((v) => round2(v * f));
          }
          const newBucket = round2(drugAmt + nonDrugCur + (drugCur > 0 ? remaining : 0));
          const delta = round2(newBucket - current);
          if (Array.isArray(lineItems.grandTotal[rk])) {
            lineItems.grandTotal[rk] = lineItems.grandTotal[rk].map((v) => round2(v + delta));
          }
          if (lineItems.grandTotal.selected?.[rk] != null) {
            lineItems.grandTotal.selected[rk] = round2(lineItems.grandTotal.selected[rk] + delta);
          }
          math[rk] = {
            previous_bucket: current,
            cohort_pharmacy_p50: round2(cohortPharmP50),
            drug_total: drugAmt,
            non_drug_residual: round2(nonDrugCur),
            candidate,
            new_bucket: newBucket,
            winner: newBucket <= current + 0.01 ? 'unchanged'
              : (candidate >= cohortPharmP50 ? 'named_drug' : 'cohort_p50'),
          };
        }
        for (const m of priced) {
          const amt = round2(m.price * m.qty);
          lineItems.rows.push({
            index: lineItems.rows.length,
            name: `${m.item_name} — named drug`,
            bucket: 'Pharmacy', sub: 'IP Pharmacy',
            source: 'named_drug_mrp', named_drug: true,
            how: `"${m.token}" in the treatment wording matched the pharmacy master (${m.match_kind}); `
              + `${m.price_source === 'mrp' ? 'MRP' : 'sale rate (no MRP on file)'} ${fmt(m.price)} × qty ${m.qty} (${m.qty_source}). `
              + 'Pharmacy bucket = max(cohort pharmacy P50, drug + non-drug residual) — replaced, not added. Confirm drug + qty with the FC.',
            code: m.item_code,
            qty: { selected: m.qty, low: m.qty, typ: m.qty, high: m.qty },
            rate: { general: m.price, twin: m.price, single: m.price },
            cells: { general: [amt, amt, amt], twin: [amt, amt, amt], single: [amt, amt, amt] },
            selected: { general: amt, twin: amt, single: amt },
          });
        }
        lineItems.finalEstimate = lineItems.grandTotal.selected?.[room.toLowerCase()] ?? lineItems.finalEstimate;
        const rm = math[room.toLowerCase()] ?? math.single;
        namedDrug = {
          status: 'applied',
          matches: priced,
          drug_total: drugAmt,
          replace_math: rm,
          ...(nd.ambiguous.length ? { ambiguous_tokens: nd.ambiguous } : {}),
        };
        warnings.push(
          `Named drug priced from the pharmacy master: ${priced.map((m) => `${m.item_name} ${fmt(m.price)} × ${m.qty}`).join('; ')} `
          + `(matched from the treatment wording) — CONFIRM the drug and quantity with the FC before quoting. `
          + `Pharmacy set to max(cohort P50 ${fmt(rm.cohort_pharmacy_p50)}, drug ${fmt(drugAmt)} + non-drug residual ${fmt(rm.non_drug_residual)}) = ${fmt(rm.new_bucket)}.`
        );
      } else if (priced.length) {
        // matched but too small to be the "named high-cost drug" — the cohort
        // P50 already carries routine drug spend; note it, change nothing.
        namedDrug = { status: 'below_threshold', matches: priced, drug_total: drugAmt, threshold: P3_MIN_DRUG_AMOUNT };
      } else if (nd.ambiguous.length || nd.injection_context) {
        namedDrug = {
          status: nd.ambiguous.length ? 'ambiguous' : 'no_confident_match',
          matches: [],
          ...(nd.ambiguous.length ? { ambiguous_tokens: nd.ambiguous } : {}),
          candidates_considered: nd.candidates,
        };
        warnings.push(
          'A drug name may be present in the infusion wording but could not be confidently matched in the pharmacy master — '
          + 'confirm the drug from the pharmacy list before quoting; a named high-cost drug can dominate this estimate.'
        );
      }
    } catch (err) {
      warnings.push(`Named-drug pharmacy lookup unavailable (${err.message}) — check high-cost drugs manually.`);
    }
  }

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

  // 15. side-by-side package offer — RESOLVED EARLIER (A1, manager 17-Jul):
  // the package must be known before the drivers so its master
  // package_duration can set the LOS default. `packageOffer` was computed
  // just before step 8; nothing else changed about its semantics.

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
  const actualMetrics = actualMetricsEarly; // computed at 13b (PF scaling)
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
  const pfAnalysis = medicalPfFamily || !histPf
    ? {
        applicable: false,
        reason: medicalPfFamily
          ? (pfSource === 'historic_p50'
            ? 'PF priced from the historic P50 — the insurer tariff carries token PF rates (15-Jul Q1)'
            : 'PF folded into tariff in insurance mode')
          : 'no historic PF data',
        ...(pfSource === 'historic_p50' ? { pf_source: 'historic_p50' } : {}),
      }
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

  // PF room-matched fallback (16-Jul note ¶2): the NEXT rung after the plain
  // historic P50 — median PF of the pf-basis cohort's same-room, standard
  // single-procedure admissions billing within ±15% of the cohort's gross P50.
  // Recommendation-only surface (like the existing 'use historic PF' flow):
  // the priced estimate is NEVER silently changed; the FC/UI chooses.
  {
    const pfBasisCohort = cohorts[bases.pf_basis.selected_basis] ?? [];
    const roomPf = roomMatchedPfFallback({ cohortRows: pfBasisCohort, roomType: room });
    if (roomPf) {
      const weakHistoricBasis = pfBasisCohort.length < 5;
      pfAnalysis.room_matched_fallback = {
        ...roomPf,
        basis: bases.pf_basis.selected_basis,
        reason: `PF from ${roomPf.cases} same-room standard cases billing near P50`,
      };
      if (pfAnalysis.applicable === true) {
        // cash path: prefer the room-matched figure over the plain historic P50
        // when the historic basis is thin or logic deviates significantly.
        pfAnalysis.final_estimate_with_room_matched_pf =
          Math.round((lineItems.finalEstimate - logicPf + roomPf.pf_p50) * 100) / 100;
        if (weakHistoricBasis || pfAnalysis.significantly_different) {
          pfAnalysis.recommended = 'room_matched_pf';
          pfAnalysis.recommendation_reason =
            `PF from ${roomPf.cases} same-room standard cases billing near P50` +
            (weakHistoricBasis ? ` (historic basis has only ${pfBasisCohort.length} cases)` : '');
        }
      } else if (weakHistoricBasis || !(histPf?.p50 > 0)) {
        // insurer path: the historic-P50 basis is thin (or absent) — surface
        // the room-matched figure as the recommended PF reference.
        pfAnalysis.recommended = 'room_matched_pf';
        pfAnalysis.recommendation_reason =
          `PF from ${roomPf.cases} same-room standard cases billing near P50` +
          (weakHistoricBasis ? ` (historic basis has only ${pfBasisCohort.length} cases)` : '');
      }
    }
  }

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
        // A1 provenance: where the selected stay came from
        los_source: losSource,
        ...(losSource === 'package_master' ? {
          package_los: pkgDurRaw,
          package_pre_days: packageOffer?.package?.pre_days ?? null,
          package_post_days: packageOffer?.package?.post_days ?? null,
        } : {}),
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
      ...(roboticAddon ? {
        addon_status: roboticAddon.status,          // included | optional | unpriced
        addon_source: roboticAddon.source,          // tariff_contracted | cohort_history | tariff_tr1_fallback | null
        addon_amount: roboticAddon.amount ?? null,
      } : {}),
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
        // robotic add-on charge state (15-Jul #27) — mirrored top-level as
        // estimate.robotic_addon for direct UI consumption
        addon: roboticAddon ? {
          status: roboticAddon.status,              // 'included' | 'optional' | 'unpriced'
          required: roboticRequired,                // gate redirect / explicit yes / robotic wording
          reason: roboticAddon.reason,
          source: roboticAddon.source,              // 'tariff_contracted' | 'cohort_history' | 'tariff_tr1_fallback' | null
          amount: roboticAddon.amount ?? null,      // selected-room charge
          item_name: roboticAddon.item_name,
          item_code: roboticAddon.item_code,
          ...(roboticAddon.tr1_rate ? { tr1_rate: true } : {}),
          ...(roboticAddon.prompt ? { prompt: roboticAddon.prompt } : {}),
          presence: {
            rate: roboticPresence,
            basis: svcBasis,
            cases_with_robotic: roboticInfo.case_count,
            basis_case_count: roboticInfo.basis_case_count ?? (cohorts[svcBasis]?.length ?? null),
          },
        } : null,
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
  // additive (P3): named-drug detection state — present ONLY for whitelisted
  // infusion-class families where there was something to say (a priced line,
  // an ambiguity, or an unmatched injection wording)
  if (namedDrug) estimate.named_drug = namedDrug;
  // additive (15-Jul #27): robotic add-on state for the UI — absent when robotic
  // is not applicable / already priced on the family's own robotic procedure row
  if (roboticAddon) estimate.robotic_addon = estimate.resolved_context.robotic.addon;

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

  // 17b. expected NME (patient-borne non-medical) — ADVISORY only, a separate
  // patient-payable line from the historical HIMS-NME cohort profiles; never
  // folded into the settled insurer/patient split. Non-Cash only.
  if (input.payment.payor_bucket !== 'Cash') {
    try {
      const nme = await lookupExpectedNme({
        payer_bucket: input.payment.payor_bucket,
        package_status: 'Open Bill',
        department: input.clinical.department_name,
        los_days: drivers.los?.selected,
        icu_days: drivers.icu?.selected,
      });
      if (nme) estimate.expected_nme = nme;
    } catch { /* advisory only — never break the estimate */ }
  }

  // 17c. Emergency billing overlay (doc T3) — a billing overlay on Treatment A.
  // ADDITIVE and explicit-input-only (manager Q4: nothing inferred); it never
  // mutates the parity-pinned base line items or totals. Present only when an
  // emergency input is set.
  try {
    const emergency = buildEmergencyOverlay({
      inputs: {
        arrivedViaEr: controls.arrived_via_emergency_department,
        clinicallyEmergency: controls.is_clinically_emergency,
        emergencyBedExpected: controls.emergency_bed_expected,
        emergencyBedHours: controls.emergency_bed_hours,
        emergencyPricingMethod: controls.emergency_pricing_method,
        mlc: controls.mlc,
        emergencyOt: controls.emergency_ot,
      },
      rateOf: (code) => rates.get(code) || {},
      payorBucket: input.payment.payor_bucket,
      room: room.toLowerCase(),
    });
    if (emergency) estimate.emergency = emergency;
  } catch { /* overlay is additive — never break the estimate */ }

  // 17d. Positive-case (infective/seropositive) overlay (doc T4) — verified-status,
  // explicit-toggle-only billing layer; additive, never mutates base totals.
  // Positive-management charges sit OUTSIDE the package by default.
  try {
    if (controls.positive_status && controls.positive_status !== 'NONE') {
      const roomKey = room.toLowerCase();
      const otRow = lineItems.rows.find((r) => r.name === 'OT Charges');
      const otBase = otRow ? (otRow.selectedCells?.[roomKey] ?? otRow.cells?.[roomKey]?.[1] ?? 0) : 0;
      const positiveCase = buildPositiveCaseOverlay({
        inputs: {
          positiveStatus: controls.positive_status,
          confirmationSource: controls.confirmation_source,
          requiresIsolation: controls.requires_isolation,
          isolationRoomDays: controls.isolation_room_days,
          isolationIcuDays: controls.isolation_icu_days,
          surgeryContext: controls.surgery_context,
          losDays: drivers.los?.selected,
          daycare: controls.setting === 'Daycare',
          payerAgreementId: controls.payer_agreement_id,
        },
        rateOf: (code) => rates.get(code) || {},
        payorBucket: input.payment.payor_bucket,
        room: roomKey,
        otChargesBase: otBase,
        hasPackage: !!packageOffer?.package?.package_code,
      });
      if (positiveCase) estimate.positive_case = positiveCase;
    }
  } catch { /* overlay is additive — never break the estimate */ }

  // Package tariff differs per room type: use the room's tier from
  // room_amounts (derived from fc.package_master.room_rates_jsonb), falling
  // back to the scalar package_amount (= General Ward tier) when the jsonb
  // is missing/empty for that tier.
  const pkgAmountForRoom = (pkg, rk) => Number(pkg?.room_amounts?.[rk] ?? pkg?.package_amount) || 0;

  // 18. package coverage: per-line inclusion status + dual grand totals
  // (only when a package resolved and curated inclusion text exists).
  // #4 (flow parity): a placeholder package price must never become a
  // with-package total — the offer stays visible (with its billed actuals)
  // but produces no coverage math.
  if (packageOffer?.package?.price_placeholder) {
    warnings.push(`Package [${packageOffer.package.package_code}] ${packageOffer.package.package_name} carries a placeholder price (₹${packageOffer.package.package_amount}) with no per-room rates — no with-package total produced; see its actual billed history instead.`);
  } else if (packageOffer?.package?.inclusions_text) {
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
      // advisory expected NME over the PACKAGE route (package bills carry far
      // less NME than open bills — the profile reflects that)
      if (input.payment.payor_bucket !== 'Cash') {
        try {
          const nme = await lookupExpectedNme({
            payer_bucket: input.payment.payor_bucket,
            package_status: 'Package Bill',
            department: input.clinical.department_name,
            los_days: drivers.los?.selected,
            icu_days: drivers.icu?.selected,
          });
          if (nme) packageOffer.expected_nme = nme;
        } catch { /* advisory only */ }
      }
    } catch (err) {
      packageOffer.coverage = { error: err.message };
    }
  }

  // 18b. conversion alert (15-Jul flow doc): the open→package conversion is
  // driven by inclusion/exclusion text parsing — when the converted total
  // lands outside the ACTUAL billed range for this package, the parsing (or
  // the package price) is suspect and must be checked, not trusted.
  {
    const ba = packageOffer?.billed_actuals?.this_tariff;
    const converted = packageOffer?.coverage?.totals?.with_package;
    if (ba && ba.cases >= 5 && Number.isFinite(converted) && converted > 0) {
      const lo = ba.p25 * 0.75;
      const hi = ba.p75 * 1.25;
      const out = converted < lo || converted > hi;
      packageOffer.conversion_check = {
        status: out ? 'out_of_range' : 'ok',
        converted_total: converted,
        actual_band: { p25: ba.p25, p50: ba.p50, p75: ba.p75, cases: ba.cases },
      };
      if (out) {
        warnings.push(
          `Package conversion check: the converted total ₹${Math.round(converted).toLocaleString('en-IN')} is outside the actual billed range ` +
          `₹${Math.round(ba.p25).toLocaleString('en-IN')}–₹${Math.round(ba.p75).toLocaleString('en-IN')} (${ba.cases} cases) — ` +
          'check this package\'s inclusion/exclusion parsing and price before quoting.'
        );
      }
    }
  }

  // 18c. P1 (problems-register-16jul): with-package headline quote — whenever
  // billing identification resolved a package, finish the sentence: package
  // component + predicted payable extras. ADDITIVE (final_estimate stays
  // itemized; the client decides the headline); a blocked quote (placeholder
  // price / not_ready / outside the billed band / no extras source) is data
  // only and everything else behaves exactly as today.
  if (packageOffer?.package) {
    try {
      packageOffer.quote = computePackageQuote({
        pkg: packageOffer.package,
        roomKey: room.toLowerCase(),
        payorBucket: input.payment?.payor_bucket ?? null,
        coverageExtras: packageOffer.coverage && !packageOffer.coverage.error
          ? packageOffer.coverage.totals?.payable_extras
          : null,
        bucketExtras: packageOffer.billed_actuals?.bucket_extras ?? null,
        billedActuals: packageOffer.billed_actuals ?? null,
      });
    } catch { /* additive — a quote failure never blocks the build */ }
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
