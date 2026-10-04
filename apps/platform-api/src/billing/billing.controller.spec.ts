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
import { randomUUID } from "node:crypto";
import { readdirSync,readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { PLAN_DEFINITION_STORE,PostgresPlanDefinitionStore } from "../entitlements/plan-definition-store";
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
  IdempotencyInterceptor,
  PgIdempotencyStore,
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

describe.skipIf(!process.env.DATABASE_URL)("billing routes with ordinary PostgreSQL RLS", () => {
  let app: NestFastifyApplication;
  let repository: BillingRepository,definitions:PostgresPlanDefinitionStore,store:PgIdempotencyStore;
  let databaseAdmin:pg.Client,pool:pg.Pool,schema:string,role:string;
  const versions:Record<string,string>={};
  const provider = new MemoryBillingProvider();
  const webhookService = {
    receive: vi.fn(async () => ({
      accepted: true as const,
      event_id: "event_1",
      state: "active" as const,
      replayed: false,
    })),
  };

  beforeAll(async () => {
    schema=`billing_http_${randomUUID().replaceAll("-","_")}`;role=`billing_http_${randomUUID().replaceAll("-","_")}`;
    databaseAdmin=new pg.Client({connectionString:process.env.DATABASE_URL});await databaseAdmin.connect();
    await databaseAdmin.query(`CREATE SCHEMA ${schema}`);await databaseAdmin.query(`SET search_path TO ${schema}`);
    const directory=resolve("apps/platform-api/src/db/migrations");
    for(const name of readdirSync(directory).filter(name=>name.endsWith(".sql")).sort())for(const statement of readFileSync(resolve(directory,name),"utf8").split("--> statement-breakpoint"))if(statement.trim())await databaseAdmin.query(statement);
    const password=randomUUID();await databaseAdmin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
    await databaseAdmin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await databaseAdmin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password;url.searchParams.set("options",`-c search_path=${schema}`);pool=new pg.Pool({connectionString:url.href});
    await databaseAdmin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Billing HTTP','active')",[tenantId]);
    await databaseAdmin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_http','auth0|billing-http','billing-http@example.test',ARRAY['staff_admin'])");
    repository=new BillingRepository(pool);definitions=new PostgresPlanDefinitionStore(pool);store=new PgIdempotencyStore(pool,3600000);
    for(const plan of ["basic","pro"]){const result=await definitions.upsert(plan,{maxWorkflows:3,maxProjects:1,maxRunsPerDay:25,maxConcurrentRuns:1,maxSandboxMinutesPerMonth:30,maxAdsStorageMb:500,maxIntegrations:3},"stf_http",
      {currency:"INR",basePriceMinor:10000,razorpayPlanId:`plan_${plan}`,includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2},"HTTP fixture configuration");versions[plan]=result.record.updatedAt.toISOString();}
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
        { provide: PLAN_DEFINITION_STORE,useValue:definitions },
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
  },60000);

  beforeEach(async () => {
    await databaseAdmin.query("UPDATE tenants SET billing_profile_id=NULL;DELETE FROM billing_dunning_audits;DELETE FROM billing_dunning_states;DELETE FROM billing_subscription_plans;DELETE FROM billing_credit_deliveries;DELETE FROM billing_profiles;DELETE FROM idempotency_keys");
    provider.clear();
    webhookService.receive.mockClear();
  });

  afterAll(async () => {await app?.close();await pool?.end();if(databaseAdmin){await databaseAdmin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await databaseAdmin.query(`DROP ROLE IF EXISTS ${role}`);await databaseAdmin.end();}});

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
      planId: "basic",
      status: "created",
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

  it("does not expose an unbound provider subscription as a tenant purchase", async () => {
    provider.subscription = subscription(tenantId, "plan_basic", "active");
    const response = await request(
      "GET",
      "/api/v1/billing/subscription",
      admin,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("replays subscription create without a second provider charge", async () => {
    const options = {
      headers: { "idempotency-key": "subscription-replay" },
      payload: {
        plan_id: "basic",
        plan_version: versions.basic,
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
    expect(first.statusCode).toBe(201);
    expect(provider.createCheckoutSubscription).toHaveBeenCalledOnce();
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
        payload: { plan_id: "pro",plan_version:versions.pro },
      },
    );
    expect(response.statusCode).toBe(412);
    expect(provider.changeConfiguredSubscription).not.toHaveBeenCalled();
  });

  it("changes and cancels subscriptions with owner scope", async () => {
    await create();
    await databaseAdmin.query("UPDATE billing_profiles SET status='active' WHERE tenant_id=$1",[tenantId]);
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
        payload: { plan_id: "pro",plan_version:versions.pro },
      },
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ planId: "basic",pendingPlan:"pro",pendingOperation:"change" });
    // Provider callback reconciliation is exercised through signed HTTP in the cross-service suite.
    await databaseAdmin.query("UPDATE billing_profiles SET current_plan=pending_plan,provider_plan_ref=pending_provider_plan_ref,commercial_snapshot=pending_commercial_snapshot,mutation_attempt_id=NULL,mutation_kind=NULL,pending_plan=NULL,pending_provider_plan_ref=NULL,pending_commercial_snapshot=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1",[tenantId]);
    const refreshed=await request("GET","/api/v1/billing/subscription",owner);
    const cancelled = await request(
      "DELETE",
      "/api/v1/billing/subscription",
      owner,
      { headers: { "idempotency-key": "cancel-1","if-match":String(refreshed.headers.etag) } },
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "active",pendingOperation:"cancel" });
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
      if(testCase[1]==="/api/v1/billing/subscription") {
        const definition=(await definitions.find("basic"))!,attempt=await repository.claimCheckout(tenantId,owner.user_id,definition);
        await repository.finishCheckout(tenantId,owner.user_id,attempt,subscription(tenantId,"plan_basic","created"));
      }
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
        plan_id: "basic",
        plan_version: versions.basic,
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
  createCheckoutSubscription=vi.fn(async(tenant:string,planId:string):Promise<Subscription>=>{
    this.maybeFail();return (this.subscription={...subscription(tenant,planId,"created"),checkoutUrl:"https://rzp.io/i/httpfixture"});
  });
  changeConfiguredSubscription=vi.fn(async(tenant:string,_subscriptionId:string,planId:string):Promise<Subscription>=>{
    this.maybeFail();return (this.subscription=subscription(tenant,planId,"active"));
  });
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
    this.createCheckoutSubscription.mockClear();
    this.changeConfiguredSubscription.mockClear();
    this.changeSubscription.mockClear();
  }
  private maybeFail(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider down");
    }
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
