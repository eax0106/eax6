import { z } from "zod";

// Integer minor units keep tax rounding independent of floating point prices.
const minor = z.number().int().nonnegative().max(1_000_000_000);
const credits = z.number().int().nonnegative().max(1_000_000_000);
export const PlanCommercialSchema = z.object({
  currency: z.literal("INR"),
  basePriceMinor: minor.nullable(),
  razorpayPlanId: z.string().regex(/^plan_[A-Za-z0-9]{1,100}$/).nullable(),
  includedCredits: credits.nullable(),
  extraCreditPriceMinor: minor.nullable(),
  creditsPerVerifiedRun: credits.positive().nullable(),
}).strict();
export type PlanCommercial = z.infer<typeof PlanCommercialSchema>;

export function checkoutAmounts(commercial: PlanCommercial | null | undefined) {
  if (!commercial) return null;
  const parsed = PlanCommercialSchema.safeParse(commercial);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.basePriceMinor === null || value.basePriceMinor === 0 || value.razorpayPlanId === null ||
      value.includedCredits === null || value.extraCreditPriceMinor === null || value.creditsPerVerifiedRun === null) return null;
  // D22: listed price excludes GST; one integer rounding at checkout.
  const gstMinor = Math.floor((value.basePriceMinor * 18 + 50) / 100);
  return { basePriceMinor: value.basePriceMinor, gstPercent: 18 as const, gstMinor,
    totalMinor: value.basePriceMinor + gstMinor, currency: value.currency,
    gatewayFeeMinor: 0 as const };
}
