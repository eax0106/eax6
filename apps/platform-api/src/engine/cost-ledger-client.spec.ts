import { describe, expect, it, vi } from "vitest";

import type { EngineAuthProvider } from "./auth";
import { CostLedgerClient } from "./cost-ledger-client";
import type { EngineConfig } from "./config";
import type { EngineCallerContext } from "./types";

const config: EngineConfig = {
  baseUrl: "https://engine.test",
  adsCoreBaseUrl: "https://ads.test",
  costLedgerBaseUrl: "https://costs.test/",
  evalFacadeTokenRef: "env:EVAL_FACADE_TOKEN",
  deploymentAdminServiceTokenRef: "env:DEPLOYMENT_ADMIN_TOKEN",
  auditServiceBaseUrl: "https://audit.test",
  auditQueryServiceTokenRef: "env:AUDIT_QUERY_TOKEN",
  m2mTokenUrl: "https://identity.test/oauth/token",
  m2mAudience: "https://engine.test",
  m2mClientId: "platform-api",
  m2mClientSecretRef: "env:ENGINE_SECRET",
  requestTimeoutMs: 100,
  planningTimeoutMs: 120_000,
};

const context: EngineCallerContext = {
  userId: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenantId: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspaceId: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  sessionId: "session-1",
  authTime: 1_700_000_000,
  roles: ["viewer"],
  permissions: ["runs:read"],
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};
const bareContext: EngineCallerContext = {
  ...context,
  tenantId: context.tenantId.slice("ten_".length),
  workspaceId: context.workspaceId.slice("ws_".length),
};

const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc";

describe("CostLedgerClient", () => {
  it("normalizes bare platform IDs at the cost-ledger boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      node_costs: [],
    }));
    const client = new CostLedgerClient(config, authProvider(), fetchImpl);
    await client.getNodeCosts(runId, bareContext);

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://costs.test/costs/by-run/${runId}?tenantId=${context.tenantId}&workspaceId=${context.workspaceId}`,
      expect.any(Object),
    );
  });

  it("gets the real scoped route and returns only validated node costs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      node_costs: [
        {
          node_execution_id: "node_018f47a5-7b2c-7d10-8f11-123456789abd",
          internal_cost_minor: "37",
          billable_minor: "45",
          event_count: 2,
        },
      ],
    }));
    const client = new CostLedgerClient(config, authProvider(), fetchImpl);

    await expect(client.getNodeCosts(runId, context)).resolves.toEqual([
      {
        nodeExecutionId: "node_018f47a5-7b2c-7d10-8f11-123456789abd",
        billableMinor: "45",
        eventCount: 2,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://costs.test/costs/by-run/${runId}?tenantId=${context.tenantId}&workspaceId=${context.workspaceId}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer m2m-token",
          "X-Alter-Actor-Token": "actor-token",
          traceparent: context.traceparent,
        }),
      }),
    );
  });

  it("fails closed for malformed cost payloads and non-success responses", async () => {
    const malformed = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockResolvedValue(jsonResponse(200, { node_costs: [{ nope: true }] })),
    );
    await expect(malformed.getNodeCosts(runId, context)).rejects.toMatchObject({
      problem: { status: 502, error_code: "UPSTREAM_SERVICE_ERROR" },
    });

    const unavailable = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockResolvedValue(jsonResponse(503, {})),
    );
    await expect(unavailable.getNodeCosts(runId, context)).rejects.toMatchObject({
      problem: { status: 503, error_code: "UPSTREAM_SERVICE_ERROR" },
    });
  });

  it("fails closed when authorization or transport fails", async () => {
    const authFailure = new CostLedgerClient(
      config,
      { authorize: vi.fn().mockRejectedValue(new Error("unavailable")) },
      vi.fn(),
    );
    await expect(authFailure.getNodeCosts(runId, context)).rejects.toMatchObject({
      problem: { status: 502 },
    });

    const transportFailure = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockRejectedValue(new Error("offline")),
    );
    await expect(transportFailure.getNodeCosts(runId, context)).rejects.toMatchObject({
      problem: { status: 502 },
    });
  });

  it("gets summary through existing HTTP client with actor scope and dimensions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      rollups_json: "{\"groups\":[]}",
    }));
    const client = new CostLedgerClient(config, authProvider(), fetchImpl);

    await expect(client.getSummary({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-02-01T00:00:00.000Z",
      dimensions: ["mode", "provider"],
    }, bareContext)).resolves.toBe("{\"groups\":[]}");

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://costs.test/costs/summary?tenantId=${context.tenantId}&workspaceId=${context.workspaceId}&startAt=2026-01-01T00%3A00%3A00.000Z&endAt=2026-02-01T00%3A00%3A00.000Z&dimensions=mode&dimensions=provider`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("never hands the internal cost of a step onward, only its billed price (D24)", async () => {
    const client = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockResolvedValue(jsonResponse(200, {
        node_costs: [{ node_execution_id: "node_018f47a5-7b2c-7d10-8f11-123456789abd", internal_cost_minor: "37", billable_minor: "45", event_count: 2 }],
      })),
    );
    const [cost] = await client.getNodeCosts(runId, context);
    expect(Object.keys(cost!)).toEqual(["nodeExecutionId", "billableMinor", "eventCount"]);
  });

  it("asks for each run's billed total in batches of 200 and fails closed on a malformed answer", async () => {
    const runIds = Array.from({ length: 201 }, (_, index) =>
      `run_018f47a5-7b2c-7d10-8f11-${index.toString(16).padStart(12, "0")}`,
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { runIds: string[] };
      return jsonResponse(200, { runs: body.runIds.map((id) => ({ run_id: id, billable_minor: "2" })) });
    });
    const client = new CostLedgerClient(config, authProvider(), fetchImpl as unknown as typeof fetch);

    const totals = await client.getRunTotals(runIds, bareContext, "/api/v1/workflows/x/costs");

    expect(totals.size).toBe(201);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("https://costs.test/costs/run-totals");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).runIds).toHaveLength(1);

    const malformed = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockResolvedValue(jsonResponse(200, { runs: [{ run_id: runId, billable_minor: "-1" }] })),
    );
    await expect(malformed.getRunTotals([runId], context, "/x")).rejects.toMatchObject({
      problem: { status: 502, error_code: "UPSTREAM_SERVICE_ERROR" },
    });
  });
});

function authProvider(): EngineAuthProvider {
  return {
    authorize: vi.fn().mockResolvedValue({
      m2mAccessToken: "m2m-token",
      actorToken: "actor-token",
    }),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
