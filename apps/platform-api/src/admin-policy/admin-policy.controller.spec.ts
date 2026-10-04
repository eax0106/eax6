import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PlanCommercial } from "../entitlements/plan-commercial";
import { RbacModule, type RbacRequest } from "../rbac";
import { AdminAuditService } from "../admin-audit";
import { CONFIG_PROVIDER, type ConfigProvider } from "../entitlements/config-provider.interface";
import {
  PLAN_DEFINITION_STORE,
  type PlanDefinitionAuditAction,
  type PlanDefinitionAuditRecord,
  type PlanDefinitionRecord,
  type PlanDefinitionStore,
} from "../entitlements/plan-definition-store";
import type {
  AbuseThresholds,
  DunningConfig,
  EntitlementLimits,
} from "../entitlements/types";
import { AdminPolicyController } from "./admin-policy.controller";
import { AdminPolicyExceptionFilter } from "./admin-policy-exception.filter";
import { AdminPolicyService } from "./admin-policy.service";
import type { PlanDefinitionView, PlanPolicyView } from "./types";

const staffUserId = "stf_test";
const staff = (roles: string[]) => ({
  staff_user_id: staffUserId,
  identity_ref: "auth0|test",
  email: "ops@example.com",
  roles: roles as never,
});

const BASELINE_LIMITS: EntitlementLimits = {
  maxWorkflows: 3,
  maxProjects: 1,
  maxRunsPerDay: 10,
  maxConcurrentRuns: 1,
  maxSandboxMinutesPerMonth: 30,
  maxAdsStorageMb: 500,
  maxIntegrations: 3,
};

const PRO_LIMITS: EntitlementLimits = {
  maxWorkflows: 200,
  maxProjects: 50,
  maxRunsPerDay: 10_000,
  maxConcurrentRuns: 25,
  maxSandboxMinutesPerMonth: 5_000,
  maxAdsStorageMb: 50_000,
  maxIntegrations: 100,
};

class FakePlanDefinitionStore implements PlanDefinitionStore {
  records = new Map<string, PlanDefinitionRecord>();
  audits: PlanDefinitionAuditRecord[] = [];
  private sequence = 0;

  reset(): void {
    this.records.clear();
    this.audits = [];
    this.sequence = 0;
  }

  async list(): Promise<PlanDefinitionRecord[]> {
    return [...this.records.values()].sort((a, b) => a.plan.localeCompare(b.plan));
  }

  async find(plan: string): Promise<PlanDefinitionRecord | undefined> {
    return this.records.get(plan);
  }

  async upsert(
    plan: string,
    limits: EntitlementLimits,
    updatedBy: string,
    commercial?: PlanCommercial | null,
    auditReason?: string,
  ): Promise<{ record: PlanDefinitionRecord; created: boolean }> {
    const created = !this.records.has(plan);
    const record: PlanDefinitionRecord = {
      plan,
      limits,
      commercial: commercial === undefined ? this.records.get(plan)?.commercial ?? null : commercial,
      updatedAt: new Date("2026-08-06T00:00:00Z"),
      updatedBy,
    };
    this.records.set(plan, record);
    if (auditReason) await this.recordAudit(plan, created ? "created" : "updated", limits, auditReason, updatedBy, record.commercial);
    return { record, created };
  }

  async remove(plan: string): Promise<boolean> {
    return this.records.delete(plan);
  }

  async recordAudit(
    plan: string,
    action: PlanDefinitionAuditAction,
    limits: EntitlementLimits | null,
    reason: string,
    staffId: string,
    commercial?: PlanCommercial | null,
  ): Promise<void> {
    this.sequence += 1;
    this.audits.push({
      id: `pda_${this.sequence}`,
      plan,
      action,
      limits,
      commercial: commercial ?? null,
      reason,
      staffUserId: staffId,
      occurredAt: new Date("2026-08-06T00:00:00Z"),
    });
  }

  async history(plan: string, limit: number): Promise<PlanDefinitionAuditRecord[]> {
    return this.audits
      .filter((audit) => audit.plan === plan)
      .reverse()
      .slice(0, limit);
  }
}

class FakeConfigProvider implements ConfigProvider {
  plans = new Map<string, EntitlementLimits>([["free", BASELINE_LIMITS]]);

  async getEntitlementDefaults(plan: string): Promise<EntitlementLimits> {
    const limits = this.plans.get(plan);
    if (!limits) throw new Error(`No entitlement defaults configured for plan: ${plan}`);
    return { ...limits };
  }

  async getAbuseThresholds(): Promise<AbuseThresholds> {
    throw new Error("not used in this test");
  }

  async getDunningConfig(): Promise<DunningConfig> {
    throw new Error("not used in this test");
  }
}

describe("Admin policy plan routes", () => {
  let app: NestFastifyApplication;
  let store: FakePlanDefinitionStore;
  let config: FakeConfigProvider;

  beforeAll(async () => {
    store = new FakePlanDefinitionStore();
    config = new FakeConfigProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdminPolicyController],
      providers: [
        AdminPolicyService,
        AdminPolicyExceptionFilter,
        { provide: PLAN_DEFINITION_STORE, useValue: store },
        { provide: CONFIG_PROVIDER, useValue: config },
        { provide: AdminAuditService, useValue: { record: async () => "a".repeat(64) } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook(
        "preHandler",
        (request: FastifyRequest, _reply: unknown, done: () => void) => {
          const value = request.headers["x-test-staff"];
          if (typeof value === "string") {
            (request as RbacRequest).staffActorContext = JSON.parse(value);
          }
          done();
        },
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    store.reset();
  });

  afterAll(async () => app.close());

  it("creates a plan definition and records a created audit entry", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: PRO_LIMITS, reason: "launch pro tier" },
      staffContext: staff(["staff_admin"]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plan: "pro",
      limits: PRO_LIMITS,
      commercial: null,
      updated_at: "2026-08-06T00:00:00.000Z",
      updated_by: staffUserId,
    } satisfies PlanDefinitionView);
    expect(store.audits).toEqual([
      expect.objectContaining({
        plan: "pro",
        action: "created",
        reason: "launch pro tier",
        staffUserId,
      }),
    ]);
  });

  it("records an updated audit entry when the definition already exists", async () => {
    await store.upsert("pro", PRO_LIMITS, staffUserId);

    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: {
        limits: { ...PRO_LIMITS, maxWorkflows: 500 },
        reason: "raise workflow ceiling",
      },
      staffContext: staff(["staff_billing_ops"]),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as PlanDefinitionView).limits.maxWorkflows).toBe(500);
    expect(store.audits.map((audit) => audit.action)).toEqual(["updated"]);
  });

  it("lists only staff-authored definitions", async () => {
    await store.upsert("pro", PRO_LIMITS, staffUserId);

    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans",
      staffContext: staff(["staff_support"]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        plan: "pro",
        limits: PRO_LIMITS,
        commercial: null,
        updated_at: "2026-08-06T00:00:00.000Z",
        updated_by: staffUserId,
      },
    ]);
  });

  it("reports plan_definition as the source when a definition exists", async () => {
    await store.upsert("pro", PRO_LIMITS, staffUserId);

    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/pro",
      staffContext: staff(["staff_security"]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan: "pro",
      limits: PRO_LIMITS,
      source: "plan_definition",
      definition: { updated_by: staffUserId },
    });
  });

  it("falls through to the ConfigProvider baseline when no definition exists", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/free",
      staffContext: staff(["staff_admin"]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plan: "free",
      limits: BASELINE_LIMITS,
      source: "config_provider",
      definition: null,
    } satisfies PlanPolicyView);
  });

  it("404s when the plan has neither a definition nor a baseline config entry", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/nonexistent",
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 404, "ADMIN_POLICY_PLAN_NOT_FOUND");
  });

  it("deletes a definition, reverting the plan to the baseline, and audits it", async () => {
    await store.upsert("free", PRO_LIMITS, staffUserId);

    const response = await request({
      method: "DELETE",
      url: "/api/v1/admin/policy/plans/free",
      body: { reason: "revert to config baseline" },
      staffContext: staff(["staff_admin"]),
    });

    expect(response.statusCode).toBe(204);
    expect(store.records.has("free")).toBe(false);
    expect(store.audits.at(-1)).toMatchObject({
      action: "deleted",
      limits: PRO_LIMITS,
      reason: "revert to config baseline",
    });

    const after = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/free",
      staffContext: staff(["staff_admin"]),
    });
    expect(after.json()).toMatchObject({ source: "config_provider" });
  });

  it("404s when deleting a definition that does not exist", async () => {
    const response = await request({
      method: "DELETE",
      url: "/api/v1/admin/policy/plans/pro",
      body: { reason: "cleanup" },
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 404, "ADMIN_POLICY_PLAN_NOT_FOUND");
  });

  it("returns append-only history newest first, honouring the limit query", async () => {
    await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: PRO_LIMITS, reason: "first" },
      staffContext: staff(["staff_admin"]),
    });
    await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: PRO_LIMITS, reason: "second" },
      staffContext: staff(["staff_admin"]),
    });

    const all = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/pro/history",
      staffContext: staff(["staff_support"]),
    });
    expect(all.statusCode).toBe(200);
    expect((all.json() as Array<{ reason: string }>).map((a) => a.reason)).toEqual([
      "second",
      "first",
    ]);

    const capped = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/pro/history?limit=1",
      staffContext: staff(["staff_support"]),
    });
    expect((capped.json() as unknown[]).length).toBe(1);
  });

  it("rejects an out-of-range history limit", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans/pro/history?limit=9999",
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it("rejects a partial limits body, since a definition replaces the baseline outright", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: { maxWorkflows: 10 }, reason: "partial" },
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it("rejects unknown limit keys", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: {
        limits: { ...PRO_LIMITS, maxUnicorns: 1 },
        reason: "typo",
      },
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it("rejects a negative limit", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: {
        limits: { ...PRO_LIMITS, maxProjects: -1 },
        reason: "negative",
      },
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it("rejects a write with no reason", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: PRO_LIMITS },
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it("rejects a non-object body with a root-level validation error", async () => {
    const response = await request({
      method: "PUT",
      url: "/api/v1/admin/policy/plans/pro",
      body: ["not", "an", "object"],
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
    expect(
      (response.json() as { field_errors: Array<{ field: string }> }).field_errors,
    ).toEqual([{ field: "body", message: expect.any(String) }]);
  });

  it.each([
    ["GET", "/api/v1/admin/policy/plans/Bad_Plan"],
    ["GET", "/api/v1/admin/policy/plans/-leading-dash/history"],
  ])("rejects a malformed plan name on %s %s", async (method, url) => {
    const response = await request({
      method,
      url,
      staffContext: staff(["staff_admin"]),
    });

    expectProblem(response, 400, "ADMIN_POLICY_VALIDATION_FAILED");
  });

  it.each([
    ["PUT", ["staff_support"]],
    ["PUT", ["staff_security"]],
    ["DELETE", ["staff_support"]],
  ])("role-gates %s to staff_admin/staff_billing_ops only", async (method, roles) => {
    const response = await request({
      method,
      url: "/api/v1/admin/policy/plans/pro",
      body: { limits: PRO_LIMITS, reason: "attempt" },
      staffContext: staff(roles),
    });

    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("denies read routes without any staff role", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans",
      staffContext: staff([]),
    });

    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("denies everything with no staff actor context at all", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/policy/plans",
    });

    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it.each([
    ["upsert" as const],
    ["remove" as const],
  ])("controller %s rejects a missing staff actor at the method level", async (method) => {
    const controller = new AdminPolicyController({} as AdminPolicyService);
    await expect(async () =>
      controller[method]("pro", { limits: PRO_LIMITS, reason: "x" }, {} as RbacRequest),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });
  });

  function request(options: RequestOptions): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method: options.method,
      url: options.url,
      payload: options.body as never,
      headers: {
        ...(options.staffContext
          ? { "x-test-staff": JSON.stringify(options.staffContext) }
          : {}),
      },
    } as never) as Promise<TestResponse>;
  }
});

function expectProblem(
  response: TestResponse,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.json()).toMatchObject({ status, error_code: code });
}

interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
  staffContext?: ReturnType<typeof staff>;
}

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}
