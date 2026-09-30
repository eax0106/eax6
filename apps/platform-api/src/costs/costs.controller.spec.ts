import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CostLedgerClient, EngineClient, EngineExceptionFilter } from "../engine";
import { RbacModule, type ActorContextType, type RbacRequest, type StaffActorContextType } from "../rbac";
import { CostsController, StaffCostsController, WorkflowCostsController } from "./costs.controller";
import { CostsExceptionFilter } from "./costs-exception.filter";
import { CostsService } from "./costs.service";
import { StaffCostsService } from "./staff-costs.service";

const actor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  roles: ["viewer"],
  permissions: ["billing:read"],
};

describe("CostsController", () => {
  let app: NestFastifyApplication;
  const ledger = { getSummary: vi.fn(), getRunTotals: vi.fn() };
  const engine = { get: vi.fn() };
  const staffCosts = { summary: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [CostsController, WorkflowCostsController, StaffCostsController],
      providers: [
        CostsService,
        CostsExceptionFilter,
        { provide: CostLedgerClient, useValue: ledger },
        { provide: EngineClient, useValue: engine },
        { provide: StaffCostsService, useValue: staffCosts },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-test-actor"];
      if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
      const staff = request.headers["x-test-staff"];
      if (typeof staff === "string") (request as RbacRequest).staffActorContext = JSON.parse(staff) as StaffActorContextType;
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    ledger.getSummary.mockReset();
    ledger.getRunTotals.mockReset();
    engine.get.mockReset();
    staffCosts.summary.mockReset();
  });

  afterAll(async () => app.close());

  it("uses actor tenant/workspace, ignores raw tenant query, returns empty real state", async () => {
    ledger.getSummary.mockResolvedValue(emptyRollup());
    const response = await request("GET", "/api/v1/costs/summary?tenantId=ten_other&startAt=2026-01-01T00%3A00%3A00.000Z&endAt=2026-02-01T00%3A00%3A00.000Z", actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ groups: [], totals: { billableMinor: "0" } }));
    expect(ledger.getSummary).toHaveBeenCalledWith(
      { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-02-01T00:00:00.000Z", dimensions: [] },
      expect.objectContaining({ tenantId: actor.tenant_id, workspaceId: actor.workspace_id }),
    );
  });

  it("blocks cross-tenant data access without billing permission", async () => {
    const response = await request("GET", "/api/v1/costs/summary?startAt=2026-01-01T00%3A00%3A00.000Z&endAt=2026-02-01T00%3A00%3A00.000Z", { ...actor, permissions: [] });
    expectProblem(response, 403, "RBAC_PERMISSION_DENIED");
    expect(ledger.getSummary).not.toHaveBeenCalled();
  });

  it("returns 502 problem for malformed upstream rollups", async () => {
    ledger.getSummary.mockResolvedValue("bad-json");
    const response = await request("GET", "/api/v1/costs/summary?startAt=2026-01-01T00%3A00%3A00.000Z&endAt=2026-02-01T00%3A00%3A00.000Z", actor);
    expectProblem(response, 502, "INVALID_COST_ROLLUP_RESPONSE");
  });

  it("no longer offers the internal-cost estimate to tenants (D24)", async () => {
    const response = await request("POST", "/api/v1/costs/estimate", actor, {
      mode: "workflow",
      lineItems: [{ source: "model_gateway", provider: "bedrock", resource: "claude", expectedQuantity: 1 }],
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers a workflow's billed cost to a workspace reader with billing:read (D24)", async () => {
    engine.get.mockResolvedValue({ status: 200, body: { data: [], page: { next_cursor: null, has_more: false, limit: 200 } } });
    const response = await request(
      "GET",
      "/api/v1/workflows/wf_018f47a5-7b2c-7d10-8f11-123456789abc/costs?startAt=2026-09-01T00%3A00%3A00.000Z&endAt=2026-10-01T00%3A00%3A00.000Z",
      actor,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ billableMinor: "0", runCount: 0, currency: "INR" });

    const denied = await request(
      "GET",
      "/api/v1/workflows/wf_018f47a5-7b2c-7d10-8f11-123456789abc/costs?startAt=2026-09-01T00%3A00%3A00.000Z&endAt=2026-10-01T00%3A00%3A00.000Z",
      { ...actor, permissions: [] },
    );
    expectProblem(denied, 403, "RBAC_PERMISSION_DENIED");
  });

  it("gives the full breakdown to billing operations staff only (D24)", async () => {
    staffCosts.summary.mockResolvedValue({ totals: { internalCostMinor: "100", billableMinor: "143", marginMinor: "43" } });
    const url = "/api/v1/admin/tenants/ten_018f47a5-7b2c-7d10-8f11-123456789abc/costs?workspaceId=ws_018f47a5-7b2c-7d10-8f11-123456789abc&startAt=2026-09-01T00%3A00%3A00.000Z&endAt=2026-10-01T00%3A00%3A00.000Z";

    const staffResponse = await request("GET", url, undefined, undefined, staff("staff_billing_ops"));
    expect(staffResponse.statusCode).toBe(200);
    expect(staffResponse.json()).toMatchObject({ totals: { marginMinor: "43" } });

    for (const role of ["staff_admin", "staff_support", "staff_security"] as const) {
      expect((await request("GET", url, undefined, undefined, staff(role))).statusCode).toBe(403);
    }
    const tenantResponse = await request("GET", url, { ...actor, roles: ["admin"] });
    expect(tenantResponse.statusCode).toBe(403);
    expect(staffCosts.summary).toHaveBeenCalledTimes(1);
  });

  function staff(role: StaffActorContextType["roles"][number]): StaffActorContextType {
    return { staff_user_id: "stf_00000000-0000-7000-8000-000000000401", identity_ref: "auth0|staff-test", email: "staff@example.com", roles: [role] };
  }

  function request(
    method: "GET" | "POST",
    url: string,
    requestActor: ActorContextType | undefined,
    payload?: unknown,
    staffActor?: StaffActorContextType,
  ): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method, url,
      headers: {
        ...(requestActor ? { "x-test-actor": JSON.stringify(requestActor) } : {}),
        ...(staffActor ? { "x-test-staff": JSON.stringify(staffActor) } : {}),
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    }) as Promise<TestResponse>;
  }
});

interface TestResponse { statusCode: number; headers: Record<string, string | string[] | undefined>; json(): unknown; }

function emptyRollup(): string {
  return JSON.stringify({
    start_at: "2026-01-01T00:00:00.000Z", end_at: "2026-02-01T00:00:00.000Z",
    currency: "INR",
    dimensions: [], groups: [],
    totals: { internal_cost_minor: "0", billable_minor: "0", margin_minor: "0" },
  });
}

function expectProblem(response: TestResponse, status: number, errorCode: string): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.json()).toMatchObject({ status, error_code: errorCode });
}
