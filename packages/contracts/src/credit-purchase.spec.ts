import { describe, expect, it } from "vitest";
import { CreateCreditPurchaseSchema, CreditCheckoutUrlSchema, CreditPurchaseQuoteSchema, creditPurchaseAmounts } from "./credit-purchase";

const version = "2026-10-05T12:00:00.000Z";
describe("configured extra-credit purchase contract", () => {
  it("rounds GST once on the full configured price and adds no gateway fee", () => {
    expect(creditPurchaseAmounts(3, 101)).toEqual({ basePriceMinor: 303, gstPercent: 18,
      gstMinor: 55, totalMinor: 358, currency: "INR", gatewayFeeMinor: 0 });
    expect(creditPurchaseAmounts(1, 10003)).toMatchObject({ gstMinor: 1801, totalMinor: 11804 });
  });
  it("refuses unconfigured, fractional, negative and overflowing purchases", () => {
    for (const [quantity, price] of [[0, 100], [1.5, 100], [1, 0], [1, -1], [1, 1], [1_000_000, 1_000_000_000]]) {
      expect(() => creditPurchaseAmounts(quantity!, price!)).toThrow();
    }
    expect(creditPurchaseAmounts(1, 847_457_627)).toMatchObject({ totalMinor: 1_000_000_000 });
    expect(() => creditPurchaseAmounts(1, 847_457_628)).toThrow();
  });
  it("requires a displayed configuration version and rejects client-supplied prices or identities", () => {
    expect(CreateCreditPurchaseSchema.parse({ credits: 3, plan_version: version })).toEqual({ credits: 3, plan_version: version });
    for (const extra of [{ totalMinor: 1 }, { tenantId: "forged" }, { state: "delivered" }]) {
      expect(CreateCreditPurchaseSchema.safeParse({ credits: 3, plan_version: version, ...extra }).success).toBe(false);
    }
    expect(CreateCreditPurchaseSchema.safeParse({ credits: 3 }).success).toBe(false);
  });
  it("refuses altered immutable quantity, GST and total arithmetic", () => {
    const quote = { planId: "basic", planVersion: version, credits: 3, unitPriceMinor: 101,
      creditsPerVerifiedRun: 2, ...creditPurchaseAmounts(3, 101) };
    expect(CreditPurchaseQuoteSchema.parse(quote)).toEqual(quote);
    for (const change of [{ credits: 4 }, { gstMinor: 54 }, { totalMinor: 357 }, { gatewayFeeMinor: 1 }]) {
      expect(CreditPurchaseQuoteSchema.safeParse({ ...quote, ...change }).success).toBe(false);
    }
  });
  it("only accepts Razorpay HTTPS hosted links without credentials, ports or fragments", () => {
    expect(CreditCheckoutUrlSchema.parse("https://rzp.io/rzp/actual-link")).toBe("https://rzp.io/rzp/actual-link");
    for (const value of ["invalid", "http://rzp.io/i/a", "https://rzp.io.evil.test/i/a", "https://evil.test/i/a", "https://x@rzp.io/i/a", "https://rzp.io:444/i/a", "https://rzp.io/i/a#paid", "https://rzp.io/"]) {
      expect(CreditCheckoutUrlSchema.safeParse(value).success).toBe(false);
    }
  });
});
