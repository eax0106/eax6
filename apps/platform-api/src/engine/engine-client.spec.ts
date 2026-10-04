import type { ProblemDetails } from "@alterx/contracts";
import { Logger, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { EngineAuthProvider } from "./auth";
import type { EngineConfig } from "./config";
import { EngineClient } from "./engine-client";
import { EngineExceptionFilter } from "./engine-exception.filter";
import { EngineProblemError } from "./problem";
import type { EngineCallerContext, EnginePath } from "./types";

const config: EngineConfig = {
  baseUrl: "https://engine.test",
  adsCoreBaseUrl: "https://ads.test",
  costLedgerBaseUrl: "https://costs.test",
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
  roles: ["owner"],
  permissions: ["workflows:read"],
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};

const authProvider: EngineAuthProvider = {
  authorize: vi.fn().mockResolvedValue({
    m2mAccessToken: "m2m-token",
    actorToken: "actor-token",
  }),
};

describe("EngineClient", () => {
  it("injects M2M, actor, and trace context into GET requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "workflow-1" }, {
        etag: '"etag-1"',
        request_id: "req-1",
        trace_id: "trc-1",
      }),
    );
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);

    const response = await client.get<{ id: string }>(
      "/api/v1/workflows/workflow-1",
      context,
    );

    expect(response).toEqual({
      status: 200,
      body: { id: "workflow-1" },
      etag: '"etag-1"',
      requestId: "req-1",
      traceId: "trc-1",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://engine.test/api/v1/workflows/workflow-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer m2m-token",
          "X-Alter-Actor-Token": "actor-token",
          traceparent: context.traceparent,
        }),
      }),
    );
    expect(authProvider.authorize).toHaveBeenCalledWith(context);
  });

  it("sends knowledge calls to ads-core's own routes with the tenant and workspace it scopes by", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { data: [] }));
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);

    await client.get("/api/v1/ads/documents?limit=200&source_id=src_1", context);
    await client.patch("/api/v1/ads/sources/src_1/permissions", { mode: "workspace" }, context, {
      idempotencyKey: "idem-1",
      ifMatch: '"etag"',
    });
    await client.get("/api/v1/deletion-requests", context);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ads.test/ads/documents?limit=200&source_id=src_1",
      "https://ads.test/ads/sources/src_1/permissions",
      "https://engine.test/api/v1/deletion-requests",
    ]);
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({
      Authorization: "Bearer m2m-token",
      "X-Alter-Tenant-Id": context.tenantId,
      "X-Alter-Workspace-Id": context.workspaceId,
      "X-Alter-Requester": context.userId,
    });
    expect(fetchImpl.mock.calls[2]![1].headers).not.toHaveProperty("X-Alter-Tenant-Id");
  });

  it("preserves a caller's If-Match on a version-creation POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { version: 2 }));
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);
    await client.post("/api/v1/triggers/trg_1/versions", { config: {} }, context, { idempotencyKey: "version-1", ifMatch: '"form-v1"' });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "If-Match": '"form-v1"', "Idempotency-Key": "version-1" } });
  });
  it("forwards mutation concurrency and idempotency headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { id: "workflow-1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { version: 2 }, { etag: '"new"', location: "/api/v1/runs/1" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { updated: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);

    await client.post(
      "/api/v1/workflows",
      { goal: "ship" },
      context,
      { idempotencyKey: "create-1" },
    );
    const patched = await client.patch(
      "/api/v1/workflows/workflow-1",
      { name: "New" },
      context,
      { idempotencyKey: "patch-1", ifMatch: '"old"' },
    );
    await client.put(
      "/api/v1/workflows/workflow-1/template-variables",
      { definitions: [] },
      context,
      { idempotencyKey: "put-1" },
    );
    const deleted = await client.delete(
      "/api/v1/ads/documents/document-1",
      context,
      { idempotencyKey: "delete-1", ifMatch: '"delete-etag"' },
    );

    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: '{"goal":"ship"}',
        headers: expect.objectContaining({
          "Idempotency-Key": "create-1",
          "content-type": "application/json",
        }),
      }),
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "Idempotency-Key": "patch-1",
          "If-Match": '"old"',
        }),
      }),
    );
    expect(patched).toMatchObject({
      etag: '"new"',
      location: "/api/v1/runs/1",
    });
    expect(fetchImpl.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: '{"definitions":[]}',
        headers: expect.objectContaining({ "Idempotency-Key": "put-1" }),
      }),
    );
    expect(fetchImpl.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "If-Match": '"delete-etag"' }) }));
    expect(deleted).toEqual({ status: 204, body: undefined });
  });

  it("presents the internal service token, not the M2M token, to ads-core when configured", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, { data: [] }));
    const resolveSecret = vi.fn().mockResolvedValue("internal-token");
    const client = new EngineClient(
      { ...config, adsCoreServiceTokenRef: "env:INTERNAL_SERVICE_TOKEN" },
      authProvider,
      fetchImpl,
      noDelay,
      resolveSecret,
    );

    await client.get("/api/v1/ads/sources", context);
    await client.queryAds({ query: "refund", top_k: 5 }, context);
    await client.get("/api/v1/deletion-requests", context);

    expect(resolveSecret).toHaveBeenCalledWith("env:INTERNAL_SERVICE_TOKEN");
    expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe("Bearer internal-token");
    expect(fetchImpl.mock.calls[1]![1].headers.Authorization).toBe("Bearer internal-token");
    expect(fetchImpl.mock.calls[1]![1].headers["X-Alter-Actor-Token"]).toBe("actor-token");
    expect(fetchImpl.mock.calls[2]![1].headers.Authorization).toBe("Bearer m2m-token");
  });

  it("posts ADS queries to ads-core with trusted caller identity and no retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { hits: [], audited_at: null }),
    );
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);

    await expect(
      client.queryAds(
        { query: "refund", top_k: 5, tenant_id: "ten_untrusted" },
        context,
      ),
    ).resolves.toEqual({
      status: 200,
      body: { hits: [], audited_at: null },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ads.test/ads/query",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer m2m-token",
          "X-Alter-Actor-Token": "actor-token",
          "X-Alter-Tenant-Id": context.tenantId,
          "X-Alter-Workspace-Id": context.workspaceId,
          "X-Alter-Requester": context.userId,
        }),
        body: JSON.stringify({
          query: "refund",
          top_k: 5,
          tenant_id: context.tenantId,
          workspace_id: context.workspaceId,
          requester: context.userId,
        }),
      }),
    );

    const failureFetch = vi.fn().mockResolvedValue(
      jsonResponse(429, { detail: "internal queue depth 99" }),
    );
    await expect(
      new EngineClient(config, authProvider, failureFetch, noDelay).queryAds(
        { query: "refund" },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        status: 429,
        error_code: "UPSTREAM_SERVICE_ERROR",
        detail: "Upstream service request failed.",
      },
    });
    expect(failureFetch).toHaveBeenCalledOnce();
  });

  it("logs why authorization failed while still returning the opaque 502", async () => {
    // The caller must not learn why -- but an operator has to. Authorizing mints
    // both tokens locally, so this 502 is routinely not the upstream's fault at
    // all, and the cause used to be dropped on the floor: UPSTREAM_SERVICE_ERROR
    // was the only evidence that anything had happened.
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn();

    await expect(
      new EngineClient(
        config,
        { authorize: vi.fn().mockRejectedValue(new Error("signing key unavailable")) },
        fetchImpl,
        noDelay,
      ).get("/api/v1/workflows" as EnginePath, context),
    ).rejects.toMatchObject({
      problem: { status: 502, error_code: "UPSTREAM_SERVICE_ERROR" },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/workflows"),
      expect.stringContaining("signing key unavailable"),
    );
    logged.mockRestore();
  });

  it("maps ADS query auth, network, and timeout failures without leaking detail", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new EngineClient(
        config,
        { authorize: vi.fn().mockRejectedValue(new Error("secret")) },
        fetchImpl,
        noDelay,
      ).queryAds({ query: "refund" }, context),
    ).rejects.toMatchObject({ problem: { status: 502 } });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      new EngineClient(
        config,
        authProvider,
        vi.fn().mockRejectedValue(new Error("socket secret")),
        noDelay,
      ).queryAds({ query: "refund" }, context),
    ).rejects.toMatchObject({
      problem: { status: 502, detail: "Upstream service request failed." },
    });

    const abort = new Error("timeout");
    abort.name = "AbortError";
    await expect(
      new EngineClient(
        config,
        authProvider,
        vi.fn().mockRejectedValue(abort),
        noDelay,
      ).queryAds({ query: "refund" }, context),
    ).rejects.toMatchObject({ problem: { status: 504 } });
  });

  it("passes through valid Engine problem details", async () => {
    const problem = validProblem(409);
    const client = new EngineClient(
      config,
      authProvider,
      vi.fn().mockResolvedValue(problemResponse(problem)),
      noDelay,
    );

    await expect(
      client.post("/api/v1/workflows", {}, context, {
        idempotencyKey: "key",
      }),
    ).rejects.toMatchObject({
      problem,
      status: 409,
    });
  });

  it("sanitizes invalid Engine errors while preserving HTTP status", async () => {
    const client = new EngineClient(
      config,
      authProvider,
      vi.fn().mockResolvedValue(
        jsonResponse(503, {
          detail: "SQL failed for tenant secret",
          stack: "internal",
        }),
      ),
      noDelay,
    );

    const error = await client
      .post("/api/v1/workflows", {}, context, { idempotencyKey: "key" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineProblemError);
    expect((error as EngineProblemError).problem).toMatchObject({
      status: 503,
      error_code: "UPSTREAM_SERVICE_ERROR",
      detail: "Upstream service request failed.",
    });
    expect(JSON.stringify((error as EngineProblemError).problem)).not.toContain(
      "SQL failed",
    );
  });

  it("retries one GET on retryable response and never retries mutation", async () => {
    const getFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { unavailable: true }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new EngineClient(config, authProvider, getFetch, noDelay);
    await expect(client.get("/api/v1/system/service-health", context)).resolves.toMatchObject({
      body: { ok: true },
    });
    expect(getFetch).toHaveBeenCalledTimes(2);

    const mutationFetch = vi.fn().mockRejectedValue(new Error("network down"));
    const mutationClient = new EngineClient(
      config,
      authProvider,
      mutationFetch,
      noDelay,
    );
    await expect(
      mutationClient.post("/api/v1/runs", {}, context, {
        idempotencyKey: "run-1",
      }),
    ).rejects.toMatchObject({
      problem: { status: 502, error_code: "UPSTREAM_SERVICE_ERROR" },
    });
    expect(mutationFetch).toHaveBeenCalledOnce();
  });

  it("retries GET network failure once and does not retry client errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);
    await expect(client.get("/api/v1/workflows", context)).resolves.toMatchObject({
      body: { ok: true },
    });

    const badRequestFetch = vi.fn().mockResolvedValue(problemResponse(validProblem(400)));
    await expect(
      new EngineClient(config, authProvider, badRequestFetch, noDelay).get(
        "/api/v1/workflows",
        context,
      ),
    ).rejects.toMatchObject({ problem: { status: 400 } });
    expect(badRequestFetch).toHaveBeenCalledOnce();
  });

  it("maps aborts to 504 and rejects paths outside Engine v1", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const client = new EngineClient(
      config,
      authProvider,
      vi.fn().mockRejectedValue(abort),
      noDelay,
    );

    await expect(
      client.post("/api/v1/runs", {}, context, { idempotencyKey: "run" }),
    ).rejects.toMatchObject({
      problem: { status: 504, error_code: "UPSTREAM_TIMEOUT" },
    });
    await expect(
      client.get("https://other.test/api/v1/workflows" as EnginePath, context),
    ).rejects.toThrow("Engine path must stay under /api/v1/");
  });

  // The default is deliberately short, so a call that waits on the planner
  // has to say so. Creating a project timed out on every attempt until it did.
  it("gives a call its own timeout when one is asked for, and the short default otherwise", async () => {
    vi.useFakeTimers();
    try {
      const aborted: (boolean | undefined)[] = [];
      const fetchImpl = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal as AbortSignal;
          await vi.advanceTimersByTimeAsync(200);
          aborted.push(signal.aborted);
          return jsonResponse(200, { ok: true });
        },
      );
      const client = new EngineClient(config, authProvider, fetchImpl, noDelay);

      // requestTimeoutMs is 100 here, so 200ms of waiting aborts this one.
      await client
        .post("/api/v1/projects", {}, context, { idempotencyKey: "short" })
        .catch(() => undefined);
      // The planning timeout is two minutes, so the same wait does not.
      await client.post("/api/v1/projects", {}, context, {
        idempotencyKey: "planning",
        timeoutMs: client.planningTimeoutMs,
      });

      expect(aborted).toEqual([true, false]);
      expect(client.planningTimeoutMs).toBe(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes auth-provider failure before transport", async () => {
    const fetchImpl = vi.fn();
    const client = new EngineClient(
      config,
      { authorize: vi.fn().mockRejectedValue(new Error("secret unavailable")) },
      fetchImpl,
      noDelay,
    );
    await expect(
      client.get("/api/v1/workflows", context),
    ).rejects.toMatchObject({
      problem: {
        status: 502,
        error_code: "UPSTREAM_SERVICE_ERROR",
        detail: "Upstream service request failed.",
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opens typed SSE streams with caller context and parses frames", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(
          ': keepalive\n\nid: 7\nevent: run.status\ndata: {"seq":7,"event":"run.status","run_id":"run_018f47a5-7b2c-7d10-8f11-123456789abc","ts":"2026-07-24T10:00:00.000Z","data":{"status":"running"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    const client = new EngineClient(config, authProvider, fetchImpl, noDelay);
    const stream = await client.stream(
      "/api/v1/runs/run_018f47a5-7b2c-7d10-8f11-123456789abc/stream",
      context,
      { lastEventId: "6" },
    );

    const messages = [];
    for await (const message of stream.messages) {
      messages.push(message);
    }
    expect(messages).toEqual([
      {
        id: "7",
        event: "run.status",
        data: expect.objectContaining({ seq: 7, event: "run.status" }),
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/runs/"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer m2m-token",
          "X-Alter-Actor-Token": "actor-token",
          "Last-Event-ID": "6",
          Accept: "text/event-stream, application/problem+json",
        }),
      }),
    );
    stream.close();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("retries initial SSE connection once and maps terminal failure", async () => {
    const retryingFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { unavailable: true }))
      .mockResolvedValueOnce(
        new Response("data: {\"ok\":true}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const client = new EngineClient(
      config,
      authProvider,
      retryingFetch,
      noDelay,
    );
    await expect(
      client.stream("/api/v1/runs/run-1/stream", context),
    ).resolves.toEqual(
      expect.objectContaining({ messages: expect.anything() }),
    );
    expect(retryingFetch).toHaveBeenCalledTimes(2);

    const failed = new EngineClient(
      config,
      authProvider,
      vi.fn().mockResolvedValue(problemResponse(validProblem(403))),
      noDelay,
    );
    await expect(
      failed.stream("/api/v1/runs/run-1/stream", context),
    ).rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("maps SSE auth, network, abort, and bodyless failures", async () => {
    const authFailure = new EngineClient(
      config,
      { authorize: vi.fn().mockRejectedValue(new Error("secret")) },
      vi.fn(),
      noDelay,
    );
    await expect(
      authFailure.stream("/api/v1/runs/run-1/stream", context),
    ).rejects.toMatchObject({
      problem: { status: 502, error_code: "UPSTREAM_SERVICE_ERROR" },
    });

    const networkFetch = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      new EngineClient(config, authProvider, networkFetch, noDelay).stream(
        "/api/v1/runs/run-1/stream",
        context,
      ),
    ).rejects.toMatchObject({ problem: { status: 502 } });
    expect(networkFetch).toHaveBeenCalledTimes(2);

    const abortFetch = vi
      .fn()
      .mockRejectedValue(new DOMException("timed out", "AbortError"));
    await expect(
      new EngineClient(config, authProvider, abortFetch, noDelay).stream(
        "/api/v1/runs/run-1/stream",
        context,
      ),
    ).rejects.toMatchObject({ problem: { status: 504 } });

    await expect(
      new EngineClient(
        config,
        authProvider,
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        noDelay,
      ).stream("/api/v1/runs/run-1/stream", context),
    ).rejects.toMatchObject({ problem: { status: 502 } });
  });

  it("parses data-only final SSE frames without trailing newline", async () => {
    const client = new EngineClient(
      config,
      authProvider,
      vi.fn().mockResolvedValue(
        new Response('retry\ndata: {"ok":true}', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
      noDelay,
    );
    const stream = await client.stream("/api/v1/runs/run-1/stream", context);
    const messages = [];
    for await (const message of stream.messages) {
      messages.push(message);
    }
    expect(messages).toEqual([{ data: { ok: true } }]);
  });

  it("renders Engine errors as application/problem+json", () => {
    const problem = validProblem(409);
    const reply = filterReply();
    new EngineExceptionFilter().catch(
      new EngineProblemError(problem),
      reply.host,
    );
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.type).toHaveBeenCalledWith("application/problem+json");
    expect(reply.send).toHaveBeenCalledWith(problem);
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function validProblem(status: number): ProblemDetails {
  return {
    type: "https://errors.alter.ai/workflow/conflict",
    title: "Workflow conflict",
    status,
    detail: "Workflow state conflict",
    instance: "/api/v1/workflows/workflow-1",
    error_code: "WORKFLOW_CONFLICT",
    trace_id: "trc_018f47a5-7b2c-7d10-8f11-123456789abc",
    request_id: "req_018f47a5-7b2c-7d10-8f11-123456789abd",
    retryable: false,
    field_errors: [],
    documentation_key: "workflow.conflict",
  };
}

function problemResponse(problem: ProblemDetails): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "content-type": "application/problem+json" },
  });
}

function noDelay(): Promise<void> {
  return Promise.resolve();
}

function filterReply(): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply: Record<string, unknown> = {};
  const status = vi.fn(() => reply);
  const type = vi.fn(() => reply);
  const send = vi.fn(() => reply);
  Object.assign(reply, { status, type, send });
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as unknown as ArgumentsHost,
    status,
    type,
    send,
  };
}
