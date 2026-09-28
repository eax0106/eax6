import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CostsService } from "../costs/costs.service";
import { PgIdempotencyStore, type IdempotencyExecution, type StoredHttpResponse } from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { BudgetController } from "./budget.controller";
import { BudgetRepository } from "./budget.repository";
import { BudgetService } from "./budget.service";
import type { BudgetRecord } from "./types";

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

function record(overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return {
    tenantId: base.tenant_id, workspaceId: base.workspace_id!, id: budgetId, name: "Monthly", amountMinor: 50_000,
    currency: "INR", period: "monthly", thresholds: [{ percent: 80, action: "warn" }], enabled: true,
    createdBy: "usr_1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...overrides,
  };
}

describe("Budget routes (task B2.9b)", () => {
  let app: NestFastifyApplication;
  const repository = {
    list: vi.fn(async () => [record()]),
    insert: vi.fn(async (input: BudgetRecord) => ({ ...input, createdAt: "x", updatedAt: "x" })),
    update: vi.fn(async () => record({ enabled: false })),
    remove: vi.fn(async () => true),
  };
  const costs = { summary: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [BudgetController],
      providers: [
        BudgetService,
        { provide: BudgetRepository, useValue: repository },
        { provide: CostsService, useValue: costs },
        // Pass-through: this spec is about the budget routes, not replay.
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

  beforeEach(() => {
    vi.clearAllMocks();
    costs.summary.mockResolvedValue({ currency: "INR", totals: { billableMinor: "12345" } });
  });
  afterAll(async () => app.close());

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, actor: ActorContextType, payload?: unknown) =>
    app.inject({ method, url, headers: { "x-test-actor": JSON.stringify(actor), "idempotency-key": "k1" }, ...(payload === undefined ? {} : { payload: payload as object }) });

  it("lists the workspace's budgets with this month's billable spend for any member", async () => {
    const response = await call("GET", "/api/v1/budgets", base)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([expect.objectContaining({ id: budgetId, amountMinor: 50_000, currentSpendMinor: 12345 })])
    expect(repository.list).toHaveBeenCalledWith(base.tenant_id, base.workspace_id)
    const [query] = costs.summary.mock.calls[0]!
    expect(query.startAt).toMatch(/-01T00:00:00.000Z$/)
  });

  it("leaves spend unknown when the ledger is down or counts another currency, instead of failing", async () => {
    costs.summary.mockRejectedValueOnce(new Error("ledger down"))
    expect((await call("GET", "/api/v1/budgets", base)).json()[0].currentSpendMinor).toBeNull()
    costs.summary.mockResolvedValueOnce({ currency: "USD", totals: { billableMinor: "99" } })
    expect((await call("GET", "/api/v1/budgets", base)).json()[0].currentSpendMinor).toBeNull()
  });

  it("lets only workspace admins create, change or delete a budget", async () => {
    const body = { name: "Team", amount_minor: 100_00, currency: "INR", thresholds: [{ percent: 100, action: "block" }] }
    expect((await call("POST", "/api/v1/budgets", editor, body)).statusCode).toBe(403)
    expect((await call("PATCH", `/api/v1/budgets/${budgetId}`, base, { enabled: false })).statusCode).toBe(403)
    expect((await call("DELETE", `/api/v1/budgets/${budgetId}`, editor)).statusCode).toBe(403)
    expect(repository.insert).not.toHaveBeenCalled()

    const created = await call("POST", "/api/v1/budgets", admin, body)
    expect(created.statusCode).toBe(201)
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: admin.tenant_id, workspaceId: admin.workspace_id, name: "Team", amountMinor: 10_000, period: "monthly", enabled: true, createdBy: "usr_1",
    }))
    expect(created.json().id).toMatch(/^bud_[0-9a-f-]{36}$/)
    expect((await call("PATCH", `/api/v1/budgets/${budgetId}`, admin, { enabled: false })).statusCode).toBe(200)
    expect((await call("DELETE", `/api/v1/budgets/${budgetId}`, admin)).statusCode).toBe(204)
  });

  it("refuses bad input and answers 404 for another workspace's budget", async () => {
    for (const body of [
      { name: "", amount_minor: 1, currency: "INR" },
      { name: "x", amount_minor: 0, currency: "INR" },
      { name: "x", amount_minor: 1, currency: "EUR" },
      { name: "x", amount_minor: 1, currency: "INR", thresholds: [{ percent: 101, action: "warn" }] },
      { name: "x", amount_minor: 1, currency: "INR", tenant_id: "other" },
    ]) {
      expect((await call("POST", "/api/v1/budgets", admin, body)).statusCode).toBe(400)
    }
    expect((await call("PATCH", `/api/v1/budgets/${budgetId}`, admin, {})).statusCode).toBe(400)
    expect((await call("PATCH", "/api/v1/budgets/not-an-id", admin, { enabled: true })).statusCode).toBe(400)
    repository.update.mockResolvedValueOnce(undefined as never)
    expect((await call("PATCH", `/api/v1/budgets/${budgetId}`, admin, { enabled: true })).statusCode).toBe(404)
    repository.remove.mockResolvedValueOnce(false)
    expect((await call("DELETE", `/api/v1/budgets/${budgetId}`, admin)).statusCode).toBe(404)
  });
});
