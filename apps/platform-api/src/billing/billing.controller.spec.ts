import type {
  BillingEvent,
  BillingPlan,
  BillingProvider,
  Invoice,
  Page,
  PaymentMethodRef,
  ProviderHealth,
  Subscription,
} from "@alterx/shared-clients";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
} from "../concurrency";
import {
  IdempotencyExceptionFilter,
  IdempotencyHttpError,
  IdempotencyInterceptor,
  PgIdempotencyStore,
  type IdempotencyExecution,
  type StoredHttpResponse,
} from "../idempotency";
import {
  RbacModule,
  type ActorContextType,
  type RbacRequest,
} from "../rbac";
import { BillingEtagResolver } from "./billing-etag.resolver";
import { BillingExceptionFilter } from "./billing-exception.filter";
import { BillingWebhookService } from "./billing-webhook.service";
import { BillingHttpError } from "./problem";
import { BillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";
import { BILLING_PROVIDER } from "./tokens";
import {
  billingDeferredCapabilities,
  type BillingProfileRecord,
} from "./types";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";
const owner: ActorContextType = {
  user_id: "018f47a5-7b2c-7d10-8f11-123456789abd",
  tenant_id: tenantId,
  session_id: "session",
  roles: ["owner"],
  permissions: ["billing:read", "billing:write"],
};
const admin: ActorContextType = {
  ...owner,
  roles: ["admin"],
  permissions: ["billing:read"],
};

describe("billing routes", () => {
  let app: NestFastifyApplication;
  const repository = new MemoryBillingRepository();
  const provider = new MemoryBillingProvider();
  const store = new MemoryIdempotencyStore();
  const webhookService = {
    receive: vi.fn(async () => ({
      accepted: true as const,
      event_id: "event_1",
      state: "active" as const,
      replayed: false,
    })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [BillingController],
      providers: [
        BillingService,
        BillingEtagResolver,
        BillingExceptionFilter,
        {
          provide: BillingWebhookService,
          useValue: webhookService,
        },
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        IfMatchGuard,
        EtagResponseInterceptor,
        ConcurrencyExceptionFilter,
        { provide: BillingRepository, useValue: repository },
        { provide: BILLING_PROVIDER, useValue: provider },
        { provide: PgIdempotencyStore, useValue: store },
        {
          provide: ETAG_RESOURCE_RESOLVER,
          useExisting: BillingEtagResolver,
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { rawBody: true },
    );
    app.getHttpAdapter().getInstance().addHook(
      "preHandler",
      (request: FastifyRequest, _reply: unknown, done: () => void) => {
        const encoded = request.headers["x-test-actor"];
        if (typeof encoded === "string") {
          (request as RbacRequest).actorContext = JSON.parse(
            encoded,
          ) as ActorContextType;
        }
        done();
      },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    repository.clear();
    provider.clear();
    store.clear();
    webhookService.receive.mockClear();
  });

  afterAll(async () => app.close());

  it("relays exact raw webhook bytes without bearer auth", async () => {
    const payload = '{"id":"event_1", "amount":100}';
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "signature",
        "x-razorpay-event-id": "event_1",
      },
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(webhookService.receive).toHaveBeenCalledWith(
      "razorpay",
      Buffer.from(payload),
      "signature",
      "event_1",
    );

    const unsigned = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhooks/razorpay",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(unsigned.statusCode).toBe(202);
    expect(webhookService.receive).toHaveBeenLastCalledWith(
      "razorpay",
      Buffer.from("{}"),
      "",
      "",
    );

    const controller = new BillingController(
      {} as BillingService,
      webhookService as unknown as BillingWebhookService,
    );
    expect(() =>
      controller.webhook(
        "razorpay",
        undefined,
        undefined,
        {} as Parameters<BillingController["webhook"]>[3],
      ),
    ).toThrow(BillingHttpError);
  });

  it("serves plans, subscription, invoices, and payment methods", async () => {
    expect((await request("GET", "/api/v1/billing/plans", admin)).statusCode).toBe(
      200,
    );
    const attached = await request(
      "POST",
      "/api/v1/billing/payment-methods",
      owner,
      {
        headers: { "idempotency-key": "attach-1" },
        payload: { provider_token: "token_reference_1" },
      },
    );
    expect(attached.statusCode).toBe(201);
    expect(attached.json()).toEqual({
      ref: "token_reference_1",
      type: "card",
      brand: "Visa",
      last4: "4242",
    });
    const created = await create();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      planId: "plan_basic",
      status: "active",
    });
    const detail = await request(
      "GET",
      "/api/v1/billing/subscription",
      admin,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.headers.etag).toBeTypeOf("string");
    const invoices = await request(
      "GET",
      "/api/v1/billing/invoices?cursor=0&limit=20",
      admin,
    );
    expect(invoices.json()).toMatchObject({
      items: [expect.objectContaining({ id: "inv_1" })],
      nextCursor: null,
    });
    expect(
      (
        await request("GET", "/api/v1/billing/payment-methods", admin)
      ).json(),
    ).toEqual([attached.json()]);
    expect(
      (
        await request(
          "DELETE",
          "/api/v1/billing/payment-methods/token_reference_1",
          owner,
          { headers: { "idempotency-key": "detach-1" } },
        )
      ).statusCode,
    ).toBe(204);
  });

  it("returns no subscription when provider has none", async () => {
    const response = await request(
      "GET",
      "/api/v1/billing/subscription",
      admin,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("rejects provider subscriptions missing a local billing profile", async () => {
    provider.subscription = subscription(tenantId, "plan_basic", "active");
    const response = await request(
      "GET",
      "/api/v1/billing/subscription",
      admin,
    );
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error_code: "BILLING_PROFILE_INCONSISTENT",
    });
  });

  it("replays subscription create without a second provider charge", async () => {
    const options = {
      headers: { "idempotency-key": "subscription-replay" },
      payload: {
        plan_id: "plan_basic",
        payment_method_ref: "token_reference_1",
      },
    };
    const first = await request(
      "POST",
      "/api/v1/billing/subscription",
      owner,
      options,
    );
    const replay = await request(
      "POST",
      "/api/v1/billing/subscription",
      owner,
      options,
    );
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(provider.createSubscription).toHaveBeenCalledOnce();
  });

  it("returns 412 for stale subscription If-Match before provider mutation", async () => {
    await create();
    const response = await request(
      "PATCH",
      "/api/v1/billing/subscription",
      owner,
      {
        headers: {
          "idempotency-key": "change-stale",
          "if-match": '"stale"',
        },
        payload: { plan_id: "plan_pro" },
      },
    );
    expect(response.statusCode).toBe(412);
    expect(provider.changeSubscription).not.toHaveBeenCalled();
  });

  it("changes and cancels subscriptions with owner scope", async () => {
    await create();
    const detail = await request(
      "GET",
      "/api/v1/billing/subscription",
      owner,
    );
    const changed = await request(
      "PATCH",
      "/api/v1/billing/subscription",
      owner,
      {
        headers: {
          "idempotency-key": "change-1",
          "if-match": String(detail.headers.etag),
        },
        payload: { plan_id: "plan_pro" },
      },
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ planId: "plan_pro" });
    const cancelled = await request(
      "DELETE",
      "/api/v1/billing/subscription",
      owner,
      { headers: { "idempotency-key": "cancel-1" } },
    );
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
  });

  it("enforces admin read and owner write roles plus permissions", async () => {
    const deniedRead = await request("GET", "/api/v1/billing/plans", {
      ...admin,
      permissions: [],
    });
    expect(deniedRead.statusCode).toBe(403);
    const deniedWrite = await request(
      "POST",
      "/api/v1/billing/subscription",
      admin,
      {
        headers: { "idempotency-key": "admin-write" },
        payload: {
          plan_id: "plan_basic",
          payment_method_ref: "token_reference_1",
        },
      },
    );
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });

  it("rejects card data and keeps all sensitive values out of responses and logs", async () => {
    const cardNumber = "4111111111111111";
    const cvv = "987-cvv-never-log";
    const providerSecret = "rzp_secret_never_log";
    const logs: unknown[][] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      }),
    );
    try {
      const responses = [
        await request(
        "POST",
        "/api/v1/billing/payment-methods",
        owner,
        {
          headers: { "idempotency-key": "reject-pan" },
          payload: {
            provider_token: "token_reference_1",
            card_number: cardNumber,
            cvv,
          },
        },
        ),
      ];
      expect(responses[0]?.statusCode).toBe(400);

      responses.push(
        await request("GET", "/api/v1/billing/plans", admin),
        await request(
          "POST",
          "/api/v1/billing/payment-methods",
          owner,
          {
            headers: { "idempotency-key": "security-attach" },
            payload: { provider_token: "token_reference_security" },
          },
        ),
        await request("POST", "/api/v1/billing/subscription", owner, {
          headers: { "idempotency-key": "security-create" },
          payload: {
            plan_id: "plan_basic",
            payment_method_ref: "token_reference_security",
          },
        }),
        await request("GET", "/api/v1/billing/subscription", admin),
        await request("GET", "/api/v1/billing/invoices", admin),
        await request("GET", "/api/v1/billing/payment-methods", admin),
      );
      const subscriptionResponse = responses.at(-3)!;
      responses.push(
        await request(
          "PATCH",
          "/api/v1/billing/subscription",
          owner,
          {
            headers: {
              "idempotency-key": "security-change",
              "if-match": String(subscriptionResponse.headers.etag),
            },
            payload: { plan_id: "plan_pro" },
          },
        ),
        await request(
          "DELETE",
          "/api/v1/billing/payment-methods/token_reference_security",
          owner,
          { headers: { "idempotency-key": "security-detach" } },
        ),
        await request(
          "DELETE",
          "/api/v1/billing/subscription",
          owner,
          { headers: { "idempotency-key": "security-cancel" } },
        ),
      );

      const output =
        responses.map((response) => response.body).join("\n") +
        JSON.stringify(logs);
      for (const secret of [cardNumber, cvv, providerSecret]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("maps provider failures to problem+json for every surface", async () => {
    for (const testCase of [
      ["GET", "/api/v1/billing/plans", admin, undefined],
      ["GET", "/api/v1/billing/subscription", admin, undefined],
      ["GET", "/api/v1/billing/invoices", admin, undefined],
      ["GET", "/api/v1/billing/payment-methods", admin, undefined],
      [
        "POST",
        "/api/v1/billing/payment-methods",
        owner,
        { provider_token: "token_reference_1" },
      ],
    ] as const) {
      provider.failNext = true;
      const response = await request(testCase[0], testCase[1], testCase[2], {
        headers: { "idempotency-key": `failure-${testCase[1]}` },
        ...(testCase[3] === undefined ? {} : { payload: testCase[3] }),
      });
      expect(response.statusCode).toBe(502);
      expect(response.headers["content-type"]).toContain(
        "application/problem+json",
      );
    }
  });

  it("flags deferred ledger surfaces without fake routes", async () => {
    expect(billingDeferredCapabilities).toEqual([
      expect.objectContaining({
        capability: "overage_billing",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "invoice_cost_ledger_reconciliation",
        status: "NOT_MET",
      }),
    ]);
    expect(
      (
        await request("GET", "/api/v1/billing/overage", owner)
      ).statusCode,
    ).toBe(404);
  });

  function create() {
    return request("POST", "/api/v1/billing/subscription", owner, {
      headers: { "idempotency-key": `create-${crypto.randomUUID()}` },
      payload: {
        plan_id: "plan_basic",
        payment_method_ref: "token_reference_1",
      },
    });
  }

  function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    actor: ActorContextType,
    options: {
      headers?: Record<string, string>;
      payload?: Record<string, unknown>;
    } = {},
  ) {
    return app.inject({
      method,
      url,
      headers: {
        "x-test-actor": JSON.stringify(actor),
        ...options.headers,
      },
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  }
});

class MemoryBillingProvider implements BillingProvider {
  readonly metadata = {
    providerId: "memory-billing",
    interfaceName: "BillingProvider" as const,
    displayName: "Memory",
    version: "1",
    telemetryNamespace: "test.billing",
    supportsTenantOverrides: false,
    migration: { strategyVersion: "1", rollbackSupported: true },
  };
  readonly capabilities = {
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
  subscription: Subscription | null = null;
  methods: PaymentMethodRef[] = [];
  failNext = false;

  createSubscription = vi.fn(
    async (tenant: string, planId: string): Promise<Subscription> => {
      this.maybeFail();
      return (this.subscription = subscription(tenant, planId, "active"));
    },
  );
  changeSubscription = vi.fn(
    async (tenant: string, planId: string): Promise<Subscription> => {
      this.maybeFail();
      return (this.subscription = subscription(tenant, planId, "active"));
    },
  );

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
  }
  async listPlans(): Promise<BillingPlan[]> {
    this.maybeFail();
    return [
      {
        id: "plan_basic",
        name: "Basic",
        description: null,
        amount: 50_000,
        currency: "INR",
        interval: 1,
        period: "monthly",
        active: true,
      },
    ];
  }
  async getSubscription(): Promise<Subscription | null> {
    this.maybeFail();
    return this.subscription;
  }
  async cancelSubscription(): Promise<Subscription> {
    this.maybeFail();
    if (!this.subscription) throw new Error("missing");
    return (this.subscription = {
      ...this.subscription,
      status: "cancelled",
    });
  }
  async listInvoices(): Promise<Page<Invoice>> {
    this.maybeFail();
    return {
      items: [
        {
          id: "inv_1",
          subscriptionId: "sub_1",
          amount: 50_000,
          currency: "INR",
          status: "paid",
          issuedAt: "2026-07-28T00:00:00.000Z",
          paidAt: "2026-07-28T00:01:00.000Z",
          documentUrl: null,
        },
      ],
      nextCursor: null,
    };
  }
  async attachPaymentMethod(
    _tenant: string,
    providerToken: string,
  ): Promise<PaymentMethodRef> {
    this.maybeFail();
    const method = {
      ref: providerToken,
      type: "card",
      brand: "Visa",
      last4: "4242",
    };
    this.methods.push(method);
    return method;
  }
  async listPaymentMethods(): Promise<PaymentMethodRef[]> {
    this.maybeFail();
    return this.methods;
  }
  async detachPaymentMethod(_tenant: string, ref: string): Promise<void> {
    this.maybeFail();
    this.methods = this.methods.filter((method) => method.ref !== ref);
  }
  async refundPayment(
    paymentRef: string,
    amountMinor: number,
    speed: "normal" | "optimum",
  ) {
    return {
      id: `rfnd_${paymentRef}`,
      paymentRef,
      amount: amountMinor,
      currency: "INR",
      status: "processed",
      speed,
      createdAt: "2026-07-28T00:02:00.000Z",
    };
  }
  async resolveDispute(
    disputeRef: string,
    resolution: { action: "accept" | "contest" },
  ) {
    return {
      id: disputeRef,
      paymentRef: "pay_test",
      amount: 1_000,
      currency: "INR",
      status: resolution.action === "accept" ? "lost" as const : "under_review" as const,
      phase: "chargeback",
      respondBy: null,
    };
  }
  verifyWebhookSignature(): boolean {
    return false;
  }
  parseWebhookEvent(): BillingEvent {
    throw new Error("unused");
  }
  clear(): void {
    this.subscription = null;
    this.methods = [];
    this.failNext = false;
    this.createSubscription.mockClear();
    this.changeSubscription.mockClear();
  }
  private maybeFail(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider down");
    }
  }
}

class MemoryBillingRepository {
  profile: BillingProfileRecord | null = null;
  version = 0;

  async getProfile(): Promise<BillingProfileRecord | null> {
    return this.profile;
  }
  async syncSubscription(
    tenant: string,
    value: Subscription,
  ): Promise<BillingProfileRecord> {
    this.version += 1;
    return (this.profile = {
      tenantId: tenant,
      id: "018f47a5-7b2c-7d10-8f11-123456789abe",
      providerId: "memory",
      providerCustomerRef: value.providerCustomerRef,
      subscriptionRef: value.id,
      status: value.status,
      currentPlan: value.planId,
      createdAt: new Date("2026-07-28T00:00:00.000Z"),
      updatedAt: new Date(`2026-07-28T00:00:0${this.version}.000Z`),
    });
  }
  clear(): void {
    this.profile = null;
    this.version = 0;
  }
}

class MemoryIdempotencyStore {
  private readonly responses = new Map<
    string,
    StoredHttpResponse & { fingerprint: string }
  >();

  async execute(
    execution: IdempotencyExecution,
    operation: () => Promise<StoredHttpResponse>,
  ) {
    if (!execution.key) {
      throw new IdempotencyHttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required",
        execution.instance,
      );
    }
    const key = `${execution.tenantId}:${execution.key}`;
    const existing = this.responses.get(key);
    if (existing) {
      return { status: existing.status, body: existing.body, replayed: true };
    }
    const response = await operation();
    this.responses.set(key, { ...response, fingerprint: execution.fingerprint });
    return { ...response, replayed: false };
  }
  clear(): void {
    this.responses.clear();
  }
}

function subscription(
  tenant: string,
  planId: string,
  status: Subscription["status"],
): Subscription {
  return {
    id: "sub_1",
    tenantId: tenant,
    planId,
    status,
    currentPeriodStart: "2026-07-28T00:00:00.000Z",
    currentPeriodEnd: "2026-08-28T00:00:00.000Z",
    providerCustomerRef: "cust_1",
  };
}
