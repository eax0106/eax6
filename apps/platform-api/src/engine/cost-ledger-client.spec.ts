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
          event_count: 2,
        },
      ],
    }));
    const client = new CostLedgerClient(config, authProvider(), fetchImpl);

    await expect(client.getNodeCosts(runId, context)).resolves.toEqual([
      {
        nodeExecutionId: "node_018f47a5-7b2c-7d10-8f11-123456789abd",
        internalCostMinor: "37",
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

  it("relays estimate with bare upstream tenant ID and fails closed for malformed data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, estimateResponse()));
    const client = new CostLedgerClient(config, authProvider(), fetchImpl);
    await expect(client.estimate({
      mode: "workflow",
      lineItems: [{
        source: "model_gateway",
        provider: "bedrock",
        resource: "claude",
        expectedQuantity: 2,
      }],
    }, bareContext)).resolves.toMatchObject({ currency: "INR" });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      tenantId: bareContext.tenantId,
      mode: "workflow",
    });

    const malformed = new CostLedgerClient(
      config,
      authProvider(),
      vi.fn().mockResolvedValue(jsonResponse(200, { currency: "USD" })),
    );
    await expect(malformed.estimate({ mode: "workflow", lineItems: [] }, context)).rejects.toMatchObject({
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

function estimateResponse(): unknown {
  return {
    currency: "INR",
    lineItems: [{
      source: "model_gateway",
      provider: "bedrock",
      resource: "claude",
      expectedQuantity: 2,
      confidence: "tenant_historical",
      sampleSize: 3,
      historicalUnitCostMinor: "4",
      estimatedBaseCostMinor: "8",
      historicalRetryRate: 0,
      estimatedRetryCostMinor: "0",
      estimatedTotalCostMinor: "8",
    }],
    totalEstimatedInternalCostMinor: "8",
    hasUnestimatedLineItems: false,
  };
}
