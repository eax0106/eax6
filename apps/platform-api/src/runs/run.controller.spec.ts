import { APP_FILTER } from "@nestjs/core";
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
import {
  EngineClient,
  CostLedgerClient,
  EngineExceptionFilter,
  EngineProblemError,
  type EngineCallerContext,
  type EnginePath,
  type EngineResponse,
} from "../engine";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { PgIdempotencyStore } from "../idempotency";
import { ArtifactController, RunController } from "./run.controller";
import { RunExceptionFilter } from "./run-exception.filter";
import { RunService } from "./run.service";
import type { EnginePage, EngineResource } from "./types";

const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const artifactId = "art_018f47a5-7b2c-7d10-8f11-123456789abc";
const actor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["viewer"],
  permissions: ["runs:read"],
};
const noScope: ActorContextType = { ...actor, permissions: [] };

describe("RunController routes", () => {
  let app: NestFastifyApplication;
  const engine = new RunEngine();
  const costs = {
    getNodeCosts: vi.fn().mockResolvedValue([]),
    getRunTotals: vi.fn(async (runIds: readonly string[]) => new Map(runIds.map((id) => [id, "0"]))),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [RunController, ArtifactController],
      providers: [
        RunService,
        RunExceptionFilter,
        { provide: EngineClient, useValue: engine },
        { provide: CostLedgerClient, useValue: costs },
        {
          provide: PgIdempotencyStore,
          useValue: {
            execute: async (_input: unknown, operation: () => Promise<{ status: number; body: unknown }>) => ({
              ...(await operation()),
              replayed: false,
            }),
          },
        },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.getHttpAdapter().getInstance().addHook(
      "preHandler",
      (request: FastifyRequest, _reply: unknown, done: () => void) => {
        const value = request.headers["x-test-actor"];
        if (typeof value === "string") {
          (request as RbacRequest).actorContext = JSON.parse(
            value,
          ) as ActorContextType;
        }
        done();
      },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    engine.reset();
    costs.getNodeCosts.mockClear();
  });

  afterAll(async () => app.close());

  it("launches a workflow run through authenticated Engine relay", async () => {
    const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: {
        "x-test-actor": JSON.stringify({ ...actor, roles: ["operator"] }),
        "idempotency-key": "run-launch-1",
      },
      payload: { workflow_id: workflowId },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(engine.run);
    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/runs",
      { workflow_id: workflowId },
      expect.objectContaining({ tenantId: actor.tenant_id }),
      { idempotencyKey: "run-launch-1" },
    );
  });

  it("cancels a run through the engine and answers with the run it wrote", async () => {
    const response = await post(`/api/v1/runs/${runId}/actions/cancel`, {
      actor: { ...actor, roles: ["operator"] },
      idempotencyKey: "run-cancel-1",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.cancelledRun);
    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/actions/cancel`,
      {},
      expect.objectContaining({ tenantId: actor.tenant_id }),
      { idempotencyKey: "run-cancel-1" },
    );
  });

  it("retries one node by its key", async () => {
    const response = await post(`/api/v1/runs/${runId}/actions/retry-node`, {
      actor: { ...actor, roles: ["operator"] },
      idempotencyKey: "run-retry-1",
      payload: { node_key: "extract" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.run);
    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/actions/retry-node`,
      { node_key: "extract" },
      expect.objectContaining({ tenantId: actor.tenant_id }),
      { idempotencyKey: "run-retry-1" },
    );
  });

  it.each([
    ["an empty body", {}],
    ["a blank node key", { node_key: "   " }],
    ["an unknown field", { node_key: "extract", force: true }],
  ])("refuses a retry with %s before calling the engine", async (_case, payload) => {
    const response = await post(`/api/v1/runs/${runId}/actions/retry-node`, {
      actor: { ...actor, roles: ["operator"] },
      idempotencyKey: `run-retry-invalid-${JSON.stringify(payload)}`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(engine.post).not.toHaveBeenCalled();
  });

  it("refuses an action on something that is not a run id", async () => {
    const response = await post("/api/v1/runs/wf_not-a-run/actions/cancel", {
      actor: { ...actor, roles: ["operator"] },
      idempotencyKey: "run-cancel-bad-id",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(engine.post).not.toHaveBeenCalled();
  });

  it.each(["cancel", "retry-node"])(
    "denies %s to a role that may only read runs",
    async (action) => {
      const response = await post(`/api/v1/runs/${runId}/actions/${action}`, {
        actor: { ...actor, roles: ["viewer"] },
        idempotencyKey: `run-${action}-viewer`,
        payload: action === "cancel" ? {} : { node_key: "extract" },
      });

      expect(response.statusCode).toBe(403);
      expect(engine.post).not.toHaveBeenCalled();
    },
  );

  it("answers the pre-run estimate on its own route, not as a run id (D4)", async () => {
    const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
    const response = await request(`/api/v1/runs/estimate?workflow_id=${workflowId}`, actor);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.estimate);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/runs/estimate?workflow_id=${workflowId}`,
      expect.objectContaining({ tenantId: actor.tenant_id, workspaceId: actor.workspace_id }),
    );
  });

  it("refuses the estimate to a caller without runs:read", async () => {
    const response = await request(
      "/api/v1/runs/estimate?workflow_id=wf_018f47a5-7b2c-7d10-8f11-123456789abc",
      noScope,
    );
    expect(response.statusCode).toBe(403);
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("lists paginated opaque rows using only real filters", async () => {
    const response = await request(
      "/api/v1/runs?cursor=next&limit=25&status=running&started_after=2026-07-01T00%3A00%3A00.000Z&started_before=2026-07-26T00%3A00%3A00.000Z",
      actor,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.runList);
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/runs?cursor=next&limit=25&status=running&started_after=2026-07-01T00%3A00%3A00.000Z&started_before=2026-07-26T00%3A00%3A00.000Z",
      expect.objectContaining({
        userId: actor.user_id,
        tenantId: actor.tenant_id,
        permissions: ["runs:read"],
      }),
    );
  });

  it("aggregates real run sub-resources and side-effect-free per-node costs", async () => {
    const response = await request(`/api/v1/runs/${runId}`, actor);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      run: engine.run,
      node_executions: engine.nodeExecutions.data.map((execution) => ({
        ...execution,
        node_cost_minor: "0",
      })),
      verification_results: engine.verificationResults.data,
      recovery_actions: engine.recoveryActions.data,
      quality_gates: engine.qualityGates.data,
      outcome: engine.outcome,
      run_cost_minor: "0",
    });
    expect(costs.getNodeCosts).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
    );
    expect(response.json()).not.toHaveProperty("artifacts");
  });

  it("relays verification-results and recovery-actions through their own dedicated routes", async () => {
    const verification = await request(`/api/v1/runs/${runId}/verification-results`, actor);
    expect(verification.statusCode).toBe(200);
    expect(verification.json()).toEqual(engine.verificationResults.data);

    const recovery = await request(`/api/v1/runs/${runId}/recovery-actions`, actor);
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toEqual(engine.recoveryActions.data);
  });

  it.each([
    [`/api/v1/runs/${runId}/verification-results`],
    [`/api/v1/runs/${runId}/recovery-actions`],
  ])("scope-gates %s", async (url) => {
    const response = await request(url, noScope);
    expectProblem(response, 403, "RBAC_PERMISSION_DENIED");
    expect(engine.get).not.toHaveBeenCalled();
  });

  it.each([
    [`/api/v1/runs/bad/verification-results`],
    [`/api/v1/runs/bad/recovery-actions`],
  ])("rejects invalid run id for %s", async (url) => {
    const response = await request(url, actor);
    expectProblem(response, 400, "INVALID_RUN_REQUEST");
  });

  it("passes artifact metadata through unchanged", async () => {
    const response = await request(`/api/v1/artifacts/${artifactId}`, actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.artifact);
  });

  it("relays the workspace's artifact list with its cursor and limit", async () => {
    const response = await request(`/api/v1/artifacts?limit=25&cursor=${artifactId}`, actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.artifactList);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/artifacts?cursor=${artifactId}&limit=25`,
      expect.any(Object),
    );
  });

  it("relays signed artifact download references through Platform", async () => {
    const response = await request(`/api/v1/artifacts/${artifactId}/download`, actor);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(engine.artifact);
  });

  it.each([
    ["/api/v1/runs"],
    [`/api/v1/runs/${runId}`],
    [`/api/v1/artifacts/${artifactId}`],
    ["/api/v1/artifacts"],
  ])("scope-gates %s", async (url) => {
    const response = await request(url, noScope);
    expectProblem(response, 403, "RBAC_PERMISSION_DENIED");
    expect(engine.get).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/v1/runs?status=unknown"],
    ["/api/v1/runs?limit=0"],
    ["/api/v1/runs/bad"],
    ["/api/v1/artifacts/bad"],
    ["/api/v1/artifacts?limit=201"],
    ["/api/v1/artifacts?cursor=bad"],
    ["/api/v1/artifacts?run_id=x"],
  ])("rejects invalid request %s", async (url) => {
    const response = await request(url, actor);
    expectProblem(response, 400, "INVALID_RUN_REQUEST");
  });

  it.each([
    "/api/v1/runs",
    `/api/v1/runs/${runId}`,
    `/api/v1/artifacts/${artifactId}`,
  ])("passes through Engine problem for %s", async (url) => {
    engine.failNext(
      url.startsWith("/api/v1/runs?") ? "/api/v1/runs" : url,
    );
    const response = await request(url, actor);
    expectProblem(response, 503, "ENGINE_RUN_UNAVAILABLE");
    expect(response.json()).toMatchObject({
      detail: "Engine run service unavailable",
      retryable: true,
    });
  });

  it("passes through Engine errors from aggregated sub-resources", async () => {
    engine.failNext(`/api/v1/runs/${runId}/quality-gates`);
    const response = await request(`/api/v1/runs/${runId}`, actor);
    expectProblem(response, 503, "ENGINE_RUN_UNAVAILABLE");
  });

  it("keeps unsupported run artifact collection absent", async () => {
    expect(
      (await request(`/api/v1/runs/${runId}/artifacts`, actor)).statusCode,
    ).toBe(404);
  });

  it("keeps direct controller calls default-deny without actor context", async () => {
    const controller = new RunController(
      { list: vi.fn() } as unknown as RunService,
    );
    await expect(
      controller.list(
        {},
        undefined,
        undefined,
        {} as import("fastify").FastifyReply,
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });
  });

  function post(
    url: string,
    options: {
      actor: ActorContextType;
      idempotencyKey: string;
      payload: unknown;
    },
  ): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url,
      headers: {
        "x-test-actor": JSON.stringify(options.actor),
        "idempotency-key": options.idempotencyKey,
      },
      payload: options.payload as object,
    }) as Promise<TestResponse>;
  }

  function request(
    url: string,
    requestActor?: ActorContextType,
  ): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url,
      headers: requestActor
        ? { "x-test-actor": JSON.stringify(requestActor) }
        : {},
    }) as Promise<TestResponse>;
  }
});

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}

class RunEngine {
  readonly get = vi.fn(this.getResponse.bind(this));
  // Launching a run answers 201; the action routes answer 200 with the run
  // as the engine last wrote it.
  readonly post = vi.fn(async (path: EnginePath) => ({
    status: path === "/api/v1/runs" ? 201 : 200,
    body: path.endsWith("/actions/cancel") ? this.cancelledRun : this.run,
  }));
  readonly runList = page([
    { run_id: runId, parent_kind: "workflow", status: "running" },
    { run_id: `${runId}-opaque`, parent_kind: "project", status: "completed" },
  ]);
  readonly run = { run_id: runId, status: "completed", engine_field: "kept" };
  readonly cancelledRun = { run_id: runId, status: "cancelled" };
  readonly nodeExecutions = page([
    { node_execution_id: "nex_1", result: { answer: 42 }, opaque: true },
  ]);
  readonly verificationResults = page([
    { verification_id: "ver_1", passed: true },
  ]);
  readonly recoveryActions = page([
    { recovery_action_id: "rec_1", strategy: "retry" },
  ]);
  readonly qualityGates = page([
    { quality_gate_id: "qg_1", status: "passed" },
  ]);
  readonly outcome = { status: "completed", summary: "done" };
  readonly estimate = {
    currency: "INR",
    at_most_minor: 500,
    usually_minor: null,
    sample_runs: 0,
    model_calls: 2,
    unpriced_calls: 0,
  };
  readonly artifact = {
    artifact_id: artifactId,
    media_type: "application/json",
    engine_extension: "kept",
  };
  readonly artifactList = page([
    { id: artifactId, runId, contentType: "text/plain", sizeBytes: 12 },
  ]);
  private failurePath: string | undefined;

  reset(): void {
    this.failurePath = undefined;
    this.get.mockClear();
    this.post.mockClear();
  }

  failNext(path: string): void {
    this.failurePath = path;
  }

  private async getResponse(
    path: EnginePath,
    _context: EngineCallerContext,
  ): Promise<EngineResponse<EngineResource | EnginePage<EngineResource>>> {
    void _context;
    const barePath = path.split("?")[0]!;
    if (this.failurePath === barePath) {
      this.failurePath = undefined;
      throw new EngineProblemError({
        type: "https://errors.alter.ai/engine-run-unavailable",
        title: "ENGINE_RUN_UNAVAILABLE",
        status: 503,
        detail: "Engine run service unavailable",
        instance: barePath,
        error_code: "ENGINE_RUN_UNAVAILABLE",
        trace_id: "trc_engine",
        request_id: "req_engine",
        retryable: true,
        field_errors: [],
        documentation_key: "engine.run.unavailable",
      });
    }
    if (path.startsWith("/api/v1/runs/estimate?")) {
      return { status: 200, body: this.estimate };
    }
    if (path.startsWith("/api/v1/runs?") || path === "/api/v1/runs") {
      return { status: 200, body: this.runList };
    }
    if (path === `/api/v1/runs/${runId}`) {
      return {
        status: 200,
        body: this.run,
        requestId: "req_engine",
        traceId: "trc_engine",
      };
    }
    if (path.includes("/node-executions")) {
      return { status: 200, body: this.nodeExecutions };
    }
    if (path.includes("/verification-results")) {
      return { status: 200, body: this.verificationResults };
    }
    if (path.includes("/recovery-actions")) {
      return { status: 200, body: this.recoveryActions };
    }
    if (path.includes("/quality-gates")) {
      return { status: 200, body: this.qualityGates };
    }
    if (path.endsWith("/outcome")) {
      return { status: 200, body: this.outcome };
    }
    if (path === "/api/v1/artifacts" || path.startsWith("/api/v1/artifacts?")) {
      return { status: 200, body: this.artifactList };
    }
    if (
      path === `/api/v1/artifacts/${artifactId}` ||
      path === `/api/v1/artifacts/${artifactId}/download`
    ) {
      return { status: 200, body: this.artifact };
    }
    throw new Error(`Unexpected path ${path}`);
  }
}

function page(
  data: readonly EngineResource[],
): EnginePage<EngineResource> {
  return {
    data,
    page: { next_cursor: null, has_more: false, limit: 200 },
  };
}

function expectProblem(
  response: TestResponse,
  status: number,
  errorCode: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain(
    "application/problem+json",
  );
  expect(response.json()).toMatchObject({
    status,
    error_code: errorCode,
    field_errors: expect.any(Array),
  });
}
