import { describe, expect, it, vi } from "vitest";
import type {
  EngineCallerContext,
  EngineClient,
  CostLedgerClient,
  EnginePath,
  EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { RunService } from "./run.service";
import type { EnginePage, EngineResource } from "./types";

const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const artifactId = "art_018f47a5-7b2c-7d10-8f11-123456789abc";
const traceparent =
  "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
const actor: ActorContext = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["viewer"],
  permissions: ["runs:read"],
};

describe("RunService", () => {
  it("launches workflow run through Engine HTTP route", async () => {
    const engine = engineStub(async () => ({ status: 200, body: page([]) }));
    const service = new RunService(engine.value, costLedgerStub().value);
    const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
    await service.create({ workflow_id: workflowId }, actor, traceparent, "run-key");
    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/runs",
      { workflow_id: workflowId },
      expectedContext(),
      { idempotencyKey: "run-key" },
    );
  });

  it("relays real list filters, pagination, and opaque cross-mode rows", async () => {
    const response = page([
      { run_id: runId, parent_kind: "workflow" },
      { run_id: `${runId}-opaque`, parent_kind: "project" },
    ]);
    const engine = engineStub(async () => ({ status: 200, body: response }));
    const service = new RunService(engine.value, costLedgerStub().value);

    const result = await service.list(
      {
        cursor: "next cursor",
        limit: "25",
        status: "running",
        mode: "project",
        started_after: "2026-07-01T00:00:00.000Z",
        started_before: "2026-07-26T00:00:00.000Z",
      },
      actor,
      traceparent,
    );

    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/runs?cursor=next+cursor&limit=25&status=running&mode=project&started_after=2026-07-01T00%3A00%3A00.000Z&started_before=2026-07-26T00%3A00%3A00.000Z",
      expectedContext(),
    );
    expect(result.body).toEqual(response);
  });

  it("aggregates all five real sub-resources without reshaping opaque items", async () => {
    const executionA = {
      id: "node_018f47a5-7b2c-7d10-8f11-123456789abc",
      result: { answer: 42 },
      engine_extension: "kept",
    };
    const executionB = {
      id: "node_018f47a5-7b2c-7d10-8f11-123456789abd",
      result: null,
    };
    const verification = { verification_id: "ver_1", score: 0.98 };
    const recovery = { recovery_action_id: "rec_1", strategy: "retry" };
    const qualityGate = { quality_gate_id: "qg_1", status: "passed" };
    const outcome = { status: "completed", summary: "done" };
    const engine = engineStub(async (path) => {
      if (path === `/api/v1/runs/${runId}`) {
        return { status: 200, body: { run_id: runId, status: "completed" } };
      }
      if (path.includes("/node-executions?limit=200")) {
        return {
          status: 200,
          body: page([executionA], true, "node next"),
        };
      }
      if (path.includes("/node-executions?cursor=node+next")) {
        return { status: 200, body: page([executionB]) };
      }
      if (path.includes("/verification-results")) {
        return { status: 200, body: page([verification]) };
      }
      if (path.includes("/recovery-actions")) {
        return { status: 200, body: page([recovery]) };
      }
      if (path.includes("/quality-gates")) {
        return { status: 200, body: page([qualityGate]) };
      }
      if (path.endsWith("/outcome")) {
        return { status: 200, body: outcome };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    const costs = costLedgerStub(async () => [
      {
        nodeExecutionId: "node_018f47a5-7b2c-7d10-8f11-123456789abc",
        internalCostMinor: "37",
        eventCount: 2,
      },
    ]);
    const service = new RunService(engine.value, costs.value);

    const response = await service.detail(runId, actor, traceparent);

    expect(response.body).toEqual({
      run: { run_id: runId, status: "completed" },
      node_executions: [
        { ...executionA, node_cost_minor: "37" },
        { ...executionB, node_cost_minor: "0" },
      ],
      verification_results: [verification],
      recovery_actions: [recovery],
      quality_gates: [qualityGate],
      outcome,
    });
    expect(costs.getNodeCosts).toHaveBeenCalledWith(runId, expectedContext());
    expect(response.body.node_executions[0]).toEqual({
      ...executionA,
      node_cost_minor: "37",
    });
  });

  it("aggregates verification-results and recovery-actions across pages for their own dedicated routes", async () => {
    const first = { verification_id: "ver_1", score: 0.98 };
    const second = { verification_id: "ver_2", score: 0.5 };
    const recovery = { recovery_action_id: "rec_1", strategy: "retry" };
    const engine = engineStub(async (path) => {
      if (path.includes("/verification-results?limit=200")) {
        return { status: 200, body: page([first], true, "ver next") };
      }
      if (path.includes("/verification-results?cursor=ver+next")) {
        return { status: 200, body: page([second]) };
      }
      if (path.includes("/recovery-actions")) {
        return { status: 200, body: page([recovery]) };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    const service = new RunService(engine.value, costLedgerStub().value);

    const verification = await service.verificationResults(runId, actor, traceparent);
    expect(verification).toEqual([first, second]);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/verification-results?limit=200`,
      expectedContext(),
    );
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/verification-results?cursor=ver+next&limit=200`,
      expectedContext(),
    );

    const recoveryActions = await service.recoveryActions(runId, actor, traceparent);
    expect(recoveryActions).toEqual([recovery]);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/recovery-actions?limit=200`,
      expectedContext(),
    );
  });

  it("rejects malformed run ids for the dedicated verification/recovery routes without calling Engine", async () => {
    const engine = engineStub(async () => ({ status: 200, body: page([]) }));
    const service = new RunService(engine.value, costLedgerStub().value);

    expect(() => service.verificationResults("bad", actor, traceparent)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => service.recoveryActions("bad", actor, traceparent)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("passes artifact metadata through unchanged", async () => {
    const metadata = {
      artifact_id: artifactId,
      media_type: "application/json",
      engine_extension: { opaque: true },
    };
    const engine = engineStub(async () => ({ status: 200, body: metadata }));
    const service = new RunService(engine.value, costLedgerStub().value);

    const response = await service.artifact(artifactId, actor, traceparent);

    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/artifacts/${artifactId}`,
      expectedContext(),
    );
    expect(response.body).toEqual(metadata);
  });

  it("rejects invented filters, invalid ranges, ids, and trace context", async () => {
    const engine = engineStub(async () => ({ status: 200, body: page([]) }));
    const service = new RunService(engine.value, costLedgerStub().value);

    expect(() =>
      service.list({ mode: "unsupported" } as never, actor, traceparent),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      service.list(
        {
          started_after: "2026-07-26T00:00:00.000Z",
          started_before: "2026-07-01T00:00:00.000Z",
        },
        actor,
        traceparent,
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
    await expect(service.detail("bad", actor, traceparent)).rejects.toMatchObject({
      status: 400,
    });
    expect(() => service.artifact("bad", actor, traceparent)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => service.list({}, actor, "bad-trace")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("requires workspace context and generates missing trace context", async () => {
    const engine = engineStub(async () => ({ status: 200, body: page([]) }));
    const service = new RunService(engine.value, costLedgerStub().value);
    const { workspace_id: _workspace, ...withoutWorkspace } = actor;
    void _workspace;

    expect(() =>
      service.list({}, withoutWorkspace, traceparent),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        response: expect.objectContaining({
          error_code: "RUN_WORKSPACE_REQUIRED",
        }),
      }),
    );

    await service.list({}, actor, undefined);
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/runs",
      expect.objectContaining({
        traceparent: expect.stringMatching(
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        ),
      }),
    );
  });

  it("rejects malformed Engine pagination rather than returning partial data", async () => {
    const engine = engineStub(async (path) => {
      if (path === `/api/v1/runs/${runId}`) {
        return { status: 200, body: { run_id: runId } };
      }
      if (path.endsWith("/outcome")) {
        return { status: 200, body: {} };
      }
      return { status: 200, body: page([], true, null) };
    });
    const service = new RunService(engine.value, costLedgerStub().value);

    await expect(service.detail(runId, actor, traceparent)).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({
        error_code: "INVALID_ENGINE_RUN_RESPONSE",
      }),
    });
  });
});

function expectedContext(): EngineCallerContext {
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id!,
    sessionId: actor.session_id,
    authTime: actor.auth_time!,
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent,
  };
}

function page(
  data: readonly EngineResource[],
  hasMore = false,
  nextCursor: string | null = null,
): EnginePage<EngineResource> {
  return {
    data,
    page: { next_cursor: nextCursor, has_more: hasMore, limit: 200 },
  };
}

function engineStub(
  implementation: (
    path: EnginePath,
    context: EngineCallerContext,
  ) => Promise<EngineResponse<EngineResource | EnginePage<EngineResource>>>,
): {
  value: EngineClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(implementation);
  const post = vi.fn().mockResolvedValue({ status: 201, body: { id: runId } });
  return {
    value: { get, post } as unknown as EngineClient,
    get,
    post,
  };
}

function costLedgerStub(
  implementation: (
    run: string,
    context: EngineCallerContext,
  ) => Promise<readonly { nodeExecutionId: string; internalCostMinor: string; eventCount: number }[]> = async () => [],
): { value: CostLedgerClient; getNodeCosts: ReturnType<typeof vi.fn> } {
  const getNodeCosts = vi.fn(implementation);
  return {
    value: { getNodeCosts } as unknown as CostLedgerClient,
    getNodeCosts,
  };
}
