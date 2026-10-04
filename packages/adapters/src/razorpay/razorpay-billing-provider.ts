import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderCapabilities } from "@alterx/contracts";
import type {
  BillingEvent,
  BillingDispute,
  BillingDisputeResolution,
  BillingPlan,
  BillingProvider,
  BillingRefund,
  Invoice,
  Page,
  PaymentMethodRef,
  ProviderHealth,
  ProviderMetadata,
  SecretsProvider,
  Subscription,
  SubscriptionCheckoutInput,
  SubscriptionCheckoutLookup,
} from "@alterx/shared-clients";

export interface BillingTenantReferences {
  readonly providerCustomerRef: string | null;
  readonly subscriptionRef: string | null;
}

export interface BillingReferenceStore {
  getTenantReferences(tenantId: string): Promise<BillingTenantReferences | null>;
  setSubscriptionReferences(
    tenantId: string,
    references: BillingTenantReferences,
  ): Promise<void>;
  savePaymentMethod(
    tenantId: string,
    method: PaymentMethodRef,
  ): Promise<void>;
  listPaymentMethods(tenantId: string): Promise<PaymentMethodRef[]>;
  deletePaymentMethod(tenantId: string, ref: string): Promise<void>;
}

export interface RazorpayHttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly authorization: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface RazorpayHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RazorpayHttpClient {
  request(request: RazorpayHttpRequest): Promise<RazorpayHttpResponse>;
}

export interface RazorpayBillingProviderConfig {
  readonly keyIdSecretRef: string;
  readonly keySecretSecretRef: string;
  readonly totalBillingCycles?: number;
}

export const RAZORPAY_BILLING_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tool_calling: false,
  vision: false,
  structured_output: true,
  long_context: false,
  regional_availability: ["IN"],
  data_residency: ["IN"],
  batch_support: false,
  maximum_payload: 65_536,
  supported_languages: ["en"],
  cost_model: { rates: [] },
};

const metadata: ProviderMetadata<"BillingProvider"> = {
  providerId: "razorpay",
  interfaceName: "BillingProvider",
  displayName: "Razorpay",
  version: "1.0.0",
  telemetryNamespace: "alterx.adapters.razorpay.billing",
  supportsTenantOverrides: false,
  migration: {
    strategyVersion: "razorpay-billing-v1",
    rollbackSupported: true,
  },
};

export class RazorpayBillingProvider implements BillingProvider {
  readonly metadata = metadata;
  readonly capabilities = RAZORPAY_BILLING_CAPABILITIES;

  constructor(
    private readonly config: RazorpayBillingProviderConfig,
    private readonly secrets: SecretsProvider,
    private readonly references: BillingReferenceStore,
    private readonly http: RazorpayHttpClient =
      createFetchRazorpayHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    const started = this.now().getTime();
    try {
      await this.call("GET", "/v1/plans?count=1");
      const checkedAt = this.now();
      return {
        status: "healthy",
        checkedAt: checkedAt.toISOString(),
        latencyMs: checkedAt.getTime() - started,
      };
    } catch {
      const checkedAt = this.now();
      return {
        status: "unhealthy",
        checkedAt: checkedAt.toISOString(),
        latencyMs: checkedAt.getTime() - started,
      };
    }
  }

  async listPlans(): Promise<BillingPlan[]> {
    const body = collection(await this.call("GET", "/v1/plans?count=100"));
    return body.items.map(mapPlan);
  }

  async getSubscription(tenantId: string): Promise<Subscription | null> {
    const refs = await this.references.getTenantReferences(tenantId);
    if (!refs?.subscriptionRef) return null;
    return mapSubscription(
      await this.call(
        "GET",
        `/v1/subscriptions/${encodeURIComponent(refs.subscriptionRef)}`,
      ),
      tenantId,
    );
  }

  async createSubscription(
    tenantId: string,
    planId: string,
    paymentMethodRef: string,
  ): Promise<Subscription> {
    const body = await this.call("POST", "/v1/subscriptions", {
      plan_id: planId,
      total_count: this.config.totalBillingCycles ?? 1_200,
      quantity: 1,
      customer_notify: true,
      notes: {
        tenant_id: tenantId,
        payment_method_ref: paymentMethodRef,
      },
    });
    const subscription = mapSubscription(body, tenantId);
    await this.references.setSubscriptionReferences(tenantId, {
      providerCustomerRef: subscription.providerCustomerRef,
      subscriptionRef: subscription.id,
    });
    return subscription;
  }

  async createCheckoutSubscription(
    tenantId: string,
    planId: string,
    input: SubscriptionCheckoutInput,
  ): Promise<Subscription> {
    if (!/^plan_[A-Za-z0-9]{1,100}$/.test(planId) || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(input.internalPlanId) ||
      input.currency !== "INR" || !Number.isSafeInteger(input.expectedTotalMinor) || input.expectedTotalMinor <= 0 ||
      input.expectedTotalMinor > 1_180_000_000 ||
      (input.checkoutAttemptId !== undefined && !checkoutAttempt(input.checkoutAttemptId)) ||
      (input.gstin !== undefined && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(input.gstin))) {
      throw malformedResource("checkout", "configuration", "is invalid");
    }
    const plan = mapPlan(await this.call("GET", `/v1/plans/${encodeURIComponent(planId)}`));
    if (plan.id !== planId || !plan.active || plan.currency !== input.currency || plan.amount !== input.expectedTotalMinor) {
      throw malformedResource("checkout", "plan", "does not match configured amount and currency");
    }
    const subscription = mapSubscription(await this.call("POST", "/v1/subscriptions", {
      plan_id: planId, total_count: this.config.totalBillingCycles ?? 1_200,
      quantity: 1, customer_notify: true,
      notes: { tenant_id: tenantId, alter_plan: input.internalPlanId,
        ...(input.checkoutAttemptId ? { alter_checkout_attempt: input.checkoutAttemptId } : {}),
        ...(input.gstin ? { gstin: input.gstin } : {}) },
    }), tenantId);
    if (subscription.planId !== planId || !subscription.checkoutUrl) {
      throw malformedResource("checkout", "subscription", "has no matching hosted checkout");
    }
    // The billing service durably binds the result to its audited checkout claim.
    return subscription;
  }

  async findCheckoutSubscription(tenantId: string, input: SubscriptionCheckoutLookup): Promise<Subscription | null> {
    const from = Math.floor(Date.parse(input.createdAfter) / 1000) - 300;
    if (!checkoutAttempt(input.checkoutAttemptId) || !/^plan_[A-Za-z0-9]{1,100}$/.test(input.providerPlanId) ||
        !Number.isSafeInteger(from) || from < 0 || from > Math.floor(this.now().getTime()/1000)) {
      throw malformedResource("checkout", "lookup", "is invalid");
    }
    const to = Math.floor(this.now().getTime()/1000);
    let found: Subscription | null = null;
    for (let page = 0; page < 5; page++) {
      const response = object(await this.call("GET", `/v1/subscriptions?plan_id=${encodeURIComponent(input.providerPlanId)}` +
        `&from=${from}&to=${to}&count=100&skip=${page * 100}`));
      if (!Array.isArray(response.items) || response.items.length > 100) {
        throw malformedResource("checkout", "lookup", "has an invalid collection");
      }
      for (const item of response.items) {
        const resource = object(item), notes = object(resource.notes ?? {});
        if (notes.tenant_id !== tenantId || notes.alter_checkout_attempt !== input.checkoutAttemptId) continue;
        const subscription = mapSubscription(resource, tenantId);
        if (!/^sub_[A-Za-z0-9]{1,100}$/.test(subscription.id) || subscription.planId !== input.providerPlanId ||
            !subscription.checkoutUrl || found) {
          throw malformedResource("checkout", "lookup", "has conflicting subscriptions");
        }
        found = subscription;
      }
      if (response.items.length < 100) return found;
    }
    // An incomplete scan cannot establish a unique checkout or permit a retry.
    throw malformedResource("checkout", "lookup", "exceeded its bounded scan");
  }

  async changeSubscription(
    tenantId: string,
    planId: string,
  ): Promise<Subscription> {
    const subscriptionRef = await this.requireSubscriptionRef(tenantId);
    return mapSubscription(
      await this.call(
        "PATCH",
        `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`,
        { plan_id: planId, schedule_change_at: "now" },
      ),
      tenantId,
    );
  }

  async changeConfiguredSubscription(tenantId: string, subscriptionId: string, providerPlanId: string,
    input: SubscriptionCheckoutInput): Promise<Subscription> {
    if (!/^sub_[A-Za-z0-9]{1,100}$/.test(subscriptionId) || !/^plan_[A-Za-z0-9]{1,100}$/.test(providerPlanId) ||
        input.currency !== "INR" || !Number.isSafeInteger(input.expectedTotalMinor) || input.expectedTotalMinor <= 0 ||
        input.expectedTotalMinor > 1_180_000_000) throw malformedResource("subscription", "change", "is invalid");
    const current = object(await this.call("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`));
    if (current.id !== subscriptionId || !["authenticated","active"].includes(String(current.status)) ||
        current.payment_method !== "card" || object(current.notes ?? {}).tenant_id !== tenantId) {
      throw malformedResource("subscription", "change", "requires an authenticated or active card subscription belonging to the tenant");
    }
    const plan = mapPlan(await this.call("GET", `/v1/plans/${encodeURIComponent(providerPlanId)}`));
    if (plan.id !== providerPlanId || !plan.active || plan.currency !== input.currency || plan.amount !== input.expectedTotalMinor) {
      throw malformedResource("subscription", "change", "does not match configured amount and currency");
    }
    const result = mapSubscription(await this.call("PATCH", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {plan_id:providerPlanId,schedule_change_at:"now",quantity:1,customer_notify:true}),tenantId);
    if (result.id !== subscriptionId || result.planId !== providerPlanId) throw malformedResource("subscription", "change", "returned an unrelated resource");
    return result;
  }

  async cancelSubscription(tenantId: string): Promise<Subscription> {
    const subscriptionRef = await this.requireSubscriptionRef(tenantId);
    return mapSubscription(
      await this.call(
        "POST",
        `/v1/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`,
        { cancel_at_cycle_end: false },
      ),
      tenantId,
    );
  }

  async listInvoices(
    tenantId: string,
    cursor = "0",
    limit = 50,
  ): Promise<Page<Invoice>> {
    const subscriptionRef = await this.requireSubscriptionRef(tenantId);
    const skip = parseCursor(cursor);
    const body = collection(
      await this.call(
        "GET",
        `/v1/invoices?subscription_id=${encodeURIComponent(subscriptionRef)}` +
          `&count=${limit}&skip=${skip}`,
      ),
    );
    return {
      items: body.items.map(mapInvoice),
      nextCursor: body.items.length < limit ? null : String(skip + limit),
    };
  }

  async attachPaymentMethod(
    tenantId: string,
    providerToken: string,
  ): Promise<PaymentMethodRef> {
    const token = object(
      await this.call("POST", "/v1/tokens/fetch", { id: providerToken }),
    );
    const card = object(token.card ?? {});
    const method: PaymentMethodRef = {
      ref: string(token.id, providerToken),
      type: string(token.method, "card"),
      brand: nullableString(card.network ?? card.brand),
      last4: nullableString(card.last4),
    };
    await this.references.savePaymentMethod(tenantId, method);
    return method;
  }

  listPaymentMethods(tenantId: string): Promise<PaymentMethodRef[]> {
    return this.references.listPaymentMethods(tenantId);
  }

  async detachPaymentMethod(tenantId: string, ref: string): Promise<void> {
    await this.call("POST", "/v1/tokens/delete", { id: ref });
    await this.references.deletePaymentMethod(tenantId, ref);
  }

  async refundPayment(
    paymentRef: string,
    amountMinor: number,
    speed: "normal" | "optimum",
    reason: string,
  ): Promise<BillingRefund> {
    const body = await this.call(
      "POST",
      `/v1/payments/${encodeURIComponent(paymentRef)}/refund`,
      { amount: amountMinor, speed, notes: { reason } },
    );
    return mapRefund(body, speed);
  }

  async resolveDispute(
    disputeRef: string,
    resolution: BillingDisputeResolution,
  ): Promise<BillingDispute> {
    const path = `/v1/disputes/${encodeURIComponent(disputeRef)}`;
    if (resolution.action === "accept") {
      return mapDispute(await this.call("POST", `${path}/accept`));
    }
    if (resolution.evidenceRefs.length === 0) {
      throw new RazorpayBillingError(
        400,
        "Contest requires at least one evidence reference",
      );
    }
    return mapDispute(
      await this.call("PATCH", `${path}/contest`, {
        summary: resolution.reason,
        explanation_letter: [...resolution.evidenceRefs],
        action: "submit",
      }),
    );
  }

  verifyWebhookSignature(
    rawBody: Uint8Array,
    signature: string,
    secret: string,
  ): boolean {
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const provided = Buffer.from(signature, "hex");
    return (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    );
  }

  parseWebhookEvent(rawBody: Uint8Array): BillingEvent {
    const parsed = object(JSON.parse(new TextDecoder().decode(rawBody)));
    return {
      id: requiredString(
        parsed.id ?? parsed.account_id,
        "webhook event",
        "id",
      ),
      type: requiredString(parsed.event, "webhook event", "event"),
      createdAt: epoch(parsed.created_at),
      payload: parsed as BillingEvent["payload"],
    };
  }

  private async requireSubscriptionRef(tenantId: string): Promise<string> {
    const refs = await this.references.getTenantReferences(tenantId);
    if (!refs?.subscriptionRef) {
      throw new RazorpayBillingError(404, "Subscription reference not found");
    }
    return refs.subscriptionRef;
  }

  private async call(
    method: RazorpayHttpRequest["method"],
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const [keyId, keySecret] = await Promise.all([
      this.secrets.getSecret(this.config.keyIdSecretRef),
      this.secrets.getSecret(this.config.keySecretSecretRef),
    ]);
    const response = await this.http.request({
      method,
      path,
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new RazorpayBillingError(
        response.status,
        "Razorpay billing operation failed",
      );
    }
    return response.body;
  }
}

export class RazorpayBillingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RazorpayBillingError";
  }
}

export function createFetchRazorpayHttpClient(
  baseUrl = "https://api.razorpay.com",
): RazorpayHttpClient {
  return {
    request: async (request) => {
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: request.authorization,
          "content-type": "application/json",
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length === 0 ? {} : JSON.parse(text),
      };
    },
  };
}

function mapPlan(value: unknown): BillingPlan {
  const plan = object(value);
  const item = object(plan.item);
  return {
    id: requiredString(plan.id, "plan", "id"),
    name: requiredString(item.name, "plan", "item.name"),
    description: nullableString(item.description),
    amount: monetaryAmount(item.amount, "plan", "item.amount"),
    currency: requiredString(item.currency, "plan", "item.currency"),
    interval: number(plan.interval),
    period: period(plan.period),
    active: requiredBoolean(item.active, "plan", "item.active"),
  };
}

function mapSubscription(value: unknown, tenantId: string): Subscription {
  const subscription = object(value);
  return {
    id: requiredString(subscription.id, "subscription", "id"),
    tenantId,
    planId: requiredString(subscription.plan_id, "subscription", "plan_id"),
    status: status(subscription.status),
    currentPeriodStart: nullableEpoch(subscription.current_start),
    currentPeriodEnd: nullableEpoch(subscription.current_end),
    providerCustomerRef: nullableString(subscription.customer_id),
    ...(subscription.short_url == null ? {} : { checkoutUrl: subscriptionCheckoutUrl(subscription.short_url) }),
  };
}

function subscriptionCheckoutUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error("invalid URL");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "rzp.io" || url.port || url.username || url.password || url.hash || url.pathname === "/") throw new Error("invalid URL");
    return url.href;
  } catch {
    throw malformedResource("subscription", "short_url", "must be a Razorpay HTTPS checkout URL");
  }
}

function mapInvoice(value: unknown): Invoice {
  const invoice = object(value);
  return {
    id: requiredString(invoice.id, "invoice", "id"),
    subscriptionId: nullableString(invoice.subscription_id),
    amount: monetaryAmount(invoice.amount, "invoice", "amount"),
    currency: requiredString(invoice.currency, "invoice", "currency"),
    status: invoiceStatus(invoice.status),
    issuedAt: epoch(invoice.issued_at ?? invoice.created_at),
    paidAt: nullableEpoch(invoice.paid_at),
    documentUrl: httpsUrl(invoice.short_url),
  };
}

function mapRefund(
  value: unknown,
  requestedSpeed: BillingRefund["speed"],
): BillingRefund {
  const refund = object(value);
  const speed = refund.speed_processed ?? refund.speed_requested ?? requestedSpeed;
  if (speed !== "normal" && speed !== "optimum") {
    throw malformedResource("refund", "speed", "must be normal or optimum");
  }
  return {
    id: requiredString(refund.id, "refund", "id"),
    paymentRef: requiredString(refund.payment_id, "refund", "payment_id"),
    amount: monetaryAmount(refund.amount, "refund", "amount"),
    currency: requiredString(refund.currency, "refund", "currency"),
    status: requiredString(refund.status, "refund", "status"),
    speed,
    createdAt: epoch(refund.created_at),
  };
}

function mapDispute(value: unknown): BillingDispute {
  const dispute = object(value);
  return {
    id: requiredString(dispute.id, "dispute", "id"),
    paymentRef: requiredString(dispute.payment_id, "dispute", "payment_id"),
    amount: monetaryAmount(dispute.amount, "dispute", "amount"),
    currency: requiredString(dispute.currency, "dispute", "currency"),
    status: disputeStatus(dispute.status),
    phase: requiredString(dispute.phase, "dispute", "phase"),
    respondBy: nullableEpoch(dispute.respond_by),
  };
}

function collection(value: unknown): {
  readonly items: readonly unknown[];
} {
  const result = object(value);
  return { items: Array.isArray(result.items) ? result.items : [] };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RazorpayBillingError(502, "Razorpay returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new RazorpayBillingError(502, "Razorpay returned an invalid string");
}

// Rendered as a link for the customer, so only an absolute https URL passes.
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(
  value: unknown,
  resource: string,
  field: string,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw malformedResource(resource, field, "must be a non-empty string");
}

function monetaryAmount(
  value: unknown,
  resource: string,
  field: string,
): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw malformedResource(
    resource,
    field,
    "must be a non-negative integer",
  );
}

function requiredBoolean(
  value: unknown,
  resource: string,
  field: string,
): boolean {
  if (typeof value === "boolean") return value;
  throw malformedResource(resource, field, "must be a boolean");
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new RazorpayBillingError(502, "Razorpay returned an invalid number");
}

function epoch(value: unknown): string {
  return new Date(number(value) * 1_000).toISOString();
}

function nullableEpoch(value: unknown): string | null {
  return value === null || value === undefined ? null : epoch(value);
}

function parseCursor(cursor: string): number {
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RazorpayBillingError(400, "Invoice cursor is invalid");
  }
  return parsed;
}

function period(value: unknown): BillingPlan["period"] {
  if (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "yearly"
  ) {
    return value;
  }
  throw new RazorpayBillingError(502, "Razorpay returned an invalid period");
}

function status(value: unknown): Subscription["status"] {
  if (
    value === "created" ||
    value === "authenticated" ||
    value === "active" ||
    value === "pending" ||
    value === "halted" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "completed" ||
    value === "expired"
  ) {
    return value;
  }
  throw new RazorpayBillingError(502, "Razorpay returned an invalid status");
}

function checkoutAttempt(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function invoiceStatus(value: unknown): Invoice["status"] {
  if (
    value === "draft" ||
    value === "issued" ||
    value === "partially_paid" ||
    value === "paid" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "deleted"
  ) {
    return value;
  }
  throw malformedResource(
    "invoice",
    "status",
    "must be a documented Razorpay invoice status",
  );
}

function disputeStatus(value: unknown): BillingDispute["status"] {
  if (
    value === "open" ||
    value === "under_review" ||
    value === "won" ||
    value === "lost" ||
    value === "closed"
  ) {
    return value;
  }
  throw malformedResource(
    "dispute",
    "status",
    "must be a documented Razorpay dispute status",
  );
}

function malformedResource(
  resource: string,
  field: string,
  requirement: string,
): RazorpayBillingError {
  return new RazorpayBillingError(
    502,
    `Razorpay returned malformed ${resource}: ${field} ${requirement}`,
  );
}
