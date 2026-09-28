import type { JsonValue } from "@alterx/shared-clients";
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
import {
  RbacModule,
  type ActorContextType,
  type RbacRequest,
} from "../rbac";
import { ProjectController } from "./project.controller";
import { ProjectExceptionFilter } from "./project-exception.filter";
import { ProjectService } from "./project.service";

const projectId = "prj_018f47a5-7b2c-7d10-8f11-123456789abc";
const clarificationId = "clr_018f47a5-7b2c-7d10-8f11-123456789abc";
const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceId = "ws_018f47a5-7b2c-7d10-8f11-123456789abc";
// What the engine's project read routes answer with, which is the
// `projects` row, not the planning resource the create route returns.
const projectRecord = {
  id: projectId,
  tenantId,
  workspaceId,
  name: "Inventory control",
  status: "draft",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};
const editor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: tenantId,
  workspace_id: workspaceId,
  session_id: "session-editor",
  auth_time: 1_700_000_000,
  roles: ["editor"],
  permissions: ["projects:read", "projects:write"],
};
const viewer: ActorContextType = {
  ...editor,
  roles: ["viewer"],
  permissions: ["projects:read"],
};
const operator: ActorContextType = {
  ...editor,
  roles: ["operator"],
  permissions: ["projects:act"],
};
const approver: ActorContextType = {
  ...editor,
  roles: ["approver"],
  permissions: ["projects:approve"],
};

describe("ProjectController routes", () => {
  let app: NestFastifyApplication;
  const engine = new StatefulProjectEngine();
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [ProjectController],
      providers: [
        {
          provide: ProjectService,
          inject: [EngineClient],
          useFactory: (client: EngineClient) => new ProjectService(client),
        },
        ProjectExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        { provide: EngineClient, useValue: engine },
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

  it("lists the caller's projects, passing the page through as the engine sent it", async () => {
    const response = await request("GET", "/api/v1/projects", { actor: viewer });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [projectRecord],
      page: { next_cursor: null, has_more: false, limit: 50 },
    });
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/projects",
      expect.anything(),
    );
  });

  it("forwards cursor and limit to the engine", async () => {
    const response = await request(
      "GET",
      `/api/v1/projects?cursor=${projectId}&limit=25`,
      { actor: viewer },
    );

    expect(response.statusCode).toBe(200);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/projects?cursor=${projectId}&limit=25`,
      expect.anything(),
    );
  });

  it("forwards a trimmed name search to the engine (task B3.4)", async () => {
    const response = await request("GET", "/api/v1/projects?q=%20invoice%20&limit=5", { actor: viewer });
    expect(response.statusCode).toBe(200);
    expect(engine.get).toHaveBeenCalledWith("/api/v1/projects?limit=5&q=invoice", expect.anything());
  });

  it.each([
    ["cursor=not-a-project-id", "cursor"],
    ["limit=0", "limit"],
    ["limit=201", "limit"],
    ["q=%20%20", "q"],
    [`q=${"x".repeat(201)}`, "q"],
  ])("rejects ?%s before calling the engine", async (query, field) => {
    const response = await request("GET", `/api/v1/projects?${query}`, {
      actor: viewer,
    });

    expectProblem(response, 400, "PROJECT_VALIDATION_FAILED");
    expect(response.json()).toMatchObject({
      field_errors: [{ field }],
    });
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("reads one project by its own id", async () => {
    const response = await request("GET", `/api/v1/projects/${projectId}`, {
      actor: viewer,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(projectRecord);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}`,
      expect.anything(),
    );
  });

  it("rejects a project id that is not one, before calling the engine", async () => {
    const response = await request("GET", "/api/v1/projects/wf_not-a-project", {
      actor: viewer,
    });

    expectProblem(response, 400, "PROJECT_VALIDATION_FAILED");
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("submits brief and replays without duplicate Engine execution", async () => {
    const options = {
      actor: editor,
      headers: { "idempotency-key": "brief-key" },
      payload: { brief: "Build inventory control" },
    };
    const first = await request("POST", "/api/v1/projects", options);
    const replay = await request("POST", "/api/v1/projects", options);

    expect(first.statusCode).toBe(201);
    expect(first.headers.location).toBe(`/api/v1/projects/${projectId}`);
    expect(first.headers.request_id).toBe("req_engine");
    expect(first.headers.trace_id).toBe("trc_engine");
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());
    expect(engine.post).toHaveBeenCalledOnce();
  });

  it("round-trips pending clarification answer through Engine", async () => {
    const pending = await request(
      "GET",
      `/api/v1/projects/${projectId}/clarifications`,
      { actor: viewer },
    );
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({
      data: [
        {
          clarification_id: clarificationId,
          question: "Which database?",
          options: ["PostgreSQL", "MySQL"],
          required: true,
        },
      ],
    });

    const answered = await request(
      "POST",
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      {
        actor: editor,
        headers: { "idempotency-key": "answer-key" },
        payload: { answer: "PostgreSQL" },
      },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      project_id: projectId,
      action: "answer",
      status: "accepted",
      answer: "PostgreSQL",
    });

    const after = await request(
      "GET",
      `/api/v1/projects/${projectId}/clarifications`,
      { actor: viewer },
    );
    expect(after.json()).toEqual({ data: [] });
    expect(engine.post).toHaveBeenCalledOnce();
  });

  it("relays clarification answer byte-identically without trimming", async () => {
    const answer = " Use PostgreSQL\n";
    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      {
        actor: editor,
        headers: { "idempotency-key": "exact-answer-key" },
        payload: { answer },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      { answer },
      expect.any(Object),
      { idempotencyKey: "exact-answer-key" },
    );
    expect(response.json()).toMatchObject({ answer });
  });

  it.each([
    ["approve", {}, approver],
    ["reject", { reason: "Missing test strategy" }, approver],
    [
      "request-changes",
      { changes: "Add rollback and observability" },
      operator,
    ],
  ] as const)("relays plan review action %s", async (action, payload, actor) => {
    const plan = await request("GET", `/api/v1/projects/${projectId}/plan`, {
      actor: viewer,
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      project_id: projectId,
      version: 1,
      status: "pending_review",
    });

    const response = await request(
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/${action}`,
      {
        actor,
        headers: { "idempotency-key": `plan-${action}` },
        payload,
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      project_id: projectId,
      action,
      status: "accepted",
    });
  });

  it("starts build and replays without duplicate Engine execution", async () => {
    const path = `/api/v1/projects/${projectId}/builds`;
    const options = {
      actor: operator,
      headers: { "idempotency-key": "build-key" },
      payload: {},
    };
    const first = await request("POST", path, options);
    const replay = await request("POST", path, options);

    expect(first.statusCode).toBe(202);
    expect(first.headers.location).toBe(
      `/api/v1/projects/${projectId}/builds/bld_018f47a5-7b2c-7d10-8f11-123456789abc`,
    );
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(engine.post).toHaveBeenCalledOnce();
  });

  it("replays clarification and every plan action without double execution", async () => {
    const cases = [
      {
        path:
          `/api/v1/projects/${projectId}/clarifications/` +
          `${clarificationId}/answer`,
        payload: { answer: "PostgreSQL" },
      },
      {
        path: `/api/v1/projects/${projectId}/plan/actions/approve`,
        payload: {},
      },
      {
        path: `/api/v1/projects/${projectId}/plan/actions/reject`,
        payload: { reason: "Missing tests" },
      },
      {
        path:
          `/api/v1/projects/${projectId}/plan/actions/request-changes`,
        payload: { changes: "Add tests" },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const options = {
        actor: editor,
        headers: { "idempotency-key": `mutation-${index}` },
        payload: testCase.payload,
      };
      const first = await request("POST", testCase.path, options);
      const replay = await request("POST", testCase.path, options);
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");
    }

    expect(engine.post).toHaveBeenCalledTimes(cases.length);
  });

  it("keeps direct controller calls default-deny without actor", async () => {
    const controller = new ProjectController(
      { clarifications: vi.fn() } as unknown as ProjectService,
    );

    await expect(
      controller.clarifications(
        projectId,
        undefined,
        undefined,
        {} as import("fastify").FastifyReply,
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it.each(happyCases())(
    "serves happy path %s %s",
    async (method, path, payload, expectedStatus) => {
      const response = await request(method, path, {
        actor: editor,
        ...(method === "POST"
          ? { headers: { "idempotency-key": `happy-${path}` } }
          : {}),
        payload,
      });
      expect(response.statusCode).toBe(expectedStatus);
    },
  );

  it.each(routeCases())(
    "denies unauthenticated %s %s",
    async (method, path, payload) => {
      const response = await request(method, path, {
        headers: { "idempotency-key": `denied-${path}` },
        payload,
      });
      expectProblem(response, 403, "RBAC_ROLE_DENIED");
      expect(engine.get).not.toHaveBeenCalled();
      expect(engine.post).not.toHaveBeenCalled();
    },
  );

  it("enforces project read versus write and act roles", async () => {
    expect(
      (
        await request(
          "GET",
          `/api/v1/projects/${projectId}/clarifications`,
          { actor: viewer },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request("GET", `/api/v1/projects/${projectId}/plan`, {
          actor: viewer,
        })
      ).statusCode,
    ).toBe(200);

    for (const [path, payload] of [
      ["/api/v1/projects", { brief: "Build" }],
      [
        `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
        { answer: "PostgreSQL" },
      ],
      [`/api/v1/projects/${projectId}/plan/actions/approve`, {}],
      [`/api/v1/projects/${projectId}/builds`, {}],
    ] as const) {
      const response = await request("POST", path, {
        actor: viewer,
        headers: { "idempotency-key": `viewer-${path}` },
        payload,
      });
      expectProblem(response, 403, "RBAC_ROLE_DENIED");
    }

    const approverBuild = await request(
      "POST",
      `/api/v1/projects/${projectId}/builds`,
      {
        actor: approver,
        headers: { "idempotency-key": "approver-build" },
        payload: {},
      },
    );
    expectProblem(approverBuild, 403, "RBAC_ROLE_DENIED");
  });

  it.each(invalidCases())(
    "rejects invalid %s %s",
    async (method, path, payload) => {
      const response = await request(method, path, {
        actor: editor,
        headers: { "idempotency-key": `invalid-${path}` },
        payload,
      });
      expectProblem(response, 400, "PROJECT_VALIDATION_FAILED");
    },
  );

  it.each(engineErrorCases())(
    "passes through Engine problem for %s %s",
    async (method, path, payload, enginePath) => {
      engine.failNext(method, enginePath);
      const response = await request(method, path, {
        actor: editor,
        headers: { "idempotency-key": `engine-error-${path}` },
        payload,
      });
      expectProblem(response, 409, "ENGINE_PROJECT_CONFLICT");
      expect(response.json()).toMatchObject({
        detail: "Engine project state conflict",
        retryable: false,
      });
    },
  );

  it("rejects missing Idempotency-Key before Engine mutation", async () => {
    const response = await request("POST", "/api/v1/projects", {
      actor: editor,
      payload: { brief: "Build" },
    });
    expectProblem(response, 400, "IDEMPOTENCY_KEY_REQUIRED");
    expect(engine.post).not.toHaveBeenCalled();
  });

  function request(
    method: "GET" | "POST",
    url: string,
    options: {
      actor?: ActorContextType;
      headers?: Record<string, string>;
      payload?: unknown;
    } = {},
  ): Promise<TestResponse> {
    const injectOptions: {
      method: "GET" | "POST";
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

class StatefulProjectEngine {
  readonly get = vi.fn(this.getResponse.bind(this));
  readonly post = vi.fn(this.postResponse.bind(this));
  private pending = true;
  private failure: { method: string; path: string } | undefined;

  reset(): void {
    this.pending = true;
    this.failure = undefined;
    this.get.mockClear();
    this.post.mockClear();
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
    if (path.endsWith("/clarifications?status=pending")) {
      return {
        status: 200,
        body: {
          data: this.pending
            ? [
                {
                  clarification_id: clarificationId,
                  question: "Which database?",
                  options: ["PostgreSQL", "MySQL"],
                  required: true,
                },
              ]
            : [],
        },
      };
    }
    if (path === "/api/v1/projects" || path.startsWith("/api/v1/projects?")) {
      return {
        status: 200,
        body: {
          data: [projectRecord],
          page: { next_cursor: null, has_more: false, limit: 50 },
        },
      };
    }
    if (path === `/api/v1/projects/${projectId}`) {
      return { status: 200, body: projectRecord };
    }
    return {
      status: 200,
      body: {
        project_id: projectId,
        version: 1,
        status: "pending_review",
        steps: [{ key: "build" }],
      },
    };
  }

  private async postResponse(
    path: EnginePath,
    body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string },
  ): Promise<EngineResponse<Readonly<Record<string, JsonValue>>>> {
    void _context;
    void _options;
    this.throwIfFailed("POST", path);
    if (path === "/api/v1/projects") {
      return {
        status: 201,
        body: {
          project_id: projectId,
          workspace_id: workspaceId,
          status: "clarifying",
          brief: (body as { brief: string }).brief,
        },
        location: `/api/v1/projects/${projectId}`,
        requestId: "req_engine",
        traceId: "trc_engine",
      };
    }
    if (path.endsWith(`/clarifications/${clarificationId}/answer`)) {
      this.pending = false;
      return {
        status: 200,
        body: {
          project_id: projectId,
          action: "answer",
          status: "accepted",
          answer: (body as { answer: string }).answer,
        },
      };
    }
    if (path.endsWith("/builds")) {
      return {
        status: 202,
        body: {
          project_id: projectId,
          build_id: "bld_018f47a5-7b2c-7d10-8f11-123456789abc",
          status: "queued",
        },
        location:
          `/api/v1/projects/${projectId}/builds/` +
          "bld_018f47a5-7b2c-7d10-8f11-123456789abc",
      };
    }
    const action = path.split("/").at(-1) ?? "unknown";
    return {
      status: 200,
      body: {
        project_id: projectId,
        action,
        status: "accepted",
      },
    };
  }

  private throwIfFailed(method: string, path: string): void {
    if (this.failure?.method !== method || this.failure.path !== path) {
      return;
    }
    this.failure = undefined;
    throw new EngineProblemError({
      type: "https://errors.alter.ai/engine-project-conflict",
      title: "ENGINE_PROJECT_CONFLICT",
      status: 409,
      detail: "Engine project state conflict",
      instance: path,
      error_code: "ENGINE_PROJECT_CONFLICT",
      trace_id: "trc_engine",
      request_id: "req_engine",
      retryable: false,
      field_errors: [],
      documentation_key: "engine.project.conflict",
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

function happyCases() {
  return [
    ["POST", "/api/v1/projects", { brief: "Build project" }, 201],
    [
      "GET",
      `/api/v1/projects/${projectId}/clarifications`,
      undefined,
      200,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      { answer: "PostgreSQL" },
      200,
    ],
    ["GET", `/api/v1/projects/${projectId}/plan`, undefined, 200],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/approve`,
      {},
      200,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/reject`,
      { reason: "Missing tests" },
      200,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/request-changes`,
      { changes: "Add tests" },
      200,
    ],
    ["POST", `/api/v1/projects/${projectId}/builds`, {}, 202],
  ] as const;
}

function routeCases() {
  return happyCases().map(([method, path, payload]) => [
    method,
    path,
    payload,
  ] as const);
}

function invalidCases() {
  return [
    ["POST", "/api/v1/projects", { brief: "" }],
    ["GET", "/api/v1/projects/bad/clarifications", undefined],
    [
      "POST",
      `/api/v1/projects/${projectId}/clarifications/bad/answer`,
      { answer: "PostgreSQL" },
    ],
    ["GET", "/api/v1/projects/bad/plan", undefined],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/approve`,
      { extra: true },
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/reject`,
      { reason: "" },
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/request-changes`,
      {},
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/builds`,
      { unexpected: true },
    ],
  ] as const;
}

function engineErrorCases() {
  return [
    ["POST", "/api/v1/projects", { brief: "Build" }, "/api/v1/projects"],
    [
      "GET",
      `/api/v1/projects/${projectId}/clarifications`,
      undefined,
      `/api/v1/projects/${projectId}/clarifications?status=pending`,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
      { answer: "PostgreSQL" },
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`,
    ],
    [
      "GET",
      `/api/v1/projects/${projectId}/plan`,
      undefined,
      `/api/v1/projects/${projectId}/plan`,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/approve`,
      {},
      `/api/v1/projects/${projectId}/plan/actions/approve`,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/reject`,
      { reason: "No" },
      `/api/v1/projects/${projectId}/plan/actions/reject`,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/plan/actions/request-changes`,
      { changes: "More tests" },
      `/api/v1/projects/${projectId}/plan/actions/request-changes`,
    ],
    [
      "POST",
      `/api/v1/projects/${projectId}/builds`,
      {},
      `/api/v1/projects/${projectId}/builds`,
    ],
  ] as const;
}

function expectProblem(
  response: {
    statusCode: number;
    headers: Record<string, unknown>;
    json(): unknown;
  },
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
