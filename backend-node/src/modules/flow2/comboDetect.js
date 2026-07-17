import { splitFragments } from './flow2.service.js';
import { familyMatches, payorAwareFamilies, rankPackageCandidates } from '../resolve/familyResolve.js';
import { resolveTariff } from '../resolve/payorTariff.js';

/**
 * Multi-treatment combo DETECTION for the MAIN estimate flow (16-Jul #8,
 * carried from 15-Jul #10): "detect single vs multiple vs pkg+non-pkg at
 * intake, announce, path per treatment. Detection first; pricing later."
 *
 * Flow 2 already prices a full path per fragment (evaluateFlow2 → combo.paths);
 * the main flow only needs the ANNOUNCEMENT: which treatments the wording
 * carries and what billing shape they add up to — family + package-or-not per
 * fragment, no numbers. Reuses flow2's fragment splitting and the shared gate
 * brain (familyMatches / rankPackageCandidates are short-TTL cached, so the
 * per-fragment cost is low).
 *
 * Returns null (⇒ the resolve response stays byte-identical to pre-combo)
 * unless the wording splits into >1 clinical fragments AND at least 2 of them
 * resolve to an onboarded family — a stray "and <noise>" fragment that matches
 * nothing must never trigger a combo.
 */

// mirrors flow2's medical-management wording rule: packages don't apply
const isMedicalMgmtWording = (t) =>
  /\b(medical\s+management|conservative\s+(management|treatment)|observation|medical\s+care)\b/i.test(t || '');

export async function detectCombo({ text, payorBucket, organizationCd }) {
  const frags = splitFragments(text);
  if (frags.length <= 1) return null;

  // family per fragment — the same payor-aware gate brain the resolver uses
  const resolved = await Promise.all(frags.map(async (fragment) => {
    try {
      const ai = await familyMatches(fragment);
      const { matches } = await payorAwareFamilies(ai, payorBucket);
      const top = matches[0] ?? null;
      return {
        text: fragment,
        family: top?.family ?? null,
        label: top?.label ?? null,
        payor_cases: top?.payor_cases ?? null,
      };
    } catch {
      return { text: fragment, family: null, label: null, payor_cases: null };
    }
  }));

  const matched = resolved.filter((f) => f.family);
  if (matched.length < 2) return null;

  // light billing identification per resolved fragment: package-or-not only,
  // no amounts — same master search flow2's billing_identification step runs
  const tariff = await resolveTariff({ payorBucket: payorBucket || '', organizationCd }).catch(() => null);
  const fragments = await Promise.all(resolved.map(async (f) => {
    const blank = { billing_type: null, package_code: null, package_name: null };
    if (!f.family || !tariff?.tariff_cd) return { ...f, ...blank };
    if (isMedicalMgmtWording(f.text)) return { ...f, ...blank, billing_type: 'non_package' };
    try {
      const { candidates } = await rankPackageCandidates({
        treatment: f.text, tariff_code: tariff.tariff_cd, organization_cd: organizationCd,
      });
      const top = candidates[0] ?? null;
      return {
        ...f,
        billing_type: top ? 'package' : 'non_package',
        package_code: top?.package_code ?? null,
        package_name: top?.package_name ?? null,
      };
    } catch {
      return { ...f, ...blank, billing_type: 'non_package' };
    }
  }));

  // billing shape across the RESOLVED fragments; an unresolved tariff leaves
  // billing_type null per fragment, which reads as non-package for the shape
  const types = fragments.filter((f) => f.family).map((f) => f.billing_type);
  const pkgN = types.filter((t) => t === 'package').length;
  const billing_shape = pkgN === 0 ? 'multiple_non_package'
    : pkgN === types.length ? 'multiple_packages'
      : 'package_plus_non_package';

  return {
    detected: true,
    fragments,
    billing_shape,
    note: `${matched.length} treatments detected — each is estimated separately; combined pricing is a later phase`,
  };
}
