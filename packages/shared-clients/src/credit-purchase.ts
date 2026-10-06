import type { CreditPurchaseQuote } from "@alterx/contracts";

export interface CreditPurchaseProviderInput {
  readonly tenantId: string;
  readonly purchaseId: string;
  readonly quote: CreditPurchaseQuote;
  readonly gstin: string | null;
  readonly expiresAt: string;
}

export interface CreditPurchasePayment {
  readonly id: string;
  readonly linkId: string;
  readonly amountMinor: number;
  readonly status: "captured";
  readonly createdAt: string;
}

export interface CreditPurchaseCheckout {
  readonly id: string;
  readonly referenceId: string;
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly amountPaidMinor: number;
  readonly currency: "INR";
  readonly status: "created" | "partially_paid" | "paid" | "cancelled" | "expired";
  readonly checkoutUrl: string;
  readonly payments: readonly CreditPurchasePayment[];
}

/** Vendor calls stay behind the adapter; the caller owns durable retry state. */
export interface CreditPurchaseProvider {
  create(input: CreditPurchaseProviderInput): Promise<CreditPurchaseCheckout>;
  get(input: CreditPurchaseProviderInput, checkoutId: string): Promise<CreditPurchaseCheckout>;
  find(input: CreditPurchaseProviderInput): Promise<CreditPurchaseCheckout | null>;
}
