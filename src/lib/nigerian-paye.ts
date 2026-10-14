/**
 * Nigeria Tax Act 2025, s.58 & Fourth Schedule, operative from 2026-01-01.
 * Source: https://nass.gov.ng/documents/download/11249
 * Joint Revenue Board Personal Income Tax Guidelines (24 February 2026):
 * https://www.jrb.gov.ng/assets/2026-pit-guidelines-TJG3n9-T.pdf
 * Section 30(2) provides eligible pension/NHF/NHIS contributions and rent relief
 * of 20% of annual rent actually paid, capped at ₦500,000 (with evidence); s.58
 * exempts individuals earning the statutory minimum wage. These are ANNUAL
 * chargeable-income brackets, not a flat rate on each person's monthly salary.
 *
 * Only the 2026 tax year is automated. Earlier tax years had different reliefs;
 * later years and any tax-law changes need a reviewed schedule, not a guess.
 * Employer sign-off of an individual's annual gross, eligibility, evidence and
 * other statutory relief is required before assigning PAYE. Irregular piecework
 * requires a professional assessment: monthly gross × 12 is not inferred.
 */
export const PAYE_RULE = "NTA_2025_2026";
export const PAYE_SOURCE = "https://nass.gov.ng/documents/download/11249";
export const MINIMUM_WAGE_MONTHLY_2026 = 70_000;

export type PayeAssessment = {
  annualGross: number;
  annualPension: number;
  annualNhf: number;
  annualNhis: number;
  annualRentPaid: number;
  annualOtherRelief: number;
  minimumWageExempt: boolean;
};

// Sizes are annual naira amounts; the last band is unlimited.
const BANDS = [
  { size: 800_000, rate: 0 },
  { size: 2_200_000, rate: 15 },
  { size: 9_000_000, rate: 18 },
  { size: 13_000_000, rate: 21 },
  { size: 25_000_000, rate: 23 },
  { size: Infinity, rate: 25 },
] as const;

export function calculatePaye2026(profile: PayeAssessment) {
  const rentRelief = Math.min(500_000, Math.floor(profile.annualRentPaid / 5));
  const reliefs = profile.annualPension + profile.annualNhf + profile.annualNhis +
    profile.annualOtherRelief + rentRelief;
  const chargeableIncome = Math.max(0, profile.annualGross - reliefs);
  let remainder = profile.minimumWageExempt ? 0 : chargeableIncome;
  const bands: { income: number; rate: number; tax: number }[] = [];
  // All inputs are validated as non-negative integer naira and <= 2bn by the API.
  // Keep hundredths of a naira until the final HALF-UP monthly rounding.
  let taxHundredths = 0;
  for (const band of BANDS) {
    const slice = Math.min(remainder, band.size);
    bands.push({ income: slice, rate: band.rate, tax: slice * band.rate / 100 });
    taxHundredths += slice * band.rate;
    remainder -= slice;
  }
  return {
    rule: PAYE_RULE, source: PAYE_SOURCE, annualGross: profile.annualGross,
    rentRelief, reliefs, chargeableIncome, bands,
    annualTax: taxHundredths / 100,
    monthlyTax: Math.round(taxHundredths / 1200),
    minimumWageExempt: profile.minimumWageExempt,
  };
}
