/** Statistics helpers matching the reference build (Python statistics.quantiles inclusive). */

export function quartilesInclusive(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .map(Number).sort((a, b) => a - b);
  if (!v.length) return { p25: 0, p50: 0, p75: 0 };
  if (v.length === 1) return { p25: v[0], p50: v[0], p75: v[0] };
  const interp = (p) => {
    const idx = p * (v.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return { p25: interp(0.25), p50: interp(0.5), p75: interp(0.75) };
}

export function summaryStats(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).map(Number);
  if (!v.length) return { min: 0, max: 0, average: 0, p25: 0, p50: 0, p75: 0 };
  const q = quartilesInclusive(v);
  return {
    min: Math.min(...v),
    max: Math.max(...v),
    average: v.reduce((a, b) => a + b, 0) / v.length,
    ...q,
  };
}

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
