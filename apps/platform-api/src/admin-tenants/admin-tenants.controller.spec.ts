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
  vi,
} from "vitest";
import { RbacModule, type RbacRequest } from "../rbac";
import { AdminAuditService } from "../admin-audit";
import { StaffService } from "../staff";
import { ENTITLEMENT_PROVIDER, type EntitlementProvider } from "../entitlements/entitlement-provider.interface";
import type {
  EffectiveEntitlement,
  EntitlementAccessState,
  EntitlementLimits,
  LimitCheckResult,
} from "../entitlements/types";
import { AdminTenantsController } from "./admin-tenants.controller";
import { AdminTenantsExceptionFilter } from "./admin-tenants-exception.filter";
import { AdminTenantsRepository } from "./admin-tenants.repository";
import { AdminTenantsService } from "./admin-tenants.service";
import type { AdminTenantView } from "./types";

const staffUserId = "stf_test";
const staff = (roles: string[]) => ({
  staff_user_id: staffUserId,
  identity_ref: "auth0|test",
  email: "ops@example.com",
  roles: roles as never,
});

const DEFAULT_LIMITS: EntitlementLimits = {
  maxWorkflows: 3,
  maxProjects: 1,
  maxRunsPerDay: 10,
  maxConcurrentRuns: 1,
  maxSandboxMinutesPerMonth: 30,
  maxAdsStorageMb: 500,
  maxIntegrations: 3,
};

class FakeAdminTenantsRepository {
  tenants = new Map<string, AdminTenantView>();
  actions: Array<{ tenantId: string; staffUserId: string; action: string; reason: string | null }> = [];

  reset(): void {
    this.tenants.clear();
    this.actions = [];
  }

  async createTenant(
    id: string,
    name: string,
    identityOrgRef: string,
    region: string,
  ): Promise<AdminTenantView> {
    const view: AdminTenantView = {
      id,
      name,
      status: "active",
      region,
      identity_org_ref: identityOrgRef,
      created_at: new Date().toISOString(),
    };
    this.tenants.set(id, view);
    return view;
  }

  async list(): Promise<AdminTenantView[]> {
    return [...this.tenants.values()];
  }

  async find(id: string): Promise<AdminTenantView | undefined> {
    return this.tenants.get(id);
  }

  async listActions(tenantId: string) {
    return this.actions
      .filter((action) => action.tenantId === tenantId)
      .map((action, index) => ({
        id: `taa_${index}`,
        action: action.action,
        reason: action.reason,
        staff_email: "ops@alter.example",
        occurred_at: new Date(Date.UTC(2026, 8, 28, 0, index)).toISOString(),
      }))
      .reverse();
  }

  async setStatus(id: string, status: "active" | "suspended"): Promise<AdminTenantView | undefined> {
    const tenant = this.tenants.get(id);
    if (!tenant) return undefined;
    const updated = { ...tenant, status };
    this.tenants.set(id, updated);
    return updated;
  }

  async recordAction(
    tenantId: string,
    staffId: string,
    action: string,
    reason: string | null,
  ): Promise<void> {
    this.actions.push({ tenantId, staffUserId: staffId, action, reason });
  }

  async onModuleDestroy(): Promise<void> {}
}

class FakeEntitlementProvider implements EntitlementProvider {
  records = new Map<string, EffectiveEntitlement>();

  async getEffectiveEntitlement(tenantId: string): Promise<EffectiveEntitlement> {
    return (
      this.records.get(tenantId) ?? {
        tenantId,
        plan: "free",
        limits: DEFAULT_LIMITS,
        accessState: "active",
        source: "config",
      }
    );
  }

  async checkLimit(): Promise<LimitCheckResult> {
    throw new Error("not used in this test");
  }

  async createEntitlement(
    tenantId: string,
    plan: string,
    _client?: unknown,
    options?: { accessState?: EntitlementAccessState; limits?: Partial<EntitlementLimits> },
  ): Promise<EffectiveEntitlement> {
    const current = await this.getEffectiveEntitlement(tenantId);
    const updated: EffectiveEntitlement = {
      tenantId,
      plan,
      limits: { ...current.limits, ...(options?.limits ?? {}) },
      accessState: options?.accessState ?? current.accessState,
      source: "tenant-override",
    };
    this.records.set(tenantId, updated);
    return updated;
  }
}

describe("Admin tenants routes", () => {
  let app: NestFastifyApplication;
  let repository: FakeAdminTenantsRepository;
  let entitlements: FakeEntitlementProvider;
  const requireAccess = vi.fn();

  beforeAll(async () => {
    repository = new FakeAdminTenantsRepository();
    entitlements = new FakeEntitlementProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdminTenantsController],
      providers: [
        AdminTenantsService,
        AdminTenantsExceptionFilter,
        { provide: AdminTenantsRepository, useValue: repository },
        { provide: ENTITLEMENT_PROVIDER, useValue: entitlements },
        { provide: AdminAuditService, useValue: { record: async () => "a".repeat(64) } },
        { provide: StaffService, useValue: { requireAccess } },
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
    repository.reset();
    entitlements.records.clear();
    requireAccess.mockReset();
  });

  afterAll(async () => app.close());

  it("provisions a tenant, creates its initial entitlement, and records the action", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/admin/tenants",
      body: { name: "Acme", identity_org_ref: "org-acme", plan: "starter" },
      staffContext: staff(["staff_admin"]),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as AdminTenantView;
    expect(body.name).toBe("Acme");
    expect(repository.actions).toEqual([
      { tenantId: body.id, staffUserId, action: "provisioned", reason: null },
    ]);
    expect((await entitlements.getEffectiveEntitlement(body.id)).plan).toBe("starter");
  });

  it("lists and gets tenants with an effective entitlement", async () => {
    const created = await repository.createTenant(
      "11111111-1111-7111-8111-111111111111",
      "Globex",
      "org-globex",
      "ap-south-1",
    );
    await entitlements.createEntitlement(created.id, "pro", undefined, {
      accessState: "active",
      limits: { maxWorkflows: 50 },
    });

    const list = await request({
      method: "GET",
      url: "/api/v1/admin/tenants",
      staffContext: staff(["staff_support"]),
    });
    expect(list.json()).toEqual([created]);

    const detail = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${created.id}`,
      staffContext: staff(["staff_billing_ops"]),
    });
    expect(detail.json()).toMatchObject({
      id: created.id,
      entitlement: { plan: "pro", access_state: "active" },
    });
  });

  it("requires an exact active tenant:read grant for support snapshots", async () => {
    const created = await repository.createTenant(
      "11111111-1111-7111-8111-111111111112",
      "Support target",
      "org-support",
      "ap-south-1",
    );
    const response = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${created.id}/support-snapshot`,
      staffContext: staff(["staff_support"]),
      supportGrant: "jit_approved",
    });
    expect(response.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalledWith(
      "jit_approved",
      staffUserId,
      created.id,
      "tenant:read",
    );
  });

  it("blocks staff_admin/staff_support from get() without an active support grant", async () => {
    const created = await repository.createTenant(
      "11111111-1111-7111-8111-111111111113",
      "Gated target",
      "org-gated",
      "ap-south-1",
    );
    const asAdmin = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${created.id}`,
      staffContext: staff(["staff_admin"]),
    });
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json()).toMatchObject({ error_code: "ACTIVE_SUPPORT_GRANT_REQUIRED" });

    const asSupport = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${created.id}`,
      staffContext: staff(["staff_support"]),
    });
    expect(asSupport.statusCode).toBe(403);
    expect(asSupport.json()).toMatchObject({ error_code: "ACTIVE_SUPPORT_GRANT_REQUIRED" });
  });

  it("allows get() for staff_admin/staff_support with an active support grant, same view as support-snapshot", async () => {
    const created = await repository.createTenant(
      "11111111-1111-7111-8111-111111111114",
      "Granted target",
      "org-granted",
      "ap-south-1",
    );
    const response = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${created.id}`,
      staffContext: staff(["staff_admin"]),
      supportGrant: "jit_approved",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id });
    expect(requireAccess).toHaveBeenCalledWith(
      "jit_approved",
      staffUserId,
      created.id,
      "tenant:read",
    );
  });

  it("suspends then reinstates a tenant, preserving the entitlement plan and limits", async () => {
    const created = await repository.createTenant(
      "22222222-2222-7222-8222-222222222222",
      "Initech",
      "org-initech",
      "ap-south-1",
    );
    await entitlements.createEntitlement(created.id, "pro", undefined, {
      accessState: "active",
      limits: { maxWorkflows: 20 },
    });

    const suspend = await request({
      method: "POST",
      url: `/api/v1/admin/tenants/${created.id}/actions/suspend`,
      body: { reason: "payment fraud review" },
      staffContext: staff(["staff_admin"]),
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json()).toMatchObject({ status: "suspended" });
    expect((await entitlements.getEffectiveEntitlement(created.id)).accessState).toBe(
      "suspended",
    );

    const reinstate = await request({
      method: "POST",
      url: `/api/v1/admin/tenants/${created.id}/actions/reinstate`,
      body: {},
      staffContext: staff(["staff_admin"]),
    });
    expect(reinstate.statusCode).toBe(200);
    expect(reinstate.json()).toMatchObject({ status: "active" });
    const finalEntitlement = await entitlements.getEffectiveEntitlement(created.id);
    expect(finalEntitlement.accessState).toBe("active");
    expect(finalEntitlement.plan).toBe("pro");
    expect(finalEntitlement.limits.maxWorkflows).toBe(20);

    expect(repository.actions.map((a) => a.action)).toEqual(["suspended", "reinstated"]);
  });

  it("overrides entitlement limits merged onto the current effective entitlement", async () => {
    const created = await repository.createTenant(
      "33333333-3333-7333-8333-333333333333",
      "Umbrella",
      "org-umbrella",
      "ap-south-1",
    );
    await entitlements.createEntitlement(created.id, "starter", undefined, {
      accessState: "active",
      limits: DEFAULT_LIMITS,
    });

    const response = await request({
      method: "POST",
      url: `/api/v1/admin/tenants/${created.id}/entitlements`,
      body: { limits: { maxWorkflows: 100 }, reason: "enterprise pilot" },
      staffContext: staff(["staff_billing_ops"]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entitlement: { limits: EntitlementLimits } };
    expect(body.entitlement.limits.maxWorkflows).toBe(100);
    expect(body.entitlement.limits.maxProjects).toBe(DEFAULT_LIMITS.maxProjects);
    expect(repository.actions.at(-1)).toMatchObject({ action: "entitlement_overridden" });
  });

  it("overrides plan alone, leaving limits at their current values when omitted", async () => {
    const created = await repository.createTenant(
      "44444444-4444-7444-8444-444444444444",
      "Soylent",
      "org-soylent",
      "ap-south-1",
    );
    await entitlements.createEntitlement(created.id, "starter", undefined, {
      accessState: "active",
      limits: DEFAULT_LIMITS,
    });

    const response = await request({
      method: "POST",
      url: `/api/v1/admin/tenants/${created.id}/entitlements`,
      body: { plan: "pro", reason: "upgrade" },
      staffContext: staff(["staff_admin"]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entitlement: { plan: string; limits: EntitlementLimits } };
    expect(body.entitlement.plan).toBe("pro");
    expect(body.entitlement.limits).toEqual(DEFAULT_LIMITS);
  });

  it("returns a tenant's action history newest first, behind the same grant rule as get()", async () => {
    const created = await request({
      method: "POST",
      url: "/api/v1/admin/tenants",
      body: { name: "Acme", identity_org_ref: "org-acme", plan: "starter" },
      staffContext: staff(["staff_admin"]),
    });
    const tenantId = (created.json() as AdminTenantView).id;
    await request({
      method: "POST",
      url: `/api/v1/admin/tenants/${tenantId}/actions/suspend`,
      body: { reason: "abuse report" },
      staffContext: staff(["staff_admin"]),
    });

    const blocked = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${tenantId}/actions`,
      staffContext: staff(["staff_support"]),
    });
    expect(blocked.statusCode).toBe(403);

    const history = await request({
      method: "GET",
      url: `/api/v1/admin/tenants/${tenantId}/actions`,
      staffContext: staff(["staff_security"]),
    });
    expect(history.statusCode).toBe(200);
    expect((history.json() as Array<{ action: string }>).map((entry) => entry.action)).toEqual(["suspended", "provisioned"]);
  });

  it("404s for an unknown tenant", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/tenants/99999999-9999-7999-8999-999999999999",
      staffContext: staff(["staff_billing_ops"]),
    });
    expectProblem(response, 404, "ADMIN_TENANT_NOT_FOUND");
  });

  it("rejects a malformed tenantId", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/tenants/not-a-uuid",
      staffContext: staff(["staff_admin"]),
    });
    expectProblem(response, 400, "ADMIN_TENANT_VALIDATION_FAILED");
  });

  it("rejects a provision body missing required fields", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/admin/tenants",
      body: { name: "Acme" },
      staffContext: staff(["staff_admin"]),
    });
    expectProblem(response, 400, "ADMIN_TENANT_VALIDATION_FAILED");
  });

  it("rejects a non-object provision body with a root-level validation error", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/admin/tenants",
      body: ["not", "an", "object"],
      staffContext: staff(["staff_admin"]),
    });
    expectProblem(response, 400, "ADMIN_TENANT_VALIDATION_FAILED");
    expect(
      (response.json() as { field_errors: Array<{ field: string }> }).field_errors,
    ).toEqual([{ field: "body", message: expect.any(String) }]);
  });

  it.each([
    ["POST", "/api/v1/admin/tenants", ["staff_support"]],
    [
      "POST",
      "/api/v1/admin/tenants/11111111-1111-7111-8111-111111111111/actions/suspend",
      ["staff_billing_ops"],
    ],
  ])("role-gates %s %s to staff_admin only", async (method, url, roles) => {
    const response = await request({
      method,
      url,
      body: { name: "x", identity_org_ref: "x", plan: "x", reason: "x" },
      staffContext: staff(roles),
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("denies read routes without any staff role", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/tenants",
      staffContext: staff([]),
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("denies everything with no staff actor context at all", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/admin/tenants",
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("controller itself rejects a missing staff actor at the method level", async () => {
    const controller = new AdminTenantsController(
      {} as AdminTenantsService,
      {} as StaffService,
    );
    await expect(async () =>
      controller.provision({ name: "x" }, {} as RbacRequest),
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
        ...(options.supportGrant
          ? { "x-alter-support-grant": options.supportGrant }
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
  expect(response.headers["content-type"]).toContain(
    "application/problem+json",
  );
  expect(response.json()).toMatchObject({ status, error_code: code });
}

interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
  staffContext?: ReturnType<typeof staff>;
  supportGrant?: string;
}

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}
