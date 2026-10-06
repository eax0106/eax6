import { z } from "./zod";
import { IsoTimestampSchema, prefixedUuidV7 } from "./ids";

export const CreditPurchaseIdSchema = prefixedUuidV7("cpx");
export const CreditQuantitySchema = z.number().int().min(1).max(1_000_000);
const positiveMinor = z.number().int().min(1).max(1_000_000_000);
const gstin = z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/);

export const CreateCreditPurchaseSchema = z.object({
  credits: CreditQuantitySchema,
  plan_version: IsoTimestampSchema,
  gstin: gstin.optional(),
}).strict();

/** D22: one integer rounding of GST on the full configured purchase price. */
export function creditPurchaseAmounts(credits: number, unitPriceMinor: number) {
  CreditQuantitySchema.parse(credits);
  positiveMinor.parse(unitPriceMinor);
  const base = BigInt(credits) * BigInt(unitPriceMinor);
  const gst = (base * 18n + 50n) / 100n;
  const total = base + gst;
  if (total < 100n || total > 1_000_000_000n) {
    throw new RangeError("Credit checkout total must be between 100 and 1000000000 INR minor units");
  }
  return { basePriceMinor: Number(base), gstPercent: 18 as const,
    gstMinor: Number(gst), totalMinor: Number(total), currency: "INR" as const,
    gatewayFeeMinor: 0 as const };
}

export const CreditPurchaseQuoteSchema = z.object({
  planId: z.string().min(1).max(100),
  planVersion: IsoTimestampSchema,
  credits: CreditQuantitySchema,
  unitPriceMinor: positiveMinor,
  creditsPerVerifiedRun: positiveMinor,
  basePriceMinor: positiveMinor,
  gstPercent: z.literal(18),
  gstMinor: z.number().int().nonnegative().max(1_000_000_000),
  totalMinor: positiveMinor,
  currency: z.literal("INR"),
  gatewayFeeMinor: z.literal(0),
}).strict().superRefine((value, context) => {
  try {
    const amounts = creditPurchaseAmounts(value.credits, value.unitPriceMinor);
    if (value.basePriceMinor !== amounts.basePriceMinor || value.gstMinor !== amounts.gstMinor ||
        value.totalMinor !== amounts.totalMinor) {
      context.addIssue({ code: "custom", message: "Credit purchase amounts do not match the configured quantity and price" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Credit purchase total is outside checkout bounds" });
  }
});

export const CreditCheckoutUrlSchema = z.url().superRefine((value, context) => {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.hostname !== "rzp.io" || url.port !== "" ||
      url.username !== "" || url.password !== "" || url.hash !== "" || url.pathname === "/") {
    context.addIssue({ code: "custom", message: "Expected an actual Razorpay HTTPS hosted checkout link" });
  }
});

export const CreditPurchaseViewSchema = z.object({
  id: CreditPurchaseIdSchema,
  quote: CreditPurchaseQuoteSchema,
  gstin: gstin.nullable(),
  state: z.enum(["submitting", "checkout_ready", "payment_pending", "delivery_pending", "delivered", "cancelled", "expired"]),
  checkoutUrl: CreditCheckoutUrlSchema.nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  revision: z.number().int().positive(),
}).strict();

export type CreditPurchaseQuote = z.infer<typeof CreditPurchaseQuoteSchema>;
export type CreditPurchaseView = z.infer<typeof CreditPurchaseViewSchema>;
export type CreateCreditPurchase = z.infer<typeof CreateCreditPurchaseSchema>;
