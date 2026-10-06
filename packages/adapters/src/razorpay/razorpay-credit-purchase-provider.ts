import { CreditCheckoutUrlSchema, CreditPurchaseIdSchema, CreditPurchaseQuoteSchema, TenantIdSchema } from "@alterx/contracts";
import { BillingOperationNotSubmittedError, type CreditPurchaseCheckout, type CreditPurchasePayment,
  type CreditPurchaseProvider, type CreditPurchaseProviderInput, type SecretsProvider } from "@alterx/shared-clients";
import { createFetchRazorpayHttpClient, RazorpayBillingError, type RazorpayBillingProviderConfig,
  type RazorpayHttpClient } from "./razorpay-billing-provider";

/** Reference-filtered Payment Links reconcile an uncertain POST without another charge link. */
export class RazorpayCreditPurchaseProvider implements CreditPurchaseProvider {
  constructor(
    private readonly config: Pick<RazorpayBillingProviderConfig, "keyIdSecretRef" | "keySecretSecretRef">,
    private readonly secrets: SecretsProvider,
    private readonly http: RazorpayHttpClient = createFetchRazorpayHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreditPurchaseProviderInput): Promise<CreditPurchaseCheckout> {
    validateInput(input);
    const expiresAt = Date.parse(input.expiresAt);
    const remaining = expiresAt - this.now().getTime();
    if (!Number.isFinite(expiresAt) || remaining < 15 * 60_000 || remaining > 180 * 24 * 60 * 60_000) {
      throw new BillingOperationNotSubmittedError(new Error("Credit checkout expiry is outside provider bounds"));
    }
    const body = await this.call("POST", "/v1/payment_links/", {
      amount: input.quote.totalMinor, currency: input.quote.currency, accept_partial: false,
      reference_id: input.purchaseId, description: `${input.quote.credits} Alter execution credits`,
      expire_by: Math.floor(expiresAt / 1_000), notify: { email: false, sms: false }, reminder_enable: false,
      notes: { tenant_id: input.tenantId, alter_credit_purchase: input.purchaseId,
        ...(input.gstin === null ? {} : { gstin: input.gstin }) },
    });
    return parseCheckout(body, input);
  }

  async get(input: CreditPurchaseProviderInput, checkoutId: string): Promise<CreditPurchaseCheckout> {
    validateInput(input);
    if (!/^plink_[A-Za-z0-9]{1,100}$/.test(checkoutId)) throw new Error("Invalid credit checkout provider id");
    const checkout = parseCheckout(await this.call("GET", `/v1/payment_links/${encodeURIComponent(checkoutId)}`), input);
    if (checkout.id !== checkoutId) throw new Error("Credit checkout provider identity does not match");
    return checkout;
  }

  async find(input: CreditPurchaseProviderInput): Promise<CreditPurchaseCheckout | null> {
    validateInput(input);
    // Razorpay defines reference_id as unique. Any ambiguous or unexpected
    // collection fails closed; an empty result never authorizes another POST.
    const body = object(await this.call("GET", `/v1/payment_links/?reference_id=${encodeURIComponent(input.purchaseId)}`));
    if (!Array.isArray(body["payment_links"]) || body["payment_links"].length > 1) {
      throw new Error("Credit checkout reference lookup is ambiguous or malformed");
    }
    return body["payment_links"].length === 0 ? null : parseCheckout(body["payment_links"][0], input);
  }

  private async call(method: "GET" | "POST", path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    let authorization: string;
    try {
      const [id, secret] = await Promise.all([this.secrets.getSecret(this.config.keyIdSecretRef),
        this.secrets.getSecret(this.config.keySecretSecretRef)]);
      if (!id || !secret) throw new Error("Credit checkout provider credentials unavailable");
      authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    } catch (error) {
      throw new BillingOperationNotSubmittedError(error);
    }
    const response = await this.http.request({ method, path, authorization, ...(body === undefined ? {} : { body }) });
    if (response.status < 200 || response.status >= 300) {
      throw new RazorpayBillingError(response.status, "Razorpay credit checkout operation failed");
    }
    return response.body;
  }
}

function validateInput(input: CreditPurchaseProviderInput): void {
  TenantIdSchema.parse(input.tenantId);
  CreditPurchaseIdSchema.parse(input.purchaseId);
  CreditPurchaseQuoteSchema.parse(input.quote);
  if (input.gstin !== null && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(input.gstin)) {
    throw new Error("Invalid credit checkout GSTIN");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed credit checkout provider response");
  return value as Record<string, unknown>;
}

function minor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new Error("Malformed credit checkout provider amount");
  }
  return value;
}

function parseCheckout(value: unknown, input: CreditPurchaseProviderInput): CreditPurchaseCheckout {
  const row = object(value), notes = object(row["notes"]);
  const id = row["id"], status = row["status"];
  if (typeof id !== "string" || !/^plink_[A-Za-z0-9]{1,100}$/.test(id) ||
      row["reference_id"] !== input.purchaseId || notes["alter_credit_purchase"] !== input.purchaseId ||
      notes["tenant_id"] !== input.tenantId || (notes["gstin"] ?? null) !== input.gstin || row["currency"] !== input.quote.currency ||
      row["accept_partial"] !== false || minor(row["amount"]) !== input.quote.totalMinor ||
      !["created", "partially_paid", "paid", "cancelled", "expired"].includes(String(status))) {
    throw new Error("Credit checkout does not match its immutable purchase");
  }
  const amountPaid = minor(row["amount_paid"]);
  if (amountPaid > input.quote.totalMinor || (status === "paid" && amountPaid !== input.quote.totalMinor)) {
    throw new Error("Credit checkout paid amount does not match");
  }
  const rawPayments = row["payments"] ?? [];
  if (!Array.isArray(rawPayments) || rawPayments.length > 100) throw new Error("Malformed credit checkout payment collection");
  const payments = rawPayments.map((raw): CreditPurchasePayment => {
    const payment = object(raw), paymentId = payment["payment_id"], created = payment["created_at"];
    if (typeof paymentId !== "string" || !/^pay_[A-Za-z0-9]{1,100}$/.test(paymentId) ||
        (payment["plink_id"] !== undefined && payment["plink_id"] !== id) || payment["status"] !== "captured" ||
        typeof created !== "number" || !Number.isSafeInteger(created) || created <= 0 || created > 253_402_300_799) {
      throw new Error("Malformed captured credit checkout payment");
    }
    return { id: paymentId, linkId: id, amountMinor: minor(payment["amount"]), status: "captured",
      createdAt: new Date(created * 1_000).toISOString() };
  });
  if (new Set(payments.map(payment => payment.id)).size !== payments.length) throw new Error("Duplicate captured credit payment");
  if (payments.length > 0 && payments.reduce((total, payment) => total + BigInt(payment.amountMinor), 0n) !== BigInt(amountPaid)) {
    throw new Error("Captured credit payments do not match the provider paid amount");
  }
  return { id, referenceId: input.purchaseId, tenantId: input.tenantId, amountMinor: input.quote.totalMinor,
    amountPaidMinor: amountPaid, currency: "INR", status: status as CreditPurchaseCheckout["status"],
    checkoutUrl: CreditCheckoutUrlSchema.parse(row["short_url"]), payments };
}
