import type { JsonValue } from "@alterx/shared-clients";
import type { CompiledDag } from "@alterx/contracts";
import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
  computeEtag,
} from "../concurrency";
import {
  EngineClient,
  EngineExceptionFilter,
  EngineProblemError,
  type EngineCallerContext,
  type EnginePath,
  type EngineRequestBody,
  type EngineResponse,
} from "../engine";
import {
  IdempotencyExceptionFilter,
  IdempotencyHttpError,
  IdempotencyInterceptor,
  PgIdempotencyStore,
  type IdempotencyExecution,
  type StoredHttpResponse,
} from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { WorkflowController } from "./workflow.controller";
import { WorkflowEtagResolver } from "./workflow-etag.resolver";
import { WorkflowExceptionFilter } from "./workflow-exception.filter";
import { WorkflowService } from "./workflow.service";
import { workflowDeferredCapabilities } from "./types";

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceId = "ws_018f47a5-7b2c-7d10-8f11-123456789abc";
const actor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: tenantId,
  workspace_id: workspaceId,
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["editor"],
  permissions: ["workflows:write"],
};
const viewer: ActorContextType = {
  ...actor,
  roles: ["viewer"],
  permissions: ["workflows:read"],
};

describe("WorkflowController routes", () => {
  let app: NestFastifyApplication;
  const engine = new StatefulEngine();
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [WorkflowController],
      providers: [
        WorkflowService,
        WorkflowEtagResolver,
        WorkflowExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        IfMatchGuard,
        EtagResponseInterceptor,
        ConcurrencyExceptionFilter,
        { provide: EngineClient, useValue: engine },
        {
          provide: ETAG_RESOURCE_RESOLVER,
          useExisting: WorkflowEtagResolver,
        },
        { provide: PgIdempotencyStore, useValue: store },
        {
          provide: APP_FILTER,
          useClass: EngineExceptionFilter,
        },
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
    store.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it("round-trips canvas DAG and metadata.ui through PATCH then GET", async () => {
    const first = await request("GET", `/api/v1/workflows/${workflowId}`, {
      actor,
    });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTypeOf("string");
    const updatedDag = workflowDag();
    updatedDag.nodes[0]!.metadata.ui = {
      position: { x: 900, y: 450 },
      width: 320,
      selected: true,
    };

    const saved = await request("PATCH", `/api/v1/workflows/${workflowId}`, {
      actor,
      headers: {
        "idempotency-key": "canvas-save",
        "if-match": String(etag),
      },
      payload: { dag: updatedDag },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers.etag).not.toBe(etag);

    const fetched = await request("GET", `/api/v1/workflows/${workflowId}`, {
      actor,
    });
    expect(fetched.json()).toMatchObject({
      dag: updatedDag,
    });
    expect((fetched.json() as { dag: unknown }).dag).toEqual(updatedDag);
    expect(engine.patch).toHaveBeenCalledOnce();
  });

  it("keeps direct controller calls default-deny without actor context", async () => {
    const controller = new WorkflowController(
      { get: vi.fn() } as unknown as WorkflowService,
    );

    await expect(
      controller.get(
        workflowId,
        undefined,
        undefined,
        {} as import("fastify").FastifyReply,
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("rejects stale canvas If-Match with 412 before Engine mutation", async () => {
    const response = await request(
      "PATCH",
      `/api/v1/workflows/${workflowId}`,
      {
        actor,
        headers: {
          "idempotency-key": "stale-save",
          "if-match": '"stale"',
        },
        payload: { dag: workflowDag() },
      },
    );

    expectProblem(response, 412, "ETAG_MISMATCH");
    expect(response.headers.etag).toBe(
      computeEtag(engine.draft, engine.revision),
    );
    expect(engine.patch).not.toHaveBeenCalled();
  });

  it("replays create and every lifecycle transition without double execution", async () => {
    const cases = [
      {
        path: "/api/v1/workflows",
        payload: { goal: "Process invoices" },
        status: 201,
      },
      ...["activate", "pause", "resume"].map((action) => ({
        path: `/api/v1/workflows/${workflowId}/actions/${action}`,
        payload: {},
        status: 200,
      })),
    ];

    for (const [index, testCase] of cases.entries()) {
      const key = `replay-${index}`;
      const first = await request("POST", testCase.path, {
        actor,
        headers: { "idempotency-key": key },
        payload: testCase.payload,
      });
      const replay = await request("POST", testCase.path, {
        actor,
        headers: { "idempotency-key": key },
        payload: testCase.payload,
      });
      expect(first.statusCode).toBe(testCase.status);
      expect(replay.statusCode).toBe(testCase.status);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
    }

    expect(engine.post).toHaveBeenCalledTimes(cases.length);
  });

  it.each([
    ["POST", "/api/v1/workflows", { goal: "Build workflow" }, 201],
    ["GET", `/api/v1/workflows/${workflowId}`, undefined, 200],
    ["GET", `/api/v1/workflows/${workflowId}/versions?limit=20`, undefined, 200],
    ["POST", `/api/v1/workflows/${workflowId}/actions/validate`, {}, 200],
    ["POST", `/api/v1/workflows/${workflowId}/actions/compile`, {}, 202],
    [
      "POST",
      `/api/v1/workflows/${workflowId}/actions/simulate`,
      { input: { invoice_id: "inv-1" } },
      200,
    ],
    ["POST", `/api/v1/workflows/${workflowId}/actions/activate`, {}, 200],
    ["POST", `/api/v1/workflows/${workflowId}/actions/pause`, {}, 200],
    ["POST", `/api/v1/workflows/${workflowId}/actions/resume`, {}, 200],
  ] as const)(
    "serves happy path %s %s",
    async (method, path, payload, expectedStatus) => {
      const response = await request(method, path, {
        actor,
        ...(method === "POST"
          ? { headers: { "idempotency-key": `happy-${path}` } }
          : {}),
        payload,
      });
      expect(response.statusCode).toBe(expectedStatus);
    },
  );

  it.each([
    ["POST", "/api/v1/workflows", { goal: "Build workflow" }],
    ["GET", `/api/v1/workflows/${workflowId}`, undefined],
    ["PATCH", `/api/v1/workflows/${workflowId}`, { dag: workflowDag() }],
    ["GET", `/api/v1/workflows/${workflowId}/versions`, undefined],
    ["POST", `/api/v1/workflows/${workflowId}/actions/validate`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/compile`, {}],
    [
      "POST",
      `/api/v1/workflows/${workflowId}/actions/simulate`,
      { input: {} },
    ],
    ["POST", `/api/v1/workflows/${workflowId}/actions/activate`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/pause`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/resume`, {}],
  ] as const)("denies unauthenticated %s %s", async (method, path, payload) => {
    const response = await request(method, path, {
      headers: {
        "idempotency-key": "denied",
        "if-match": computeEtag(engine.draft, engine.revision),
      },
      payload,
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("enforces read versus write workspace roles", async () => {
    expect(
      (
        await request("GET", `/api/v1/workflows/${workflowId}`, {
          actor: viewer,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("GET", `/api/v1/workflows/${workflowId}/versions`, {
          actor: viewer,
        })
      ).statusCode,
    ).toBe(200);

    for (const path of [
      "/api/v1/workflows",
      `/api/v1/workflows/${workflowId}/actions/validate`,
      `/api/v1/workflows/${workflowId}/actions/compile`,
      `/api/v1/workflows/${workflowId}/actions/simulate`,
      `/api/v1/workflows/${workflowId}/actions/activate`,
      `/api/v1/workflows/${workflowId}/actions/pause`,
      `/api/v1/workflows/${workflowId}/actions/resume`,
    ]) {
      const response = await request("POST", path, {
        actor: viewer,
        headers: { "idempotency-key": `viewer-${path}` },
        payload: validPayload(path),
      });
      expectProblem(response, 403, "RBAC_ROLE_DENIED");
    }
  });

  it.each([
    ["POST", "/api/v1/workflows", { goal: "" }],
    ["GET", "/api/v1/workflows/bad-id", undefined],
    ["PATCH", `/api/v1/workflows/${workflowId}`, { dag: { nodes: [] } }],
    ["GET", `/api/v1/workflows/${workflowId}/versions?limit=999`, undefined],
    ["POST", `/api/v1/workflows/${workflowId}/actions/validate`, { extra: true }],
    ["POST", `/api/v1/workflows/${workflowId}/actions/compile`, { extra: true }],
    ["POST", `/api/v1/workflows/${workflowId}/actions/simulate`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/activate`, { extra: true }],
    ["POST", `/api/v1/workflows/${workflowId}/actions/pause`, { extra: true }],
    ["POST", `/api/v1/workflows/${workflowId}/actions/resume`, { extra: true }],
  ] as const)("rejects invalid %s %s", async (method, path, payload) => {
    const response = await request(method, path, {
      actor,
      headers: {
        "idempotency-key": `invalid-${path}`,
        "if-match": computeEtag(engine.draft, engine.revision),
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });

  it.each([
    ["POST", "/api/v1/workflows", { goal: "Build workflow" }],
    ["GET", `/api/v1/workflows/${workflowId}`, undefined],
    ["PATCH", `/api/v1/workflows/${workflowId}`, { dag: workflowDag() }],
    ["GET", `/api/v1/workflows/${workflowId}/versions`, undefined],
    ["POST", `/api/v1/workflows/${workflowId}/actions/validate`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/compile`, {}],
    [
      "POST",
      `/api/v1/workflows/${workflowId}/actions/simulate`,
      { input: {} },
    ],
    ["POST", `/api/v1/workflows/${workflowId}/actions/activate`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/pause`, {}],
    ["POST", `/api/v1/workflows/${workflowId}/actions/resume`, {}],
  ] as const)(
    "passes through Engine problem for %s %s",
    async (method, path, payload) => {
      engine.failNext(method, path.split("?")[0]!);
      const response = await request(method, path, {
        actor,
        headers: {
          "idempotency-key": `engine-error-${path}`,
          "if-match": computeEtag(engine.draft, engine.revision),
        },
        payload,
      });
      expectProblem(response, 409, "ENGINE_WORKFLOW_CONFLICT");
      expect(response.json()).toMatchObject({
        detail: "Engine workflow state conflict",
        retryable: false,
      });
    },
  );

  it("relays deployment and template-variable routes to Engine", async () => {
    expect(workflowDeferredCapabilities).toEqual([]);
    const workflowVersionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";
    const actionCases = [
      // test-version first: a compiled version cannot be promoted or
      // canaried until it has been tested, and nothing exposed this route.
      ["test-version", { workflowVersionId }],
      ["promote-version", { workflowVersionId }],
      ["start-canary", { workflowVersionId, trafficPercent: 10 }],
      ["rollback", { workflowVersionId }],
    ] as const;

    for (const [action, payload] of actionCases) {
      const response = await request(
        "POST",
        `/api/v1/workflows/${workflowId}/actions/${action}`,
        {
          actor,
          headers: { "idempotency-key": `workflow-${action}` },
          payload,
        },
      );
      expect(response.statusCode).toBe(200);
    }

    const definitions = {
      definitions: [{ name: "region", value_type: "text", required: true }],
    };
    expect(
      (
        await request(
          "PUT",
          `/api/v1/workflows/${workflowId}/template-variables`,
          {
            actor,
            headers: { "idempotency-key": "template-definitions" },
            payload: definitions,
          },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          "PUT",
          `/api/v1/workflows/${workflowId}/template-variables/region/value`,
          {
            actor,
            headers: { "idempotency-key": "template-value" },
            payload: { value: "us-east-1" },
          },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("GET", `/api/v1/workflows/${workflowId}/template-variables`, {
          actor,
        })
      ).statusCode,
    ).toBe(200);

    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/promote-version`,
      { workflowVersionId },
      expect.any(Object),
      { idempotencyKey: "workflow-promote-version" },
    );
    expect(engine.put).toHaveBeenCalledTimes(2);
  });

  function request(
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    options: {
      actor?: ActorContextType;
      headers?: Record<string, string>;
      payload?: unknown;
    } = {},
  ): Promise<TestResponse> {
    const injectOptions: {
      method: "GET" | "POST" | "PATCH" | "PUT";
      url: string;
      headers: Record<string, string>;
      payload?: object;
    } = {
      method,
      url,
      headers: {
        ...(options.actor
          ? { "x-test-actor": JSON.stringify(options.actor) }
          : {}),
        ...options.headers,
      },
    };
    if (options.payload !== undefined) {
      injectOptions.payload = options.payload as object;
    }
    return app
      .getHttpAdapter()
      .getInstance()
      .inject(injectOptions) as Promise<TestResponse>;
  }
});

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}

class StatefulEngine {
  readonly get = vi.fn(this.getResponse.bind(this));
  readonly post = vi.fn(this.postResponse.bind(this));
  readonly patch = vi.fn(this.patchResponse.bind(this));
  readonly put = vi.fn(this.putResponse.bind(this));
  draft = initialDraft();
  private failure: { method: string; path: string } | undefined;

  reset(): void {
    this.draft = initialDraft();
    this.failure = undefined;
    this.get.mockClear();
    this.post.mockClear();
    this.patch.mockClear();
    this.put.mockClear();
  }

  get revision(): number {
    return Number(this.draft.revision);
  }

  failNext(method: string, path: string): void {
    this.failure = { method, path };
  }

  private async getResponse(
    path: EnginePath,
    _context: EngineCallerContext,
  ): Promise<EngineResponse<Readonly<Record<string, JsonValue>>>> {
    void _context;
    this.throwIfFailed("GET", path);
    if (path.includes("/versions")) {
      return {
        status: 200,
        body: {
          data: [],
          page: { next_cursor: null, has_more: false, limit: 50 },
        },
      };
    }
    return { status: 200, body: this.draft };
  }

  private async postResponse(
    path: EnginePath,
    _body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string },
  ): Promise<EngineResponse<Readonly<Record<string, JsonValue>>>> {
    void _body;
    void _context;
    void _options;
    this.throwIfFailed("POST", path);
    if (path === "/api/v1/workflows") {
      return {
        status: 201,
        body: this.draft,
        location: `/api/v1/workflows/${workflowId}`,
        requestId: "req_engine",
        traceId: "trc_engine",
      };
    }
    const action = path.split("/").at(-1) ?? "unknown";
    return {
      status: action === "compile" ? 202 : 200,
      body: { workflow_id: workflowId, action, status: "accepted" },
      ...(action === "compile"
        ? { location: `/api/v1/workflows/${workflowId}/versions/next` }
        : {}),
    };
  }

  private async patchResponse(
    path: EnginePath,
    body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string; ifMatch: string },
  ): Promise<EngineResponse<Readonly<Record<string, JsonValue>>>> {
    void _context;
    void _options;
    this.throwIfFailed("PATCH", path);
    const input = body as { readonly dag: JsonValue };
    this.draft = {
      ...this.draft,
      revision: Number(this.draft.revision) + 1,
      dag: input.dag,
    };
    return { status: 200, body: this.draft };
  }

  private async putResponse(
    path: EnginePath,
    body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string },
  ): Promise<EngineResponse<Readonly<Record<string, JsonValue>>>> {
    void body;
    void _context;
    void _options;
    this.throwIfFailed("PUT", path);
    return { status: 200, body: { workflow_id: workflowId, path } };
  }

  private throwIfFailed(method: string, path: string): void {
    if (this.failure?.method !== method || this.failure.path !== path) {
      return;
    }
    this.failure = undefined;
    throw new EngineProblemError({
      type: "https://errors.alter.ai/engine-workflow-conflict",
      title: "ENGINE_WORKFLOW_CONFLICT",
      status: 409,
      detail: "Engine workflow state conflict",
      instance: path,
      error_code: "ENGINE_WORKFLOW_CONFLICT",
      trace_id: "trc_engine",
      request_id: "req_engine",
      retryable: false,
      field_errors: [],
      documentation_key: "engine.workflow.conflict",
    });
  }
}

class MemoryIdempotencyStore {
  private readonly responses = new Map<
    string,
    StoredHttpResponse & { fingerprint: string }
  >();

  clear(): void {
    this.responses.clear();
  }

  async execute(
    input: IdempotencyExecution,
    operation: () => Promise<StoredHttpResponse>,
  ) {
    if (!input.key) {
      throw new IdempotencyHttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required",
        input.instance,
      );
    }
    const mapKey = `${input.tenantId}:${input.key}`;
    const stored = this.responses.get(mapKey);
    if (stored) {
      if (stored.fingerprint !== input.fingerprint) {
        throw new IdempotencyHttpError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key reused with different request",
          input.instance,
        );
      }
      return { status: stored.status, body: stored.body, replayed: true };
    }
    const result = await operation();
    this.responses.set(mapKey, { ...result, fingerprint: input.fingerprint });
    return { ...result, replayed: false };
  }
}

function initialDraft(): Readonly<Record<string, JsonValue>> {
  return {
    status: "draft",
    tenant_id: tenantId,
    workspace_id: workspaceId,
    workflow_id: workflowId,
    revision: 1,
    dag: workflowDag() as unknown as JsonValue,
  };
}

function workflowDag(): CompiledDag {
  return {
    schema_version: "1",
    entry_node_keys: ["start"],
    nodes: [
      {
        key: "start",
        type: "LLMTask",
        config: { prompt: "Process invoice" },
        metadata: {
          ui: { position: { x: 120, y: 240 }, collapsed: false },
        },
      },
    ],
    edges: [],
    waves: [
      {
        key: "wave-1",
        order: 0,
        node_keys: ["start"],
        depends_on: [],
      },
    ],
  };
}

function validPayload(path: string): unknown {
  if (path.endsWith("/simulate")) return { input: {} };
  if (path === "/api/v1/workflows") return { goal: "Build workflow" };
  return {};
}

function expectProblem(
  response: { statusCode: number; headers: Record<string, unknown>; json(): unknown },
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
