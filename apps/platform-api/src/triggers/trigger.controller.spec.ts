import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
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
import { TriggerController } from "./trigger.controller";
import { TriggerEtagResolver } from "./trigger-etag.resolver";
import { TriggerExceptionFilter } from "./trigger-exception.filter";
import { TriggerModule } from "./trigger.module";
import { TriggerService } from "./trigger.service";
import { triggerDeferredCapabilities } from "./types";

const triggerId = "trg_018f47a5-7b2c-7d10-8f11-123456789abc";
const triggerVersionId = "trv_018f47a5-7b2c-7d10-8f11-123456789abc";
const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
const workflowVersionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceId = "ws_018f47a5-7b2c-7d10-8f11-123456789abc";
const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";

const admin: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: tenantId,
  workspace_id: workspaceId,
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["admin"],
  permissions: ["workflows:read", "workflows:write", "workflows:deploy"],
};
const writer: ActorContextType = {
  ...admin,
  roles: ["editor"],
  permissions: ["workflows:read", "workflows:write"],
};
const viewer: ActorContextType = {
  ...admin,
  roles: ["viewer"],
  permissions: ["workflows:read"],
};

describe("TriggerController routes", () => {
  let app: NestFastifyApplication;
  const engine = new TriggerEngine();
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [TriggerController],
      providers: [
        {
          provide: TriggerService,
          useFactory: () => new TriggerService(engine as unknown as EngineClient),
        },
        TriggerEtagResolver,
        TriggerExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        IfMatchGuard,
        EtagResponseInterceptor,
        ConcurrencyExceptionFilter,
        { provide: EngineClient, useValue: engine },
        {
          provide: ETAG_RESOURCE_RESOLVER,
          useExisting: TriggerEtagResolver,
        },
        { provide: PgIdempotencyStore, useValue: store },
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
    store.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates, lists, gets, versions, and status-patches camelCase triggers", async () => {
    const created = await request("POST", "/api/v1/triggers", writer, {
      key: "create-trigger",
      body: createBody(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      trigger: engine.trigger,
      triggerVersion: engine.version,
    });

    const listed = await request(
      "GET",
      `/api/v1/triggers?workflowId=${workflowId}`,
      viewer,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ triggers: [engine.trigger] });
    expect(engine.get).toHaveBeenLastCalledWith(
      `/api/v1/triggers?workflowId=${workflowId}`,
      expect.objectContaining({
        tenantId,
        workspaceId,
        permissions: viewer.permissions,
      }),
    );

    const fetched = await request(
      "GET",
      `/api/v1/triggers/${triggerId}`,
      viewer,
    );
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers.etag).toBeTypeOf("string");

    const versioned = await request(
      "POST",
      `/api/v1/triggers/${triggerId}/versions`,
      writer,
      {
        key: "version-trigger",
        body: {
          workflowVersionId,
          config: { cronExpression: "0 * * * *" },
        },
      },
    );
    expect(versioned.statusCode).toBe(200);
    expect(versioned.json()).toEqual(engine.version);

    const enabled = await request(
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      admin,
      {
        key: "enable-trigger",
        ifMatch: String(fetched.headers.etag),
        body: { status: "enabled" },
      },
    );
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ status: "enabled" });
    expect(enabled.json()).not.toHaveProperty("workflow_id");
    expect(engine.patch).toHaveBeenCalledWith(
      `/api/v1/triggers/${triggerId}/status`,
      { status: "enabled" },
      expect.objectContaining({ permissions: admin.permissions }),
      expect.objectContaining({
        idempotencyKey: "enable-trigger",
        ifMatch: fetched.headers.etag,
      }),
    );

    const disabled = await request(
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      admin,
      {
        key: "disable-trigger",
        ifMatch: String(enabled.headers.etag),
        body: { status: "disabled" },
      },
    );
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ status: "disabled" });
  });

  it("replays create and rejects same key with changed payload", async () => {
    const first = await request("POST", "/api/v1/triggers", writer, {
      key: "same-key",
      body: createBody(),
    });
    const replay = await request("POST", "/api/v1/triggers", writer, {
      key: "same-key",
      body: createBody(),
    });
    const conflict = await request("POST", "/api/v1/triggers", writer, {
      key: "same-key",
      body: { ...createBody(), name: "Changed" },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expectProblem(conflict, 422, "IDEMPOTENCY_KEY_REUSED");
    expect(engine.post).toHaveBeenCalledOnce();
  });

  it("rejects stale status If-Match before Engine mutation", async () => {
    const response = await request(
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      admin,
      {
        key: "stale-status",
        ifMatch: '"stale"',
        body: { status: "enabled" },
      },
    );
    expectProblem(response, 412, "ETAG_MISMATCH");
    expect(engine.patch).not.toHaveBeenCalled();
  });

  it("scope-gates reads, writes, and production status changes", async () => {
    expect(
      (await request("GET", "/api/v1/triggers", viewer)).statusCode,
    ).toBe(200);

    const createDenied = await request("POST", "/api/v1/triggers", viewer, {
      key: "viewer-create",
      body: createBody(),
    });
    expectProblem(createDenied, 403, "RBAC_ROLE_DENIED");

    const statusDenied = await request(
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      writer,
      {
        key: "writer-enable",
        ifMatch: '"anything"',
        body: { status: "enabled" },
      },
    );
    expectProblem(statusDenied, 403, "RBAC_ROLE_DENIED");

    const missingPermission = await request(
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      { ...admin, permissions: ["workflows:write"] },
      {
        key: "admin-no-scope",
        ifMatch: '"anything"',
        body: { status: "enabled" },
      },
    );
    expectProblem(missingPermission, 403, "RBAC_PERMISSION_DENIED");
  });

  it("validates inputs and passes Engine problems through unchanged", async () => {
    const invalid = await request("POST", "/api/v1/triggers", writer, {
      key: "invalid",
      body: { ...createBody(), type: "email" },
    });
    expectProblem(invalid, 400, "INVALID_TRIGGER_REQUEST");

    engine.failNext("GET", `/api/v1/triggers/${triggerId}`);
    const failed = await request(
      "GET",
      `/api/v1/triggers/${triggerId}`,
      viewer,
    );
    expectProblem(failed, 409, "ENGINE_TRIGGER_CONFLICT");
    expect(failed.json()).toMatchObject({
      detail: "Engine trigger state conflict",
      retryable: false,
    });
  });

  it.each([
    ["POST", "/api/v1/triggers", createBody()],
    ["GET", "/api/v1/triggers", undefined],
    ["GET", `/api/v1/triggers/${triggerId}`, undefined],
    [
      "POST",
      `/api/v1/triggers/${triggerId}/versions`,
      { workflowVersionId, config: {} },
    ],
    [
      "PATCH",
      `/api/v1/triggers/${triggerId}/status`,
      { status: "enabled" },
    ],
  ] as const)("RBAC-denies %s %s without actor", async (method, path, body) => {
    const response = await request(method, path, undefined, {
      key: `denied-${path}`,
      ifMatch: '"etag"',
      body,
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("rejects validation failures on every trigger route", async () => {
    const current = await request(
      "GET",
      `/api/v1/triggers/${triggerId}`,
      viewer,
    );
    const cases = [
      ["POST", "/api/v1/triggers", { ...createBody(), workspaceId: "bad" }],
      ["GET", "/api/v1/triggers?workflowId=bad", undefined],
      ["GET", "/api/v1/triggers/bad", undefined],
      ["POST", "/api/v1/triggers/bad/versions", {}],
      [
        "PATCH",
        `/api/v1/triggers/${triggerId}/status`,
        { status: "paused" },
      ],
    ] as const;

    for (const [method, path, body] of cases) {
      const response = await request(method, path, admin, {
        key: `invalid-${path}`,
        ifMatch: String(current.headers.etag),
        body,
      });
      expectProblem(response, 400, "INVALID_TRIGGER_REQUEST");
    }
  });

  it("passes Engine errors through for every trigger route", async () => {
    const current = await request(
      "GET",
      `/api/v1/triggers/${triggerId}`,
      viewer,
    );
    const cases = [
      ["POST", "/api/v1/triggers", createBody()],
      ["GET", "/api/v1/triggers", undefined],
      ["GET", `/api/v1/triggers/${triggerId}`, undefined],
      [
        "POST",
        `/api/v1/triggers/${triggerId}/versions`,
        { workflowVersionId, config: {} },
      ],
      [
        "PATCH",
        `/api/v1/triggers/${triggerId}/status`,
        { status: "enabled" },
      ],
    ] as const;

    for (const [method, path, body] of cases) {
      engine.failNext(method, path);
      const response = await request(method, path, admin, {
        key: `engine-error-${path}`,
        ifMatch: String(current.headers.etag),
        body,
      });
      expectProblem(response, 409, "ENGINE_TRIGGER_CONFLICT");
    }
  });

  it("runs real trigger actions and requires idempotency", async () => {
    const missingKey = await request("POST", "/api/v1/triggers", writer, {
      body: createBody(),
    });
    expectProblem(missingKey, 400, "IDEMPOTENCY_KEY_REQUIRED");
    expect(triggerDeferredCapabilities).toEqual([]);

    const enabled = await request(
      "POST",
      `/api/v1/triggers/${triggerId}/actions/enable`,
      admin,
      { key: "action-enable", body: {} },
    );
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ status: "enabled" });

    const tested = await request(
      "POST",
      `/api/v1/triggers/${triggerId}/actions/test`,
      writer,
      { key: "action-test", body: {} },
    );
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toEqual({
      eventId: "evt_test",
      triggerId,
      triggerVersion: 1,
    });

    const rotated = await request(
      "POST",
      `/api/v1/triggers/${triggerId}/actions/rotate-webhook-secret`,
      admin,
      { key: "action-rotate", body: {} },
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      triggerId,
      secret: "new-webhook-secret",
      secretVersion: 1,
    });
    expect(TriggerModule).toBeDefined();
  });

  it("default-denies direct calls and requires workspace context", async () => {
    const controller = new TriggerController({
      list: vi.fn(),
    } as unknown as TriggerService);
    await expect(
      controller.list(
        undefined,
        undefined,
        undefined,
        {} as FastifyReply,
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });

    const { workspace_id: _workspace, ...withoutWorkspace } = viewer;
    void _workspace;
    const response = await request(
      "GET",
      "/api/v1/triggers",
      withoutWorkspace,
    );
    expectProblem(response, 403, "TRIGGER_WORKSPACE_REQUIRED");
  });

  it("propagates trace and Engine response metadata", async () => {
    const traceparent =
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const { auth_time: _authTime, ...withoutAuthTime } = writer;
    void _authTime;
    const response = await request(
      "POST",
      "/api/v1/triggers",
      withoutAuthTime,
      {
        key: "metadata",
        traceparent,
        body: createBody(),
      },
    );
    expect(response.headers.location).toBe(`/api/v1/triggers/${triggerId}`);
    expect(response.headers.request_id).toBe("req_engine");
    expect(response.headers.trace_id).toBe("trc_engine");

    expect(engine.post).toHaveBeenLastCalledWith(
      "/api/v1/triggers",
      expect.any(Object),
      expect.objectContaining({
        authTime: expect.any(Number),
        traceparent,
      }),
      expect.any(Object),
    );
  });

  it("serves hosted definition through the real HTTP controller and preserves caller context", async () => {
    const result = await request("GET", `/api/v1/triggers/${triggerId}/public-form`, viewer, { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ triggerVersionId, definition: { title: "Inquiry" } });
    expect(engine.get).toHaveBeenCalledWith(`/api/v1/triggers/${triggerId}/public-form`, expect.objectContaining({ userId: viewer.user_id, tenantId: viewer.tenant_id, workspaceId: viewer.workspace_id }));
    expectProblem(await request("GET", `/api/v1/triggers/${triggerId}/public-form`), 403, "RBAC_ROLE_DENIED");
    expectProblem(await request("GET", "/api/v1/triggers/bad/public-form", viewer), 400, "INVALID_TRIGGER_REQUEST");
  });

  it("protects hosted status route roles and requires the displayed form precondition", async () => {
    const path = `/api/v1/triggers/${triggerId}/public-form/status`, etag = '"public-form-current-draft"';
    expectProblem(await request("PATCH", path, admin, { key: "form-no-etag", body: { status: "enabled" } }), 428, "PRECONDITION_REQUIRED");
    expectProblem(await request("PATCH", path, { ...viewer, permissions: ["workflows:deploy"] }, { key: "form-viewer", ifMatch: etag, body: { status: "enabled" } }), 403, "RBAC_ROLE_DENIED");
    expectProblem(await request("PATCH", path, admin, { key: "form-invalid", ifMatch: etag, body: { status: "paused" } }), 400, "INVALID_TRIGGER_REQUEST");
    const result = await request("PATCH", path, admin, { key: "form-enable", ifMatch: etag, body: { status: "enabled" } });
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ status: "enabled" });
    expect(engine.patch).toHaveBeenCalledWith(path, { status: "enabled" }, expect.objectContaining({ userId: admin.user_id, workspaceId: admin.workspace_id }), { idempotencyKey: "form-enable", ifMatch: etag });
  });

  function request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    actor?: ActorContextType,
    options: {
      key?: string;
      ifMatch?: string;
      traceparent?: string;
      body?: unknown;
    } = {},
  ): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: {
        ...(actor ? { "x-test-actor": JSON.stringify(actor) } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
        ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
        ...(options.traceparent ? { traceparent: options.traceparent } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body }),
    } as never) as Promise<TestResponse>;
  }
});

class TriggerEngine {
  trigger = {
    id: triggerId,
    tenantId,
    workspaceId,
    workflowId,
    name: "Invoice webhook",
    type: "webhook" as const,
    status: "draft" as "draft" | "enabled" | "disabled" | "archived",
    provider: "whatsapp",
  };
  readonly version = {
    id: triggerVersionId,
    tenantId,
    triggerId,
    version: 1,
    workflowVersionId,
    config: { dlqPolicy: {} },
    status: "active" as const,
    nextFireAt: null,
  };
  readonly get = vi.fn(this.getResponse.bind(this));
  readonly post = vi.fn(this.postResponse.bind(this));
  readonly patch = vi.fn(this.patchResponse.bind(this));
  private failure: { method: string; path: string } | undefined;

  reset(): void {
    this.trigger.status = "draft";
    this.failure = undefined;
    this.get.mockClear();
    this.post.mockClear();
    this.patch.mockClear();
  }

  failNext(method: string, path: string): void {
    this.failure = { method, path };
  }

  private async getResponse(
    path: EnginePath,
    context: EngineCallerContext,
  ): Promise<EngineResponse<unknown>> {
    void context;
    this.throwIfFailed("GET", path);
    if (path.endsWith("/public-form")) return { status: 200, body: { definition: { title: "Inquiry", fields: [{ name: "email", label: "Email", type: "email", required: true }] },
      workflowVersionId, triggerVersionId, version: 1, publicUrl: "https://forms.test/f/capability", status: this.trigger.status, etag: '"public-form-current-draft"' } };
    return path.startsWith("/api/v1/triggers?")
      ? { status: 200, body: { triggers: [this.trigger] } }
      : path === "/api/v1/triggers"
        ? { status: 200, body: { triggers: [this.trigger] } }
        : { status: 200, body: { ...this.trigger } };
  }

  private async postResponse(
    path: EnginePath,
    body: EngineRequestBody,
    context: EngineCallerContext,
    options: { idempotencyKey: string },
  ): Promise<EngineResponse<unknown>> {
    void body;
    void context;
    void options;
    this.throwIfFailed("POST", path);
    if (path.endsWith("/actions/enable")) {
      this.trigger.status = "enabled";
      return { status: 200, body: { ...this.trigger } };
    }
    if (path.endsWith("/actions/test")) {
      return {
        status: 200,
        body: { eventId: "evt_test", triggerId, triggerVersion: 1 },
      };
    }
    if (path.endsWith("/actions/rotate-webhook-secret")) {
      return {
        status: 200,
        body: { triggerId, secret: "new-webhook-secret", secretVersion: 1 },
      };
    }
    return path.endsWith("/versions")
      ? { status: 200, body: this.version }
      : {
          status: 201,
          body: { trigger: this.trigger, triggerVersion: this.version },
          location: `/api/v1/triggers/${triggerId}`,
          requestId: "req_engine",
          traceId: "trc_engine",
        };
  }

  private async patchResponse(
    path: EnginePath,
    body: EngineRequestBody,
    context: EngineCallerContext,
    options: { idempotencyKey: string; ifMatch: string },
  ): Promise<EngineResponse<unknown>> {
    void context;
    void options;
    this.throwIfFailed("PATCH", path);
    this.trigger.status = (
      body as { status: "draft" | "enabled" | "disabled" | "archived" }
    ).status;
    return { status: 200, body: { ...this.trigger } };
  }

  private throwIfFailed(method: string, path: string): void {
    if (this.failure?.method !== method || this.failure.path !== path) return;
    this.failure = undefined;
    throw new EngineProblemError({
      type: "https://errors.alter.ai/engine-trigger-conflict",
      title: "ENGINE_TRIGGER_CONFLICT",
      status: 409,
      detail: "Engine trigger state conflict",
      instance: path,
      error_code: "ENGINE_TRIGGER_CONFLICT",
      trace_id: "trc_engine",
      request_id: "req_engine",
      retryable: false,
      field_errors: [],
      documentation_key: "engine.trigger.conflict",
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

function createBody() {
  return {
    workspaceId,
    workflowId,
    name: "Invoice webhook",
    type: "webhook",
    provider: "whatsapp",
    workflowVersionId,
    config: { dlqPolicy: {} },
  };
}

function expectProblem(
  response: TestResponse,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain(
    "application/problem+json",
  );
  expect(response.json()).toMatchObject({ status, error_code: code });
}

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}
