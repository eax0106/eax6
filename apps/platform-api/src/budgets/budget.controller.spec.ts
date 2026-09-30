import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineClient, EngineExceptionFilter } from "../engine";
import { PgIdempotencyStore, type IdempotencyExecution, type StoredHttpResponse } from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { BudgetController } from "./budget.controller";
import { BudgetService } from "./budget.service";

const base: ActorContextType = {
  user_id: "usr_1",
  tenant_id: "00000000-0000-7000-8000-000000000001",
  workspace_id: "00000000-0000-7000-8000-0000000000a1",
  session_id: "session-a",
  roles: ["viewer"],
  permissions: ["billing:read"],
};
const admin: ActorContextType = { ...base, roles: ["admin"], permissions: ["billing:read", "budgets:write"] };
const editor: ActorContextType = { ...base, roles: ["editor"], permissions: ["billing:read"] };
const budgetId = "bud_018f4d6e-2b4a-7a3e-8c1a-0123456789ab";
const workflowId = "wf_018f4d6e-2b4a-7a3e-8c1a-0123456789ac";
const engineBudget = {
  id: budgetId,
  workspace_id: `ws_${base.workspace_id}`,
  workflow_id: null,
  kind: "workspace",
  period: "monthly",
  currency: "INR",
  amount_minor: 50_000,
  mode: "hard",
  enabled: true,
  spent_minor: 12_345,
  reserved_minor: 0,
  created_by: "usr_1",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

// D3: budgets live in the engine; these routes relay to it through the caller's identity.
describe("Budget routes (D3, relayed to the engine)", () => {
  let app: NestFastifyApplication;
  const engine = {
    get: vi.fn(async () => ({ status: 200, body: { data: [engineBudget] } })),
    post: vi.fn(async () => ({ status: 201, body: engineBudget })),
    patch: vi.fn(async () => ({ status: 200, body: { ...engineBudget, enabled: false } })),
    delete: vi.fn(async () => ({ status: 204, body: undefined })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [BudgetController],
      providers: [
        BudgetService,
        { provide: EngineClient, useValue: engine },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
        {
          provide: PgIdempotencyStore,
          useValue: {
            execute: async (_input: IdempotencyExecution, operation: () => Promise<StoredHttpResponse>) => ({ ...(await operation()), replayed: false }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-test-actor"];
      if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());

  it("lists the engine's budgets for any workspace reader with billing:read", async () => {
    const response = await call("GET", "/api/v1/budgets", base);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([engineBudget]);
    expect(engine.get).toHaveBeenCalledWith("/api/v1/budgets", expect.objectContaining({ tenantId: base.tenant_id, workspaceId: base.workspace_id }));
  });

  it("creates each kind through the engine, admin with budgets:write only", async () => {
    for (const body of [
      { kind: "workspace", amount_minor: 100 },
      { kind: "workflow", workflow_id: workflowId, period: "daily", amount_minor: 100, mode: "warn" },
      { kind: "run_cap", workflow_id: workflowId, amount_minor: 100 },
    ]) {
      const response = await call("POST", "/api/v1/budgets", admin, body, { "idempotency-key": `create-${body.kind}` });
      expect(response.statusCode).toBe(201);
    }
    expect(engine.post).toHaveBeenNthCalledWith(
      2,
      "/api/v1/budgets",
      { kind: "workflow", workflow_id: workflowId, period: "daily", amount_minor: 100, mode: "warn" },
      expect.objectContaining({ workspaceId: base.workspace_id }),
      { idempotencyKey: "create-workflow" },
    );
    expect(engine.post).toHaveBeenNthCalledWith(1, "/api/v1/budgets", { kind: "workspace", amount_minor: 100, mode: "hard" }, expect.anything(), expect.anything());

    expect((await call("POST", "/api/v1/budgets", editor, { kind: "workspace", amount_minor: 100 }, { "idempotency-key": "e" })).statusCode).toBe(403);
  });

  it.each([
    [{ kind: "workspace", amount_minor: 0 }],
    [{ kind: "workflow", workflow_id: workflowId, amount_minor: 100 }],
    [{ kind: "run_cap", amount_minor: 100 }],
    [{ kind: "workspace", amount_minor: 100, name: "old shape" }],
    [{ kind: "workspace", amount_minor: 100, mode: "block" }],
  ])("refuses a malformed budget before reaching the engine (%#)", async (body) => {
    const response = await call("POST", "/api/v1/budgets", admin, body, { "idempotency-key": `bad-${JSON.stringify(body)}` });
    expect(response.statusCode).toBe(400);
    expect(engine.post).not.toHaveBeenCalled();
  });

  it("changes a budget only with If-Match, which it passes to the engine", async () => {
    const missing = await call("PATCH", `/api/v1/budgets/${budgetId}`, admin, { enabled: false });
    expect(missing.statusCode).toBe(428);
    expect(engine.patch).not.toHaveBeenCalled();

    const response = await call("PATCH", `/api/v1/budgets/${budgetId}`, admin, { enabled: false }, { "if-match": engineBudget.updated_at });
    expect(response.statusCode).toBe(200);
    expect(engine.patch).toHaveBeenCalledWith(
      `/api/v1/budgets/${budgetId}`,
      { enabled: false },
      expect.anything(),
      expect.objectContaining({ ifMatch: engineBudget.updated_at }),
    );
  });

  it("deletes through the engine and refuses a bad id", async () => {
    expect((await call("DELETE", `/api/v1/budgets/${budgetId}`, admin)).statusCode).toBe(204);
    expect(engine.delete).toHaveBeenCalledWith(`/api/v1/budgets/${budgetId}`, expect.anything(), expect.anything());
    expect((await call("DELETE", "/api/v1/budgets/not-a-budget", admin)).statusCode).toBe(400);
  });

  function call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    actor: ActorContextType,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: { "x-test-actor": JSON.stringify(actor), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  }
});
