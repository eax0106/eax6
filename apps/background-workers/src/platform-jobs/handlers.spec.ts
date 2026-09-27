import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { createPlatformJobHandlers } from "./handlers";

describe("createPlatformJobHandlers", () => {
  it("registers the real health-ping handler", async () => {
    const handlers = createPlatformJobHandlers();
    const handler = handlers.get("platform.health-ping");
    expect(handler).toBeDefined();

    const result = await handler!({ probe: 1 });
    expect(result).toEqual({ pong: true, receivedPayload: { probe: 1 } });
  });

  it("has no handler registered for an unknown job type", () => {
    const handlers = createPlatformJobHandlers();
    expect(handlers.get("platform.does-not-exist")).toBeUndefined();
  });

  it("does not register the notification-digest handler without real dependencies", () => {
    const handlers = createPlatformJobHandlers();
    expect(handlers.get("platform.notification-digest")).toBeUndefined();
  });

  it("registers a real notification-digest handler that relays to platform-api's internal route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ users_processed: 2, users_failed: 0 }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      platformApiInternalBaseUrl: "http://platform-api.internal",
      notificationDigestServiceToken: "real-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.notification-digest");
    expect(handler).toBeDefined();

    const result = await handler!({
      period_start: "2026-08-05T00:00:00.000Z",
      period_end: "2026-08-06T00:00:00.000Z",
    } as never);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://platform-api.internal/internal/notifications/run-due-digests",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer real-token" }),
      }),
    );
    expect(result).toEqual({ users_processed: 2, users_failed: 0 });
  });

  it("throws a real error when the internal route responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "service unavailable",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      platformApiInternalBaseUrl: "http://platform-api.internal",
      notificationDigestServiceToken: "real-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.notification-digest")!;

    await expect(
      handler({
        period_start: "2026-08-05T00:00:00.000Z",
        period_end: "2026-08-06T00:00:00.000Z",
      } as never),
    ).rejects.toThrow(/503/);
  });

  it("does not register the connector-health-sweep handler without real dependencies", () => {
    const handlers = createPlatformJobHandlers();
    expect(handlers.get("platform.connector-health-sweep")).toBeUndefined();
  });

  it("registers a real connector-health-sweep handler that relays to platform-api's internal route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ connections_processed: 3, connections_failed: 0 }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      platformApiInternalBaseUrl: "http://platform-api.internal",
      connectorHealthSweepServiceToken: "real-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.connector-health-sweep");
    expect(handler).toBeDefined();

    const result = await handler!({});

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://platform-api.internal/internal/integrations/run-health-sweep",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer real-token" }),
      }),
    );
    expect(result).toEqual({ connections_processed: 3, connections_failed: 0 });
  });

  it("does not register the retention-sweep handler without real dependencies", () => {
    const handlers = createPlatformJobHandlers();
    expect(handlers.get("platform.retention-sweep")).toBeUndefined();
  });

  it("registers a real retention-sweep handler that relays to ads-core's internal route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ deletedDocuments: 4 }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      adsCoreInternalBaseUrl: "http://ads-core.internal",
      retentionSweepServiceToken: "real-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.retention-sweep");
    expect(handler).toBeDefined();

    const result = await handler!({});

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://ads-core.internal/internal/deletion/retention",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer real-token" }),
      }),
    );
    expect(result).toEqual({ deletedDocuments: 4 });
  });

  it("throws a real error when the retention sweep route responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "unauthorized",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      adsCoreInternalBaseUrl: "http://ads-core.internal",
      retentionSweepServiceToken: "wrong-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.retention-sweep")!;

    await expect(handler({})).rejects.toThrow(/401/);
  });

  it("does not register the benchmark-sweep handler without real dependencies", () => {
    const handlers = createPlatformJobHandlers();
    expect(handlers.get("platform.benchmark-sweep")).toBeUndefined();
  });

  it("registers a real benchmark-sweep handler that sweeps every real launch-floor golden set with trigger=scheduled", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ evaluation_run_id: "evr_1", status: "completed", results_json: "{}" }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
      evalFacadeServiceToken: "real-token",
      fetchImpl,
    });
    const handler = handlers.get("platform.benchmark-sweep");
    expect(handler).toBeDefined();

    const result = await handler!({});

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const goldenSetName of ["planner", "intent", "retrieval", "verification"]) {
      expect(fetchImpl).toHaveBeenCalledWith(
        "http://orchestration-service.internal/internal/eval/run-evaluation",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer real-token" }),
          body: JSON.stringify({ golden_set_name: goldenSetName, trigger: "scheduled" }),
        }),
      );
    }
    expect(result).toEqual({
      goldenSetsProcessed: 4,
      goldenSetsFailed: 0,
      retrievalRecallBelowThreshold: false,
    });
  });

  it("real isolates a single golden-set failure from the rest of the sweep", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ evaluation_run_id: "evr_1", status: "completed", results_json: "{}" }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
      evalFacadeServiceToken: "real-token",
      fetchImpl,
    });
    const result = await handlers.get("platform.benchmark-sweep")!({});

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result).toEqual({
      goldenSetsProcessed: 3,
      goldenSetsFailed: 1,
      retrievalRecallBelowThreshold: false,
    });
  });

  it("flags a real retrieval recall regression instead of letting it sit unexamined", async () => {
    const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
      const { golden_set_name: goldenSetName } = JSON.parse(init.body) as {
        golden_set_name: string;
      };
      const passRate = goldenSetName === "retrieval" ? 0.5 : 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          evaluation_run_id: "evr_1",
          status: "completed",
          results_json: JSON.stringify({ golden_set_name: goldenSetName, pass_rate: passRate }),
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
      evalFacadeServiceToken: "real-token",
      fetchImpl,
    });
    const result = await handlers.get("platform.benchmark-sweep")!({});

    expect(result).toEqual({
      goldenSetsProcessed: 4,
      goldenSetsFailed: 0,
      retrievalRecallBelowThreshold: true,
    });
  });

  it("does not flag retrieval recall when it clears the real 0.90 PRD floor", async () => {
    const fetchImpl = vi.fn(async (url: string, init: { body: string }) => {
      const { golden_set_name: goldenSetName } = JSON.parse(init.body) as {
        golden_set_name: string;
      };
      const passRate = goldenSetName === "retrieval" ? 0.95 : 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          evaluation_run_id: "evr_1",
          status: "completed",
          results_json: JSON.stringify({ golden_set_name: goldenSetName, pass_rate: passRate }),
        }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const handlers = createPlatformJobHandlers({
      orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
      evalFacadeServiceToken: "real-token",
      fetchImpl,
    });
    const result = await handlers.get("platform.benchmark-sweep")!({});

    expect(result).toEqual({
      goldenSetsProcessed: 4,
      goldenSetsFailed: 0,
      retrievalRecallBelowThreshold: false,
    });
  });

  it("discovers and scores every eligible drift candidate", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { tenant_id: "ten_1", agent_id: "agent_1", task_class: "support" },
            { tenant_id: "ten_2", agent_id: "agent_2", task_class: "sales" },
          ],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" }) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      intelligenceServiceInternalBaseUrl: "http://intelligence-service.internal",
      memoryServiceInternalBaseUrl: "http://memory-service.internal",
      driftSweepServiceToken: "real-token",
      driftSweepMinimumObservations: 40,
      fetchImpl,
    });

    const result = await handlers.get("platform.drift-sweep")!({});

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://intelligence-service.internal/internal/performance/drift-candidates?minimum_observations=40",
      { headers: { authorization: "Bearer real-token" } },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://memory-service.internal/drift/agents/score",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tenant_id: "ten_1", agent_id: "agent_1", task_class: "support" }),
      }),
    );
    expect(result).toEqual({ candidates: 2, scored: 1, failed: 1 });
  });

  it("real isolates a single drift candidate score failure from the rest of the sweep", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { tenant_id: "ten_1", agent_id: "agent_1", task_class: "support" },
            { tenant_id: "ten_2", agent_id: "agent_2", task_class: "sales" },
            { tenant_id: "ten_3", agent_id: "agent_3", task_class: "billing" },
          ],
        }),
        text: async () => "",
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" })
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" }) as unknown as typeof fetch;
    const logger = { error: vi.fn() } as unknown as Logger;
    const handlers = createPlatformJobHandlers({
      intelligenceServiceInternalBaseUrl: "http://intelligence-service.internal",
      memoryServiceInternalBaseUrl: "http://memory-service.internal",
      driftSweepServiceToken: "real-token",
      driftSweepMinimumObservations: 40,
      fetchImpl,
      driftSweepLogger: logger,
    });

    const result = await handlers.get("platform.drift-sweep")!({});

    // All three candidates' scores were at least attempted despite the
    // middle one throwing -- the sweep continued to the remaining ones.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ candidates: 3, scored: 2, failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logArgs = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string | undefined,
    ];
    expect(logArgs[0]).toMatch(/network blip/);
    expect(logArgs[0]).toMatch(/tenant_id=ten_2/);
  });

  it("real relays a clean audit chain verification", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, checkedEvents: 12 }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceToken: "real-token",
      fetchImpl,
    });

    const result = await handlers.get("platform.audit-chain-verify")!({});

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://audit-service.internal/internal/audit-events/verify-chain",
      { method: "POST", headers: { authorization: "Bearer real-token" } },
    );
    expect(result).toEqual({ valid: true, checkedEvents: 12 });
  });

  it("relays a full audit chain verification to the genesis-walk route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, checkedEvents: 4_200 }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceToken: "real-token",
      fetchImpl,
    });

    const result = await handlers.get("platform.audit-chain-full-verify")!({});

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://audit-service.internal/internal/audit-events/verify-chain/full",
      { method: "POST", headers: { authorization: "Bearer real-token" } },
    );
    expect(result).toEqual({ valid: true, checkedEvents: 4_200 });
  });

  it("surfaces a broken full audit chain as a job failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        valid: false,
        checkedEvents: 100,
        issue: "previous-hash-mismatch",
        eventId: "aud_old",
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceToken: "real-token",
      fetchImpl,
    });

    await expect(handlers.get("platform.audit-chain-full-verify")!({})).rejects.toThrow(
      /previous-hash-mismatch/,
    );
  });

  it("real surfaces a broken audit chain as a job failure, not a silent success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: false, checkedEvents: 3, issue: "hash-mismatch", eventId: "aud_x" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceToken: "real-token",
      fetchImpl,
    });

    await expect(handlers.get("platform.audit-chain-verify")!({})).rejects.toThrow(
      /hash-mismatch/,
    );
  });

  it("real surfaces an HTTP failure from the verify-chain route", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "internal error",
    })) as unknown as typeof fetch;
    const handlers = createPlatformJobHandlers({
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceToken: "real-token",
      fetchImpl,
    });

    await expect(handlers.get("platform.audit-chain-verify")!({})).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
