import { createHmac } from "node:crypto";
import type {
  PaymentMethodRef,
  SecretsProvider,
} from "@alterx/shared-clients";
import {
  assertProviderContractParity,
  billingProviderContract,
} from "@alterx/shared-clients";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFetchRazorpayHttpClient,
  RazorpayBillingError,
  RazorpayBillingProvider,
  type BillingReferenceStore,
  type RazorpayHttpClient,
  type RazorpayHttpRequest,
} from "./razorpay-billing-provider";

const tenantId = "tenant-a";
const keyId = "rzp_key_private";
const keySecret = "rzp_secret_private";

describe("RazorpayBillingProvider", () => {
  let requests: RazorpayHttpRequest[];
  let references: MemoryReferences;
  let secrets: SecretsProvider;
  let http: RazorpayHttpClient;
  let provider: RazorpayBillingProvider;

  beforeEach(() => {
    requests = [];
    references = new MemoryReferences();
    secrets = {
      metadata: {
        providerId: "test-secrets",
        interfaceName: "SecretsProvider",
        displayName: "Test",
        version: "1",
        telemetryNamespace: "test",
        supportsTenantOverrides: false,
        migration: { strategyVersion: "1", rollbackSupported: true },
      },
      capabilities: capabilities(),
      healthCheck: async () => ({
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
      }),
      getSecret: vi.fn(async (reference: string) =>
        reference.endsWith("key-id") ? keyId : keySecret,
      ),
    };
    http = {
      request: vi.fn(async (request: RazorpayHttpRequest) => {
        requests.push(request);
        return response(request);
      }),
    };
    provider = new RazorpayBillingProvider(
      {
        keyIdSecretRef: "billing/key-id",
        keySecretSecretRef: "billing/key-secret",
      },
      secrets,
      references,
      http,
    );
  });

  it("resolves API keys only through SecretsProvider and maps real Razorpay resources", async () => {
    await expect(provider.listPlans()).resolves.toEqual([
      expect.objectContaining({
        id: "plan_basic",
        amount: 50_000,
        currency: "INR",
        period: "monthly",
      }),
    ]);
    expect(secrets.getSecret).toHaveBeenCalledWith("billing/key-id");
    expect(secrets.getSecret).toHaveBeenCalledWith("billing/key-secret");
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    );
    expect(JSON.stringify(requests)).not.toContain("card_number");
    expect(JSON.stringify(requests)).not.toContain("cvv");
  });

  it("creates hosted checkout only for the configured tax-inclusive provider plan", async () => {
    http.request = vi.fn(async request => {
      requests.push(request);
      return { status: 200, body: request.method === "GET" ? checkoutPlan() : checkoutSubscription() };
    });
    const subscription = await provider.createCheckoutSubscription(tenantId, "plan_basic", {
      internalPlanId: "basic", expectedTotalMinor: 11804, currency: "INR", gstin: "27ABCDE1234F1Z5",
    });
    expect(subscription).toMatchObject({ id: "sub_123", status: "created", checkoutUrl: "https://rzp.io/rzp/fixture" });
    expect(requests.map(request => request.path)).toEqual(["/v1/plans/plan_basic", "/v1/subscriptions"]);
    expect(requests[1]?.body).toEqual({ plan_id: "plan_basic", total_count: 1200, quantity: 1, customer_notify: true,
      notes: { tenant_id: tenantId, alter_plan: "basic", gstin: "27ABCDE1234F1Z5" } });
    expect(references.subscriptionRef).toBeNull();
  });

  it.each([{ amount: 10003 }, { currency: "USD" }, { active: false }])(
    "refuses a provider plan that differs from configured checkout: %j", async change => {
      http.request = vi.fn(async request => {
        requests.push(request);
        return { status: 200, body: { ...checkoutPlan(), item: { ...checkoutPlan().item, ...change } } };
      });
      await expect(provider.createCheckoutSubscription(tenantId, "plan_basic", {
        internalPlanId: "basic", expectedTotalMinor: 11804, currency: "INR",
      })).rejects.toThrow("configured amount and currency");
      expect(requests).toHaveLength(1);
      expect(references.subscriptionRef).toBeNull();
    },
  );

  it.each(["http://rzp.io/rzp/fixture", "https://foreign.test/checkout", "https://rzp.io:8443/rzp/a",
    "https://user:pass@rzp.io/rzp/a", "https://rzp.io/rzp/a#secret", "javascript:alert(1)"])(
    "refuses unsafe hosted checkout URL %s", async shortUrl => {
      http.request = vi.fn(async request => ({ status: 200,
        body: request.method === "GET" ? checkoutPlan() : { ...checkoutSubscription(), short_url: shortUrl } }));
      await expect(provider.createCheckoutSubscription(tenantId, "plan_basic", {
        internalPlanId: "basic", expectedTotalMinor: 11804, currency: "INR",
      })).rejects.toThrow("Razorpay HTTPS checkout URL");
      expect(references.subscriptionRef).toBeNull();
    },
  );

  it("rejects absent or mismatched checkout resources and malformed input before creating references", async () => {
    await expect(provider.createCheckoutSubscription(tenantId, "plan_basic", {
      internalPlanId: "basic", expectedTotalMinor: 1.5, currency: "INR",
    })).rejects.toThrow("configuration");
    expect(http.request).not.toHaveBeenCalled();
    for (const change of [{ short_url: null }, { plan_id: "plan_foreign" }]) {
      http.request = vi.fn(async request => ({ status: 200,
        body: request.method === "GET" ? checkoutPlan() : { ...checkoutSubscription(), ...change } }));
      await expect(provider.createCheckoutSubscription(tenantId, "plan_basic", {
        internalPlanId: "basic", expectedTotalMinor: 11804, currency: "INR",
      })).rejects.toThrow("matching hosted checkout");
    }
    expect(references.subscriptionRef).toBeNull();
  });

  it("runs subscription lifecycle and invoice pagination against Razorpay paths", async () => {
    expect(await provider.getSubscription(tenantId)).toBeNull();
    const created = await provider.createSubscription(
      tenantId,
      "plan_basic",
      "token_saved",
    );
    expect(created).toMatchObject({
      id: "sub_123",
      planId: "plan_basic",
      status: "active",
    });
    expect(references.subscriptionRef).toBe("sub_123");
    await expect(provider.getSubscription(tenantId)).resolves.toMatchObject({
      id: "sub_123",
    });
    await expect(
      provider.changeSubscription(tenantId, "plan_pro"),
    ).resolves.toMatchObject({ planId: "plan_pro" });
    await expect(provider.cancelSubscription(tenantId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      provider.listInvoices(tenantId, "0", 1),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "inv_123",
          amount: 50_000,
          currency: "INR",
          documentUrl: "https://rzp.io/i/inv123",
        }),
      ],
      nextCursor: "1",
    });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(
      expect.arrayContaining([
        "POST /v1/subscriptions",
        "GET /v1/subscriptions/sub_123",
        "PATCH /v1/subscriptions/sub_123",
        "POST /v1/subscriptions/sub_123/cancel",
        "GET /v1/invoices?subscription_id=sub_123&count=1&skip=0",
      ]),
    );
  });

  it.each(["amount", "currency", "status"] as const)(
    "fails the entire invoice page when any invoice is missing %s",
    async (field) => {
      references.subscriptionRef = "sub_123";
      const malformed = withoutField(invoiceFixture(), field);
      if (field === "amount") {
        malformed.gross_amount = 50_000;
      }
      http.request = vi.fn(async () => ({
        status: 200,
        body: {
          items: [invoiceFixture({ id: "inv_valid" }), malformed],
        },
      }));

      await expect(provider.listInvoices(tenantId, "0", 10)).rejects.toMatchObject(
        {
          status: 502,
          message: expect.stringContaining(field),
        },
      );
    },
  );

  it("stores token references only and detaches through Razorpay", async () => {
    const method = await provider.attachPaymentMethod(tenantId, "token_saved");
    expect(method).toEqual({
      ref: "token_saved",
      type: "card",
      brand: "Visa",
      last4: "4242",
    });
    await expect(provider.listPaymentMethods(tenantId)).resolves.toEqual([
      method,
    ]);
    await provider.detachPaymentMethod(tenantId, method.ref);
    await expect(provider.listPaymentMethods(tenantId)).resolves.toEqual([]);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/tokens/delete",
      body: { id: "token_saved" },
    });
  });

  it("verifies raw webhook bytes and parses normalized events", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({
        id: "event_1",
        event: "subscription.charged",
        created_at: 1_785_196_800,
        payload: { subscription: { entity: { id: "sub_123" } } },
      }),
    );
    const signature = createHmac("sha256", "webhook-secret")
      .update(raw)
      .digest("hex");
    expect(
      provider.verifyWebhookSignature(raw, signature, "webhook-secret"),
    ).toBe(true);
    expect(
      provider.verifyWebhookSignature(raw, "00", "webhook-secret"),
    ).toBe(false);
    expect(
      provider.verifyWebhookSignature(
        raw,
        "0".repeat(signature.length),
        "webhook-secret",
      ),
    ).toBe(false);
    expect(provider.parseWebhookEvent(raw)).toMatchObject({
      id: "event_1",
      type: "subscription.charged",
    });
    expect(() =>
      provider.parseWebhookEvent(
        new TextEncoder().encode(
          JSON.stringify({ account_id: "account_1", created_at: 1 }),
        ),
      ),
    ).toThrow("malformed webhook event: event");
  });

  it("health-checks a cheap endpoint and maps provider failures", async () => {
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: "healthy",
    });
    http.request = vi.fn(async () => ({ status: 401, body: {} }));
    await expect(provider.listPlans()).rejects.toMatchObject({
      status: 401,
      name: "RazorpayBillingError",
    });
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: "unhealthy",
    });
    await expect(
      provider.listInvoices(tenantId, "bad", 10),
    ).rejects.toBeInstanceOf(RazorpayBillingError);
  });

  it("maps optional fields, all declared enums, and empty collections", async () => {
    const periods = ["daily", "weekly", "monthly", "yearly"] as const;
    for (const value of periods) {
      http.request = vi.fn(async () => ({
        status: 200,
        body: {
          items: [
            {
              id: `plan_${value}`,
              interval: 1,
              period: value,
              item: {
                name: value,
                amount: 1,
                currency: "INR",
                active: false,
              },
            },
          ],
        },
      }));
      await expect(provider.listPlans()).resolves.toEqual([
        expect.objectContaining({
          period: value,
          active: false,
          description: null,
        }),
      ]);
    }

    http.request = vi.fn(async () => ({ status: 200, body: {} }));
    await expect(provider.listPlans()).resolves.toEqual([]);

    references.subscriptionRef = "sub_123";
    const statuses = [
      "created",
      "authenticated",
      "active",
      "pending",
      "halted",
      "cancelled",
      "completed",
      "expired",
    ] as const;
    for (const value of statuses) {
      http.request = vi.fn(async () => ({
        status: 200,
        body: {
          id: "sub_123",
          plan_id: "plan_basic",
          status: value,
          current_start: null,
          current_end: null,
        },
      }));
      await expect(provider.getSubscription(tenantId)).resolves.toMatchObject({
        status: value,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        providerCustomerRef: null,
      });
    }

    const invoiceStatuses = [
      "draft",
      "issued",
      "partially_paid",
      "paid",
      "cancelled",
      "expired",
      "deleted",
    ] as const;
    for (const value of invoiceStatuses) {
      http.request = vi.fn(async () => ({
        status: 200,
        body: { items: [invoiceFixture({ status: value })] },
      }));
      await expect(provider.listInvoices(tenantId)).resolves.toEqual({
        items: [expect.objectContaining({ status: value })],
        nextCursor: null,
      });
    }
  });

  it("links an invoice's hosted page only when it is an absolute https URL", async () => {
    references.subscriptionRef = "sub_123";
    for (const [shortUrl, expected] of [
      ["https://rzp.io/i/abc", "https://rzp.io/i/abc"],
      ["http://rzp.io/i/abc", null],
      ["javascript:alert(1)", null],
      ["not a url", null],
      [undefined, null],
    ] as const) {
      http.request = vi.fn(async () => ({
        status: 200,
        body: { items: [invoiceFixture({ short_url: shortUrl })] },
      }));
      await expect(provider.listInvoices(tenantId)).resolves.toEqual({
        items: [expect.objectContaining({ documentUrl: expected })],
        nextCursor: null,
      });
    }
  });

  it("rejects malformed provider resources and missing subscription references", async () => {
    await expect(provider.changeSubscription(tenantId, "plan")).rejects.toMatchObject({
      status: 404,
    });

    for (const body of [
      null,
      {
        items: [
          {
            id: "plan",
            interval: 1,
            period: "fortnightly",
            item: { name: "Plan", amount: 1, currency: "INR" },
          },
        ],
      },
      {
        items: [
          {
            interval: 1,
            period: "monthly",
            item: { name: "Plan", amount: 1, currency: "INR" },
          },
        ],
      },
      {
        items: [
          {
            id: "plan",
            interval: 1,
            period: "monthly",
            item: { name: "Plan", amount: "bad", currency: "INR" },
          },
        ],
      },
      {
        items: [
          {
            id: "plan",
            interval: 1,
            period: "monthly",
            item: { name: "Plan", currency: "INR", active: true },
          },
        ],
      },
      {
        items: [
          {
            id: "plan",
            interval: 1,
            period: "monthly",
            item: { name: "Plan", amount: 100, active: true },
          },
        ],
      },
      {
        items: [
          {
            id: "plan",
            interval: 1,
            period: "monthly",
            item: { name: "Plan", amount: 100, currency: "INR" },
          },
        ],
      },
    ]) {
      http.request = vi.fn(async () => ({ status: 200, body }));
      await expect(provider.listPlans()).rejects.toBeInstanceOf(
        RazorpayBillingError,
      );
    }

    references.subscriptionRef = "sub_123";
    http.request = vi.fn(async () => ({
      status: 200,
      body: { id: "sub_123", plan_id: "plan", status: "unknown" },
    }));
    await expect(provider.getSubscription(tenantId)).rejects.toBeInstanceOf(
      RazorpayBillingError,
    );

    http.request = vi.fn(async () => ({
      status: 200,
      body: { id: "sub_123", plan_id: "plan" },
    }));
    await expect(provider.getSubscription(tenantId)).rejects.toBeInstanceOf(
      RazorpayBillingError,
    );
  });

  it("uses fetch transport for body and empty-response requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 204,
        text: async () => "",
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify({ id: "resource_1" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = createFetchRazorpayHttpClient("https://billing.test");
      await expect(
        client.request({
          method: "GET",
          path: "/v1/plans",
          authorization: "Basic redacted",
        }),
      ).resolves.toEqual({ status: 204, body: {} });
      await expect(
        client.request({
          method: "POST",
          path: "/v1/subscriptions",
          authorization: "Basic redacted",
          body: { plan_id: "plan_basic" },
        }),
      ).resolves.toEqual({
        status: 200,
        body: { id: "resource_1" },
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://billing.test/v1/subscriptions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ plan_id: "plan_basic" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("BillingProvider contract", () => {
  it("passes the unmodified suite with the Razorpay adapter", async () => {
    const report = await assertProviderContractParity(
      billingProviderContract,
      [
        { name: "razorpay-primary", create: contractProvider },
        { name: "razorpay-parity", create: contractProvider },
      ],
    );
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(4);
  });
});

class MemoryReferences implements BillingReferenceStore {
  customerRef: string | null = null;
  subscriptionRef: string | null = null;
  methods: PaymentMethodRef[] = [];

  async getTenantReferences() {
    return this.subscriptionRef
      ? {
          providerCustomerRef: this.customerRef,
          subscriptionRef: this.subscriptionRef,
        }
      : null;
  }
  async setSubscriptionReferences(
    _tenantId: string,
    refs: {
      providerCustomerRef: string | null;
      subscriptionRef: string | null;
    },
  ) {
    this.customerRef = refs.providerCustomerRef;
    this.subscriptionRef = refs.subscriptionRef;
  }
  async savePaymentMethod(_tenantId: string, method: PaymentMethodRef) {
    this.methods.push(method);
  }
  async listPaymentMethods() {
    return this.methods;
  }
  async deletePaymentMethod(_tenantId: string, ref: string) {
    this.methods = this.methods.filter((method) => method.ref !== ref);
  }
}

function response(request: RazorpayHttpRequest) {
  if (request.path.startsWith("/v1/plans")) {
    return {
      status: 200,
      body: {
        items: [
          {
            id: "plan_basic",
            interval: 1,
            period: "monthly",
            item: {
              name: "Basic",
              description: "Basic plan",
              amount: 50_000,
              currency: "INR",
              active: true,
            },
          },
        ],
      },
    };
  }
  if (request.path === "/v1/tokens/fetch") {
    return {
      status: 200,
      body: {
        id: "token_saved",
        method: "card",
        card: { network: "Visa", last4: "4242" },
      },
    };
  }
  if (request.path.startsWith("/v1/invoices")) {
    return {
      status: 200,
      body: {
        items: [invoiceFixture()],
      },
    };
  }
  if (
    request.method === "GET" &&
    request.path === "/v1/subscriptions/sub_123"
  ) {
    return {
      status: 200,
      body: {
        id: "sub_123",
        plan_id: "plan_basic",
        status: "active",
        current_start: 1_785_196_800,
        current_end: 1_787_875_200,
        customer_id: "cust_123",
      },
    };
  }
  const body = request.body ?? {};
  return {
    status: 200,
    body: {
      id: "sub_123",
      plan_id:
        typeof body.plan_id === "string"
          ? body.plan_id
          : request.path.endsWith("/cancel")
            ? "plan_pro"
            : "plan_basic",
      status: request.path.endsWith("/cancel") ? "cancelled" : "active",
      customer_id: "cust_123",
      current_start: 1_785_196_800,
      current_end: 1_787_875_200,
    },
  };
}

function invoiceFixture(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "inv_123",
    subscription_id: "sub_123",
    amount: 50_000,
    currency: "INR",
    status: "paid",
    issued_at: 1_785_196_800,
    paid_at: 1_785_196_860,
    short_url: "https://rzp.io/i/inv123",
    ...overrides,
  };
}

function withoutField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function capabilities() {
  return {
    streaming: false,
    tool_calling: false,
    vision: false,
    structured_output: true,
    long_context: false,
    regional_availability: ["local"],
    data_residency: ["local"],
    batch_support: false,
    maximum_payload: 65_536,
    supported_languages: ["en"],
    cost_model: { rates: [] },
  };
}

function contractProvider(): RazorpayBillingProvider {
  const refs = new MemoryReferences();
  const secrets: SecretsProvider = {
    metadata: {
      providerId: "contract-secrets",
      interfaceName: "SecretsProvider",
      displayName: "Contract",
      version: "1",
      telemetryNamespace: "contract.secrets",
      supportsTenantOverrides: false,
      migration: { strategyVersion: "1", rollbackSupported: true },
    },
    capabilities: capabilities(),
    healthCheck: async () => ({
      status: "healthy",
      checkedAt: "2026-07-28T00:00:00.000Z",
      latencyMs: 0,
    }),
    getSecret: async (reference) =>
      reference.endsWith("id") ? "key-id" : "key-secret",
  };
  return new RazorpayBillingProvider(
    {
      keyIdSecretRef: "contract/key-id",
      keySecretSecretRef: "contract/key-secret",
    },
    secrets,
    refs,
    { request: async (request) => response(request) },
    () => new Date("2026-07-28T00:00:00.000Z"),
  );
}

function checkoutPlan() {
  return { id: "plan_basic", interval: 1, period: "monthly",
    item: { name: "Basic", description: null, amount: 11804, currency: "INR", active: true } };
}
function checkoutSubscription() {
  return { id: "sub_123", plan_id: "plan_basic", status: "created", current_start: null,
    current_end: null, customer_id: null, short_url: "https://rzp.io/rzp/fixture" };
}
