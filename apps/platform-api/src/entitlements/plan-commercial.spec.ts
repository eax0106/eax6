import { describe, expect, it } from "vitest";
import { checkoutAmounts, PlanCommercialSchema } from "./plan-commercial";

const configured = { currency: "INR" as const, basePriceMinor: 10_003, razorpayPlanId: "plan_fixture123",
  includedCredits: 100, extraCreditPriceMinor: 50, creditsPerVerifiedRun: 2 };
describe("configured subscription price", () => {
  it("adds configured GST once in integer minor units and absorbs gateway fees", () => {
    expect(checkoutAmounts(configured)).toEqual({ basePriceMinor: 10_003, gstPercent: 18, gstMinor: 1_801,
      totalMinor: 11_804, currency: "INR", gatewayFeeMinor: 0 });
    expect(checkoutAmounts({ ...configured, basePriceMinor: 3 })?.gstMinor).toBe(1);
  });
  it("leaves missing launch prices or quantities unavailable instead of inventing values", () => {
    expect(checkoutAmounts(null)).toBeNull();
    for (const key of ["basePriceMinor", "razorpayPlanId", "includedCredits", "extraCreditPriceMinor", "creditsPerVerifiedRun"] as const) {
      expect(checkoutAmounts({ ...configured, [key]: null })).toBeNull();
    }
    expect(checkoutAmounts({ ...configured, basePriceMinor: 0 })).toBeNull();
  });
  it("rejects fractional, negative, excessive amounts, unknown fields and foreign currency", () => {
    for (const field of ["basePriceMinor", "includedCredits", "extraCreditPriceMinor", "creditsPerVerifiedRun"] as const) {
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER]) expect(PlanCommercialSchema.safeParse({ ...configured, [field]: value }).success).toBe(false);
    }
    for (const change of [{ currency: "USD" }, { card_number: "4111111111111111" }, { razorpayPlanId: "arbitrary" }, { creditsPerVerifiedRun: 0 }]) {
      expect(PlanCommercialSchema.safeParse({ ...configured, ...change }).success).toBe(false);
    }
  });
});
