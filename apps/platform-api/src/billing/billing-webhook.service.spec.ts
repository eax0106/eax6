import type { BillingPolicyService } from "./billing-policy.service";
import type { SubscriptionLifecycleRow } from "./billing-webhook.repository";
import type {
  BillingEvent,
  BillingProvider,
  SecretsProvider,
} from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigProvider,
  EntitlementProvider,
} from "../entitlements";
import type { PgIdempotencyStore } from "../idempotency";
import type {
  DunningStateRecord,
} from "./billing-webhook.repository";
import { BillingWebhookRepository } from "./billing-webhook.repository";
import { BillingWebhookService } from "./billing-webhook.service";
import { BillingHttpError } from "./problem";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";
const limited = {
  maxWorkflows: 1,
  maxProjects: 1,
  maxRunsPerDay: 2,
  maxConcurrentRuns: 1,
  maxSandboxMinutesPerMonth: 5,
  maxAdsStorageMb: 100,
  maxIntegrations: 1,
};

describe("BillingWebhookService", () => {
  let provider: BillingProvider;
  let secrets: SecretsProvider;
  let repository: MemoryWebhookRepository;
  let idempotency: MemoryIdempotencyStore;
  let entitlements: EntitlementProvider;
  let config: ConfigProvider;
  let implementation: BillingWebhookService;
  let service: {
    receive(
      providerId: string,
      rawBody: Uint8Array,
      signature: string,
    ): ReturnType<BillingWebhookService["receive"]>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    provider = providerMock();
    secrets = {
      getSecret: vi.fn(async () => "webhook-secret"),
    } as unknown as SecretsProvider;
    repository = new MemoryWebhookRepository();
    idempotency = new MemoryIdempotencyStore();
    entitlements = {
      createEntitlement: vi.fn(async (_tenantId, plan, _client, options) => ({
        tenantId,
        plan,
        limits: limited,
        accessState: options?.accessState ?? "active",
        source: "config" as const,
      })),
      getEffectiveEntitlement: vi.fn(),
      checkLimit: vi.fn(),
    };
    config = {
      getEntitlementDefaults: vi.fn(async () => limited),
      getAbuseThresholds: vi.fn(),
      getDunningConfig: vi.fn(async () => ({
        gracePeriodSeconds: 60,
        suspensionThresholdSeconds: 120,
        limitedStateLimits: limited,
      })),
    };
    implementation = new BillingWebhookService(
      provider,
      secrets,
      "razorpay/webhook",
      idempotency as unknown as PgIdempotencyStore,
      repository,
      entitlements,
      config,
      { prepare: vi.fn(async () => {}) } as unknown as BillingPolicyService,
    );
    service = {
      receive: (providerId, rawBody, signature) =>
        implementation.receive(
          providerId,
          rawBody,
          signature,
          eventIdFrom(rawBody),
        ),
    };
  });

  afterEach(() => vi.useRealTimers());

  it("verifies exact raw bytes before purchase processing and upgrades plan", async () => {
    const raw = eventBytes("evt_purchase", "subscription.activated", "plan_pro");
    await expect(
      service.receive("razorpay", raw, "valid"),
    ).resolves.toEqual({
      accepted: true,
      event_id: "evt_purchase",
      state: "active",
      replayed: false,
    });

    expect(provider.verifyWebhookSignature).toHaveBeenCalledWith(
      raw,
      "valid",
      "webhook-secret",
    );
    expect(provider.parseWebhookEvent).toHaveBeenCalledAfter(
      vi.mocked(provider.verifyWebhookSignature),
    );
    expect(entitlements.createEntitlement).toHaveBeenCalledWith(
      tenantId,
      "plan_basic",
      repository.client,
      { accessState: "active" },
    );
    expect(repository.events[0]).toMatchObject({
      tenantId,
      providerEventId: "evt_purchase",
      processed: true,
    });
    expect(repository.audits).toEqual([
      expect.objectContaining({
        fromState: "active",
        toState: "active",
        reason: "payment_succeeded",
      }),
    ]);
  });

  it("moves grace to limited to suspended from config, then recovers", async () => {
    await service.receive(
      "razorpay",
      eventBytes("evt_failed_1", "subscription.pending"),
      "valid",
    );
    expect(repository.state.state).toBe("grace");

    vi.advanceTimersByTime(61_000);
    await service.receive(
      "razorpay",
      eventBytes("evt_failed_2", "subscription.pending"),
      "valid",
    );
    expect(repository.state.state).toBe("limited");
    expect(entitlements.createEntitlement).toHaveBeenLastCalledWith(
      tenantId,
      "plan_basic",
      repository.client,
      { accessState: "limited" },
    );

    vi.advanceTimersByTime(60_000);
    await service.receive(
      "razorpay",
      eventBytes("evt_failed_3", "subscription.pending"),
      "valid",
    );
    expect(repository.state.state).toBe("suspended");
    expect(entitlements.createEntitlement).toHaveBeenLastCalledWith(
      tenantId,
      "plan_basic",
      repository.client,
      { accessState: "suspended" },
    );

    await service.receive(
      "razorpay",
      eventBytes("evt_recovered", "subscription.activated"),
      "valid",
    );
    expect(repository.state).toEqual({
      state: "active",
      currentPlan: "plan_basic",
      firstFailedAt: null,
    });
    expect(entitlements.createEntitlement).toHaveBeenLastCalledWith(
      tenantId,
      "plan_basic",
      repository.client,
      { accessState: "active" },
    );
    expect(config.getDunningConfig).toHaveBeenCalledTimes(3);
    expect(repository.audits.map((audit) => audit.toState)).toEqual([
      "grace",
      "limited",
      "suspended",
      "active",
    ]);
  });

  it("rejects invalid signatures before parsing or database writes", async () => {
    vi.mocked(provider.verifyWebhookSignature).mockReturnValue(false);
    await expect(
      service.receive(
        "razorpay",
        eventBytes("evt_invalid", "subscription.pending"),
        "invalid",
      ),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(provider.parseWebhookEvent).not.toHaveBeenCalled();
    expect(repository.transactionCalls).toBe(0);
    expect(entitlements.createEntitlement).not.toHaveBeenCalled();
  });

  it("replays provider event id without applying entitlement twice", async () => {
    const raw = eventBytes("evt_replay", "subscription.activated", "plan_pro");
    await service.receive("razorpay", raw, "valid");
    await expect(service.receive("razorpay", raw, "valid")).resolves.toMatchObject({
      replayed: true,
    });
    expect(entitlements.createEntitlement).toHaveBeenCalledTimes(1);
    expect(repository.transactionCalls).toBe(1);
  });

  it("uses Razorpay event-id header, never account or body id, for dedupe", async () => {
    const raw = eventBytes(
      "body-or-account-id",
      "subscription.activated",
      "plan_pro",
    );
    await implementation.receive(
      "razorpay",
      raw,
      "valid",
      "header-event-id",
    );
    expect(repository.events[0]).toMatchObject({
      providerEventId: "header-event-id",
    });
    await expect(
      implementation.receive(
        "razorpay",
        raw,
        "valid",
        "header-event-id",
      ),
    ).resolves.toMatchObject({ replayed: true });
    expect(entitlements.createEntitlement).toHaveBeenCalledOnce();
  });

  it("rolls back event when entitlement creation fails", async () => {
    vi.mocked(entitlements.createEntitlement).mockRejectedValueOnce(
      new Error("entitlement write failed"),
    );
    await expect(
      service.receive(
        "razorpay",
        eventBytes("evt_rollback", "subscription.activated", "plan_pro"),
        "valid",
      ),
    ).rejects.toThrow("entitlement write failed");
    expect(repository.events).toHaveLength(0);
    expect(repository.markProcessedCalls).toBe(0);
    expect(idempotency.size).toBe(0);
  });

  it("redacts payment credentials from persisted payload", async () => {
    const raw = eventBytes("evt_secret", "subscription.pending", undefined, {
      card_number: "4111111111111111",
      cvv: "987",
      provider_token: "token_secret",
    });
    await service.receive("razorpay", raw, "valid");
    const transcript = JSON.stringify(repository.events);
    expect(transcript).not.toContain("4111111111111111");
    expect(transcript).not.toContain("987");
    expect(transcript).not.toContain("token_secret");
    expect(transcript).toContain("[REDACTED]");
  });

  it("maps malformed payloads and unavailable secrets without leaks", async () => {
    vi.mocked(provider.parseWebhookEvent).mockImplementationOnce(() => {
      throw new Error("raw provider detail");
    });
    await expect(
      service.receive("razorpay", new TextEncoder().encode("{}"), "valid"),
    ).rejects.toSatisfy(
      (error: BillingHttpError) =>
        error.getStatus() === 400 &&
        !JSON.stringify(error.getResponse()).includes("raw provider detail"),
    );

    vi.mocked(secrets.getSecret).mockRejectedValueOnce(
      new Error("secret-name-and-value"),
    );
    await expect(
      service.receive("razorpay", eventBytes("evt_x", "subscription.pending"), "valid"),
    ).rejects.toSatisfy(
      (error: BillingHttpError) =>
        error.getStatus() === 502 &&
        !JSON.stringify(error.getResponse()).includes("secret-name-and-value"),
    );
  });

  it("rejects unknown providers, missing signatures, tenants, and plans", async () => {
    const raw = eventBytes("evt_x", "subscription.pending");
    await expect(
      service.receive("stripe", raw, "valid"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.receive("razorpay", raw, ""),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      implementation.receive("razorpay", raw, "valid", ""),
    ).rejects.toMatchObject({ status: 400 });

    vi.mocked(provider.parseWebhookEvent).mockReturnValueOnce({
      id: "evt_no_tenant",
      type: "subscription.pending",
      createdAt: "2026-07-28T00:00:00.000Z",
      payload: {},
    });
    await expect(
      service.receive("razorpay", raw, "valid"),
    ).rejects.toMatchObject({ status: 400 });

    repository.profile.current_plan = null;
    await expect(
      service.receive(
        "razorpay",
        eventBytes("evt_no_plan", "subscription.activated"),
        "valid",
      ),
    ).rejects.toMatchObject({ status: 503 });

  });

  it("accepts unknown event types and database-level duplicate events", async () => {
    await expect(
      service.receive(
        "razorpay",
        eventBytes("evt_ignored", "invoice.issued"),
        "valid",
      ),
    ).resolves.toMatchObject({ state: "active" });
    expect(entitlements.createEntitlement).not.toHaveBeenCalled();

    repository.events.push({
      tenantId,
      providerEventId: "evt_db_duplicate",
      processed: true,
    });
    await expect(
      service.receive(
        "razorpay",
        eventBytes("evt_db_duplicate", "subscription.pending"),
        "valid",
      ),
    ).resolves.toMatchObject({ state: "active", replayed: false });
  });

  it("keeps grace unchanged before configured duration and accepts payment notes", async () => {
    repository.state = {
      state: "grace",
      currentPlan: "plan_basic",
      firstFailedAt: new Date("2026-07-28T00:00:00.000Z"),
    };
    vi.advanceTimersByTime(30_000);
    const raw = new TextEncoder().encode(
      JSON.stringify({
        id: "evt_payment_notes",
        event: "subscription.pending",
        created_at: Math.floor(Date.now()/1000),
        payload: {
          subscription: { entity: { id: "sub_fixture", plan_id: "plan_pro", status: "pending" } },
          payment: {
            entity: {
              notes: { tenant_id: tenantId },
              tags: [{ cvv: "123" }],
            },
          },
        },
      }),
    );
    await expect(
      service.receive("razorpay", raw, "valid"),
    ).resolves.toMatchObject({ state: "grace" });
    expect(repository.audits).toHaveLength(0);
  });
});

class MemoryWebhookRepository extends BillingWebhookRepository {
  readonly client = {} as PoolClient;
  events: Array<Record<string, unknown>> = [];
  audits: Array<Record<string, unknown>> = [];
  state: DunningStateRecord = {
    state: "active",
    currentPlan: "plan_basic",
    firstFailedAt: null,
  };
  profile: SubscriptionLifecycleRow = { subscription_ref:"sub_fixture",provider_plan_ref:"plan_pro",current_plan:"plan_basic",status:"active",checkout_attempt_id:null,last_provider_event_at:"0",
    commercial_snapshot:{currency:"INR",basePriceMinor:10000,razorpayPlanId:"plan_pro",includedCredits:100,extraCreditPriceMinor:50,creditsPerVerifiedRun:2} };
  override async lockProfile() { return this.profile; }
  override async historicalPlan() { return null; }
  override async clearMutation() { this.profile.mutation_attempt_id=null;this.profile.mutation_kind=null; }
  override async updateProviderState(_client:PoolClient,_tenantId:string,status:string,timestamp:number) { this.profile.status=status;this.profile.last_provider_event_at=String(timestamp); }
  transactionCalls = 0;
  markProcessedCalls = 0;

  constructor() {
    super({} as never);
  }

  override async transaction<T>(
    _tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    const snapshot = structuredClone({
      events: this.events,
      audits: this.audits,
      state: this.state,
      profile: this.profile,
      markProcessedCalls: this.markProcessedCalls,
    });
    try {
      return await operation(this.client);
    } catch (error) {
      this.events = snapshot.events;
      this.audits = snapshot.audits;
      this.state = snapshot.state;
      this.profile = snapshot.profile;
      this.markProcessedCalls = snapshot.markProcessedCalls;
      throw error;
    }
  }

  override async insertEvent(
    _client: PoolClient,
    input: Parameters<BillingWebhookRepository["insertEvent"]>[1],
  ): Promise<boolean> {
    if (
      this.events.some(
        (event) => event.providerEventId === input.providerEventId,
      )
    ) {
      return false;
    }
    this.events.push({ ...input, processed: false });
    return true;
  }

  override async markEventProcessed(
    _client: PoolClient,
    _tenantId: string,
    providerEventId: string,
  ): Promise<void> {
    this.markProcessedCalls += 1;
    const event = this.events.find(
      (candidate) => candidate.providerEventId === providerEventId,
    );
    if (event) event.processed = true;
  }

  override async getDunningState(): Promise<DunningStateRecord> {
    return { ...this.state };
  }

  override async saveDunningState(
    _client: PoolClient,
    _tenantId: string,
    state: DunningStateRecord,
  ): Promise<void> {
    this.state = { ...state };
  }

  override async auditTransition(
    _client: PoolClient,
    input: Parameters<BillingWebhookRepository["auditTransition"]>[1],
  ): Promise<void> {
    this.audits.push({ ...input });
  }
}

class MemoryIdempotencyStore {
  private readonly values = new Map<string, unknown>();

  get size(): number {
    return this.values.size;
  }

  async execute(
    execution: { key: string },
    operation: () => Promise<{ status: number; body: unknown }>,
  ) {
    if (this.values.has(execution.key)) {
      return {
        status: 202,
        body: this.values.get(execution.key),
        replayed: true,
      };
    }
    const response = await operation();
    this.values.set(execution.key, response.body);
    return { ...response, replayed: false };
  }
}

function providerMock(): BillingProvider {
  return {
    metadata: {
      providerId: "razorpay",
      interfaceName: "BillingProvider",
    },
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookEvent: vi.fn((rawBody: Uint8Array): BillingEvent => {
      const root = JSON.parse(new TextDecoder().decode(rawBody)) as {
        id: string;
        event: string;
        created_at: number;
        payload: BillingEvent["payload"];
      };
      return {
        id: root.id,
        type: root.event,
        createdAt: new Date(root.created_at * 1000).toISOString(),
        payload: root as unknown as BillingEvent["payload"],
      };
    }),
  } as unknown as BillingProvider;
}

function eventBytes(
  id: string,
  type: string,
  plan?: string,
  extraNotes: Record<string, string> = {},
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id,
      event: type,
      created_at: Math.floor(Date.now()/1000),
      payload: {
        subscription: {
          entity: {
            id: "sub_fixture",
            status: type === "subscription.pending" ? "pending" : "active",
            plan_id: plan ?? "plan_pro",
            notes: {
              tenant_id: tenantId,
              ...extraNotes,
            },
          },
        },
      },
    }),
  );
}

function eventIdFrom(rawBody: Uint8Array): string {
  try {
    const value = JSON.parse(new TextDecoder().decode(rawBody)) as {
      id?: string;
    };
    return value.id ?? "test-event-id";
  } catch {
    return "test-event-id";
  }
}
