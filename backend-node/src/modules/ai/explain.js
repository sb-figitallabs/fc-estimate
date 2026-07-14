import { geminiText } from './gemini.js';

/** AI step 3: plain-language explanation of a computed estimate for the FC conversation. */
export async function explainEstimate(estimate) {
  const ctx = estimate.resolved_context;
  const brief = {
    procedure: ctx.family,
    payor: ctx.payor_bucket,
    tariff: ctx.tariff?.tariff_name,
    room: ctx.room_type,
    mode: ctx.estimate_mode,
    cohort_cases: ctx.cohort_case_count,
    final_estimate: estimate.final_estimate,
    bucket_totals: estimate.bucket_totals,
    drivers: {
      los: estimate.drivers?.los?.selected,
      icu: estimate.drivers?.icu?.selected,
      ward: estimate.drivers?.ward?.selected,
      ot_hours: estimate.drivers?.ot?.selected,
      cath_lab_hours: estimate.drivers?.cath?.selected || undefined,
    },
    service_line_alert: estimate.service_line_count?.status,
    warnings: estimate.warnings,
  };
  return geminiText(
    `Summarize this hospital cost estimate for a Financial Counselor to explain to a patient's family.
Keep it under 150 words, use INR formatting, mention the main cost buckets, expected stay, and that it is
an estimate band (Low/Typical/High) built from ${brief.cohort_cases} similar historical cases.
Data: ${JSON.stringify(brief)}`,
    { system: 'You are an assistant for hospital financial counselors in India. Be precise, warm, and non-alarming. Never invent numbers not present in the data.' }
  );
}
