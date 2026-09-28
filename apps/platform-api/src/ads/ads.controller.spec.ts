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
import { AdsController } from "./ads.controller";
import { AdsExceptionFilter } from "./ads-exception.filter";
import { AdsModule } from "./ads.module";
import { AdsService } from "./ads.service";
import { adsDeferredCapabilities } from "./types";

const uuid = "018f47a5-7b2c-7d10-8f11-123456789abc";
const sourceId = `src_${uuid}`;
const jobId = `ing_${uuid}`;
const documentId = `doc_${uuid}`;
const actor: ActorContextType = {
  user_id: `usr_${uuid}`,
  tenant_id: `ten_${uuid}`,
  workspace_id: `ws_${uuid}`,
  session_id: "session-ads",
  auth_time: 1_700_000_000,
  roles: ["admin"],
  permissions: ["knowledge:read", "knowledge:admin", "knowledge:delete"],
};
const ownerActor: ActorContextType = {
  ...actor,
  roles: ["owner", "admin"],
};

describe("ADS administration routes", () => {
  let app: NestFastifyApplication;
  const engine = new AdsEngine();
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdsController],
      providers: [
        {
          provide: AdsService,
          inject: [EngineClient],
          useFactory: (client: EngineClient) => new AdsService(client),
        },
        AdsExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        { provide: EngineClient, useValue: engine },
        { provide: PgIdempotencyStore, useValue: store },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook(
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

  afterAll(async () => app.close());

  it.each(mutationCases())(
    "relays and idempotently replays %s %s",
    async (method, url, body, status) => {
      const options = {
        method,
        url,
        body,
        actor,
        headers: mutationHeaders(method, url, `key-${url}`),
      };
      const first = await request(options);
      const second = await request(options);
      expect(first.statusCode).toBe(status);
      expect(second.statusCode).toBe(status);
      expect(second.headers["idempotency-replayed"]).toBe("true");
      expect(engine.mutationCount()).toBe(1);
    },
  );

  it("relays typed upload start and typed ingestion job status", async () => {
    const input = {
      source_id: sourceId,
      filename: "handbook.pdf",
      content_type: "application/pdf",
    };
    const upload = await request({
      method: "POST",
      url: "/api/v1/ads/ingestion/uploads",
      body: input,
      actor,
      headers: { "idempotency-key": "upload-flow" },
    });
    expect(upload.statusCode).toBe(202);
    expect(upload.json()).toEqual(engine.uploadResource);
    expect(upload.json()).toEqual({
      ingestion_job_id: jobId,
      upload: {
        signed_url: "https://uploads.example.test/tenant/object?signature=abc",
        expires_at: "2026-08-04T08:15:00Z",
      },
      upload_fields: { key: "tenant/object", policy: "signed-policy" },
      upload_key: "tenant/object",
      max_content_bytes: 10_000_000,
    });
    expect(upload.headers.location).toBe(
      `/api/v1/ads/ingestion/jobs/${jobId}`,
    );
    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/ads/ingestion/uploads/presign",
      input,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
        permissions: actor.permissions,
      }),
      { idempotencyKey: "upload-flow" },
    );

    const complete = await request({
      method: "POST",
      url: "/api/v1/ads/ingestion/uploads/complete",
      body: {
        ingestion_job_id: jobId,
        source_id: sourceId,
        upload_key: "tenant/object",
      },
      actor,
      headers: { "idempotency-key": "upload-complete" },
    });
    expect(complete.statusCode).toBe(202);
    expect(complete.json()).toEqual(engine.ingestionJobResponse);

    const job = await request({
      method: "GET",
      url: `/api/v1/ads/ingestion/jobs/${jobId}`,
      actor,
    });
    expect(job.statusCode).toBe(200);
    expect(job.json()).toEqual(engine.ingestionJobResponse);
  });

  it.each([
    ["received", "queued", 1, 14],
    ["validated", "in_progress", 2, 29],
    ["failed", "failed", 7, 100],
  ] as const)(
    "maps %s ingestion progress and status",
    async (stage, status, completedStages, percent) => {
      Object.assign(engine.jobResource, {
        stage,
        stats: { deduplication: null },
        error: stage === "failed" ? "virus detected" : null,
        completed_at: stage === "failed" ? "2026-08-04T08:00:08Z" : null,
      });

      const result = await request({
        method: "GET",
        url: `/api/v1/ads/ingestion/jobs/${jobId}`,
        actor,
      });

      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        status,
        stage,
        progress: { completed_stages: completedStages, percent },
        document_ids: [],
      });
    },
  );

  it("reports both original and duplicate document references", async () => {
    Object.assign(engine.jobResource, {
      stage: "indexed",
      stats: {
        deduplication: {
          document_id: documentId,
          duplicate_of_document_id: `doc_duplicate_${uuid}`,
        },
      },
      error: null,
      completed_at: "2026-08-04T08:00:08Z",
    });

    const result = await request({
      method: "GET",
      url: `/api/v1/ads/ingestion/jobs/${jobId}`,
      actor,
    });

    expect(result.json()).toMatchObject({
      document_ids: [documentId, `doc_duplicate_${uuid}`],
    });
  });

  it("relays document pagination, detail, and opaque deletion response", async () => {
    const list = await request({
      method: "GET",
      url: "/api/v1/ads/documents?cursor=next%2Fpage&limit=25",
      actor,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(engine.documentPage);
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/ads/documents?cursor=next%2Fpage&limit=25",
      expect.any(Object),
    );

    const detail = await request({
      method: "GET",
      url: `/api/v1/ads/documents/${documentId}`,
      actor,
    });
    expect(detail.json()).toEqual(engine.documentResource);

    const removed = await request({
      method: "DELETE",
      url: `/api/v1/ads/documents/${documentId}`,
      actor,
      headers: { "idempotency-key": "delete-document" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual(engine.deletedResource);
    expect(removed.json()).not.toHaveProperty("deletion_certificate");
  });

  it("relays source list pagination and detail reads", async () => {
    const list = await request({
      method: "GET",
      url: "/api/v1/ads/sources?cursor=next%2Fpage&limit=25",
      actor,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(engine.sourcePage);
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/ads/sources?cursor=next%2Fpage&limit=25",
      expect.any(Object),
    );

    const detail = await request({
      method: "GET",
      url: `/api/v1/ads/sources/${sourceId}/detail`,
      actor,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(engine.sourceResource);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/ads/sources/${sourceId}/detail`,
      expect.any(Object),
    );
  });

  it("relays a real deletion certificate unchanged and ignores forged tenant input", async () => {
    const options = {
      method: "POST",
      url: "/api/v1/ads/deletion-requests",
      body: { tenantId: `ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1` },
      actor: ownerActor,
      headers: { "idempotency-key": "tenant-deletion" },
    };

    const first = await request(options);
    const replay = await request(options);

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual(engine.deletionCertificate);
    expect(replay.json()).toEqual(engine.deletionCertificate);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(engine.post).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/deletion-requests",
      {},
      expect.objectContaining({
        tenantId: ownerActor.tenant_id,
        workspaceId: ownerActor.workspace_id,
      }),
      { idempotencyKey: "tenant-deletion" },
    );
    expect(JSON.stringify(engine.post.mock.calls)).not.toContain(
      "1234567890b1",
    );
  });

  it("relays actor-scoped retention unchanged and idempotently", async () => {
    const options = {
      method: "POST",
      url: "/api/v1/ads/deletion-requests/retention",
      actor,
      headers: { "idempotency-key": "tenant-retention" },
    };

    const first = await request(options);
    const replay = await request(options);

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual(engine.retentionResult);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(engine.post).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/deletion-requests/retention",
      {},
      expect.objectContaining({ tenantId: actor.tenant_id }),
      { idempotencyKey: "tenant-retention" },
    );
  });

  it("relays real document permission reads and validated updates", async () => {
    const read = await request({
      method: "GET",
      url: `/api/v1/ads/documents/${documentId}/permissions`,
      actor,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(engine.permissionsResource);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/ads/documents/${documentId}/permissions`,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
    );

    const update = { shared_with: ["team_legal"] };
    const changed = await request({
      method: "PATCH",
      url: `/api/v1/ads/documents/${documentId}/permissions`,
      body: update,
      actor,
      headers: { "idempotency-key": "permissions-update", "if-match": '"etag-1"' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual(engine.permissionsResource);
    expect(engine.patch).toHaveBeenCalledWith(
      `/api/v1/ads/documents/${documentId}/permissions`,
      update,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
      { idempotencyKey: "permissions-update", ifMatch: '"etag-1"' },
    );
  });

  it("rejects document/source permission mutations missing If-Match instead of relaying a wildcard (ENGINE-FIX-B5-2)", async () => {
    const documentUpdate = await request({
      method: "PATCH",
      url: `/api/v1/ads/documents/${documentId}/permissions`,
      body: { shared_with: ["team_legal"] },
      actor,
      headers: { "idempotency-key": "no-if-match-document" },
    });
    expectProblem(documentUpdate, 428, "IF_MATCH_REQUIRED");
    expect(engine.patch).not.toHaveBeenCalled();

    const sourceUpdate = await request({
      method: "PUT",
      url: `/api/v1/ads/sources/${sourceId}/permissions`,
      body: { visibility: "tenant", shared_with: [] },
      actor,
      headers: { "idempotency-key": "no-if-match-source" },
    });
    expectProblem(sourceUpdate, 428, "IF_MATCH_REQUIRED");
    expect(engine.put).not.toHaveBeenCalled();
  });

  it("relays source permission reads and full replacements", async () => {
    const read = await request({
      method: "GET",
      url: `/api/v1/ads/sources/${sourceId}/permissions`,
      actor,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(engine.sourcePermissionsResource);
    expect(engine.get).toHaveBeenCalledWith(
      `/api/v1/ads/sources/${sourceId}/permissions`,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
    );

    const replacement = {
      visibility: "tenant",
      shared_with: ["team_legal"],
      retention_days: 90,
    };
    const changed = await request({
      method: "PUT",
      url: `/api/v1/ads/sources/${sourceId}/permissions`,
      body: replacement,
      actor,
      headers: {
        "idempotency-key": "source-permissions-replace",
        "if-match": '"etag-2"',
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual(engine.sourcePermissionsResource);
    expect(engine.put).toHaveBeenCalledWith(
      `/api/v1/ads/sources/${sourceId}/permissions`,
      replacement,
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
      { idempotencyKey: "source-permissions-replace", ifMatch: '"etag-2"' },
    );
  });

  it("relays per-document reindex through Engine with tenant actor context", async () => {
    const result = await request({
      method: "POST",
      url: `/api/v1/ads/documents/${documentId}/actions/reindex`,
      actor,
      headers: { "idempotency-key": "reindex-document" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(engine.reindexResource);
    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/ads/documents/${documentId}/actions/reindex`,
      {},
      expect.objectContaining({
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
      { idempotencyKey: "reindex-document" },
    );
  });

  it("passes source, sync, and knowledge bodies to Engine unchanged", async () => {
    const createBody = { connector: "drive", settings: { folder: " a/b\n" } };
    const source = await request({
      method: "POST",
      url: "/api/v1/ads/sources",
      body: createBody,
      actor,
      headers: { "idempotency-key": "source-create" },
    });
    expect(source.statusCode).toBe(201);
    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/ads/sources",
      createBody,
      expect.any(Object),
      { idempotencyKey: "source-create" },
    );

    const syncBody = { full: true, engine_extension: ["opaque"] };
    const sync = await request({
      method: "POST",
      url: `/api/v1/ads/sources/${sourceId}/actions/sync`,
      body: syncBody,
      actor,
      headers: { "idempotency-key": "source-sync" },
    });
    expect(sync.statusCode).toBe(202);
    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/ads/sources/${sourceId}/actions/sync`,
      syncBody,
      expect.any(Object),
      { idempotencyKey: "source-sync" },
    );

    const knowledgeBody = { title: "Policy", content: " preserve me\n" };
    await request({
      method: "POST",
      url: "/api/v1/ads/knowledge",
      body: knowledgeBody,
      actor,
      headers: { "idempotency-key": "knowledge-create" },
    });
    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/ads/knowledge",
      knowledgeBody,
      expect.any(Object),
      { idempotencyKey: "knowledge-create" },
    );
  });

  it("relays a scoped retrieval query with real provenance fields unchanged", async () => {
    const query = {
      query: "refund policy",
      top_k: 5,
      rerank: true,
      scope_ids: [`scp_${uuid}`],
      source_ids: [sourceId],
      metadata_filter: { department: "support" },
    };
    const result = await request({
      method: "POST",
      url: "/api/v1/ads/query",
      body: query,
      actor,
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(engine.retrievalHttpResponse);
    expect(engine.queryAds).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        userId: actor.user_id,
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
      }),
    );
    const body = result.json() as typeof engine.retrievalHttpResponse;
    expect(body.results[0]).toEqual(
      expect.objectContaining({
        provenance: engine.retrievalResponse.hits[0]!.provenance,
        confidence: 0.94,
      }),
    );
    expect(body.query).toEqual(
      expect.objectContaining({
        query: "refund policy",
        top_k: 5,
        rerank: true,
        source_ids: [sourceId],
      }),
    );
  });

  it("never accepts client-supplied retrieval identity", async () => {
    const result = await request({
      method: "POST",
      url: "/api/v1/ads/query",
      body: { query: "refund", tenant_id: "ten_foreign" },
      actor,
    });
    expectProblem(result, 400, "ADS_VALIDATION_FAILED");
    expect(engine.queryAds).not.toHaveBeenCalled();
  });

  it.each([
    [403, "ADS_SCOPE_VIOLATION"],
    [429, "ADS_RETRIEVAL_BACKPRESSURE"],
    [422, "ADS_RETRIEVAL_INVALID"],
  ])("maps ADS query upstream %i to problem+json %s", async (status, code) => {
    engine.failQuery(status);
    const result = await request({
      method: "POST",
      url: "/api/v1/ads/query",
      body: { query: "refund" },
      actor,
    });
    expectProblem(result, status, code);
    if (status === 429) {
      expect((result.json() as { retryable: boolean }).retryable).toBe(true);
    }
  });

  it("passes non-domain ADS query failures through without remapping", async () => {
    engine.failQuery(503);
    const result = await request({
      method: "POST",
      url: "/api/v1/ads/query",
      body: { query: "refund" },
      actor,
    });
    expectProblem(result, 503, "UPSTREAM_SERVICE_ERROR");
  });

  it.each(routeCases())(
    "scope-gates %s %s before Engine",
    async (method, url, body) => {
      const response = await request({
        method,
        url,
        body,
        actor: { ...actor, permissions: [] },
        headers: isMutation(method)
          ? mutationHeaders(method, url, "denied")
          : undefined,
      });
      expectProblem(response, 403, "RBAC_PERMISSION_DENIED");
      expect(engine.get).not.toHaveBeenCalled();
      expect(engine.post).not.toHaveBeenCalled();
      expect(engine.patch).not.toHaveBeenCalled();
      expect(engine.delete).not.toHaveBeenCalled();
      expect(engine.queryAds).not.toHaveBeenCalled();
    },
  );

  it("requires admin role for writes and privileged admin role for deletion", async () => {
    const adminTenantDeletion = await request({
      method: "POST",
      url: "/api/v1/ads/deletion-requests",
      actor,
      headers: { "idempotency-key": "admin-tenant-deletion" },
    });
    expectProblem(adminTenantDeletion, 403, "RBAC_ROLE_DENIED");

    const ownerWithoutPermission = await request({
      method: "POST",
      url: "/api/v1/ads/deletion-requests",
      actor: { ...ownerActor, permissions: [] },
      headers: { "idempotency-key": "owner-without-delete" },
    });
    expectProblem(ownerWithoutPermission, 403, "RBAC_PERMISSION_DENIED");

    const editorDelete = await request({
      method: "DELETE",
      url: `/api/v1/ads/documents/${documentId}`,
      actor: { ...actor, roles: ["editor"] },
      headers: { "idempotency-key": "editor-delete" },
    });
    expectProblem(editorDelete, 403, "RBAC_ROLE_DENIED");

    const viewerCreate = await request({
      method: "POST",
      url: "/api/v1/ads/sources",
      body: {},
      actor: { ...actor, roles: ["viewer"] },
      headers: { "idempotency-key": "viewer-create" },
    });
    expectProblem(viewerCreate, 403, "RBAC_ROLE_DENIED");
  });

  it.each([
    ["GET", "/api/v1/ads/documents?limit=201", undefined],
    ["GET", "/api/v1/ads/documents?cursor=", undefined],
    ["GET", "/api/v1/ads/documents/bad", undefined],
    ["GET", "/api/v1/ads/ingestion/jobs/bad", undefined],
    ["POST", `/api/v1/ads/sources/${sourceId}/actions/sync`, []],
    ["POST", "/api/v1/ads/knowledge", []],
    ["POST", "/api/v1/ads/query", {}],
    ["POST", "/api/v1/ads/query", { query: "   " }],
    [
      "PATCH",
      `/api/v1/ads/documents/${documentId}/permissions`,
      { visibility: "public" },
    ],
    ["PATCH", `/api/v1/ads/documents/${documentId}/permissions`, {}],
  ])("returns problem+json validation for %s %s", async (method, url, body) => {
    const response = await request({
      method,
      url,
      body,
      actor,
      headers: isMutation(method)
        ? mutationHeaders(method, url, `invalid-${url}`)
        : undefined,
    });
    expectProblem(response, 400, "ADS_VALIDATION_FAILED");
  });

  it.each(engineErrorCases())(
    "passes Engine problem through for %s %s",
    async (method, url, body, enginePath) => {
      engine.failNext(method, enginePath);
      const response = await request({
        method,
        url,
        body,
        actor,
        headers: isMutation(method)
          ? mutationHeaders(method, url, `failure-${url}`)
          : undefined,
      });
      expectProblem(response, 503, "ENGINE_ADS_UNAVAILABLE");
    },
  );

  it("passes deletion Engine problems through for an authorized owner", async () => {
    engine.failNext("POST", "/api/v1/deletion-requests");
    const response = await request({
      method: "POST",
      url: "/api/v1/ads/deletion-requests",
      actor: ownerActor,
      headers: { "idempotency-key": "failure-tenant-deletion" },
    });
    expectProblem(response, 503, "ENGINE_ADS_UNAVAILABLE");
  });

  it("requires Idempotency-Key for every mutation", async () => {
    for (const [method, url, body] of mutationCases()) {
      const response = await request({ method, url, body, actor });
      expectProblem(response, 400, "IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(engine.mutationCount()).toBe(0);
  });

  it("requires Idempotency-Key for owner deletion", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/ads/deletion-requests",
      actor: ownerActor,
    });
    expectProblem(response, 400, "IDEMPOTENCY_KEY_REQUIRED");
    expect(engine.post).not.toHaveBeenCalled();
  });

  it("flags every deferred surface and leaves fabricated routes absent", async () => {
    expect(adsDeferredCapabilities).toEqual([]);

    for (const [method, url] of [
      ["POST", "/api/v1/ads/retrieval"],
      ["POST", `/api/v1/ads/sources/${sourceId}/actions/reindex`],
      ["GET", `/api/v1/ads/documents/${documentId}/deletion-certificate`],
    ] as const) {
      expect((await request({ method, url, body: {}, actor })).statusCode).toBe(
        404,
      );
    }
  });

  it("default-denies missing actor and workspace context", async () => {
    const unauthenticated = await request({
      method: "GET",
      url: "/api/v1/ads/documents",
    });
    expectProblem(unauthenticated, 403, "RBAC_ROLE_DENIED");

    const controller = new AdsController({
      documents: vi.fn(),
    } as unknown as AdsService);
    await expect(
      controller.documents(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });

    const { workspace_id: _workspaceId, ...withoutWorkspace } = actor;
    void _workspaceId;
    const noWorkspace = await request({
      method: "GET",
      url: "/api/v1/ads/documents",
      actor: withoutWorkspace,
    });
    expectProblem(noWorkspace, 403, "ADS_WORKSPACE_REQUIRED");
  });

  it("rejects malformed trace context and wires the production module", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/ads/documents",
      actor,
      headers: { traceparent: "bad-trace" },
    });
    expectProblem(response, 400, "ADS_VALIDATION_FAILED");
    expect(AdsModule).toBeDefined();
  });

  function request(options: RequestOptions): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method: options.method,
      url: options.url,
      payload: options.body as never,
      headers: {
        ...(options.actor
          ? { "x-test-actor": JSON.stringify(options.actor) }
          : {}),
        ...options.headers,
      },
    } as never) as Promise<TestResponse>;
  }
});

class AdsEngine {
  readonly uploadResource = {
    ingestion_job_id: jobId,
    upload: {
      signed_url: "https://uploads.example.test/tenant/object?signature=abc",
      expires_at: "2026-08-04T08:15:00Z",
    },
    upload_fields: { key: "tenant/object", policy: "signed-policy" },
    upload_key: "tenant/object",
    max_content_bytes: 10_000_000,
  };
  readonly presignResource = {
    ingestion_job_id: jobId,
    upload_url: "https://uploads.example.test/tenant/object?signature=abc",
    expires_at: "2026-08-04T08:15:00Z",
    upload_fields: { key: "tenant/object", policy: "signed-policy" },
    upload_key: "tenant/object",
    max_content_bytes: 10_000_000,
  };
  readonly jobResource = {
    ingestion_job_id: jobId,
    source_id: sourceId,
    stage: "indexed",
    stats: {
      deduplication: {
        document_id: documentId,
        is_duplicate: false,
      },
    },
    error: null,
    created_at: "2026-08-04T08:00:00Z",
    completed_at: "2026-08-04T08:00:08Z",
  };
  readonly ingestionJobResponse = {
    ingestion_job_id: jobId,
    source_id: sourceId,
    status: "completed",
    stage: "indexed",
    progress: {
      completed_stages: 7,
      total_stages: 7,
      percent: 100,
      current_stage: "indexed",
    },
    document_ids: [documentId],
    failure_detail: null,
    created_at: "2026-08-04T08:00:00Z",
    completed_at: "2026-08-04T08:00:08Z",
  };
  readonly documentResource = {
    id: documentId,
    title: "Policy",
    opaque_metadata: { nested: true },
  };
  readonly documentPage = {
    data: [this.documentResource],
    page: { next_cursor: "next-engine", has_more: true },
  };
  readonly sourceResource = {
    id: sourceId,
    scope_id: `scp_${uuid}`,
    workspace_id: actor.workspace_id,
    kind: "connector",
    provider: "google_drive",
    sync_config: { name: "Policies" },
    status: "active",
    last_sync_at: "2026-08-04T08:00:00Z",
    document_count: 4,
    chunk_count: 12,
    created_at: "2026-08-04T07:00:00Z",
    updated_at: "2026-08-04T08:00:00Z",
  };
  readonly sourcePage = {
    data: [this.sourceResource],
    page: { next_cursor: null, has_more: false },
  };
  readonly deletedResource = {
    id: documentId,
    deleted: true,
    engine_receipt: { opaque: "value" },
  };
  readonly reindexResource = {
    document_id: documentId,
    previous_document_version: 1,
    document_version: 2,
    embedding_version: "v2",
    chunk_count: 3,
  };
  readonly permissionsResource = {
    visibility: "tenant",
    shared_with: ["team_legal"],
  };
  readonly sourcePermissionsResource = {
    visibility: "tenant",
    shared_with: ["team_legal"],
    retention_days: 90,
  };
  readonly retrievalResponse = {
    hits: [
      {
        document_id: documentId,
        chunk_id: `chk_${uuid}`,
        source_id: sourceId,
        scope_id: `scp_${uuid}`,
        context: "refund policy allows returns",
        reconstructed_context: "refund policy allows returns",
        score: 0.98,
        confidence: 0.94,
        provenance: {
          ingestion: { origin: "upload" },
          document: { id: documentId },
        },
        freshness_at: "2026-08-04T08:00:00Z",
        metadata: { department: "support" },
        semantic_score: 1,
        keyword_score: 0.96,
      },
    ],
    audited_at: "2026-08-04T08:00:01Z",
  };
  get retrievalHttpResponse() {
    const hit = this.retrievalResponse.hits[0]!;
    return {
      results: [
        {
          id: hit.chunk_id,
          document_id: hit.document_id,
          chunk_id: hit.chunk_id,
          chunk_reference: hit.chunk_id,
          source_id: hit.source_id,
          scope_id: hit.scope_id,
          text: hit.context,
          reconstructed_text: hit.reconstructed_context,
          score: hit.score,
          confidence: hit.confidence,
          provenance: hit.provenance,
          metadata: hit.metadata,
          freshness_at: hit.freshness_at,
          semantic_score: hit.semantic_score,
          keyword_score: hit.keyword_score,
        },
      ],
      query: {
        query: "refund policy",
        top_k: 5,
        rerank: true,
        scope_ids: [`scp_${uuid}`],
        source_ids: [sourceId],
        metadata_filter: { department: "support" },
        audited_at: this.retrievalResponse.audited_at,
      },
    };
  }
  readonly deletionCertificate = {
    store: "orchestration-service",
    manifestId: "del_018f4d6e-2b4a-7a3e-8c1a-1234567890d1",
    deleted: true,
    remaining: [],
  };
  readonly retentionResult = {
    store: "orchestration-service",
    deletedRows: 4,
    deletedObjects: 0,
    sweptAt: "2026-08-04T08:00:02.000Z",
  };
  readonly get = vi.fn(this.getResponse.bind(this));
  readonly post = vi.fn(this.postResponse.bind(this));
  readonly put = vi.fn(this.putResponse.bind(this));
  readonly patch = vi.fn(this.patchResponse.bind(this));
  readonly delete = vi.fn(this.deleteResponse.bind(this));
  readonly queryAds = vi.fn(this.queryAdsResponse.bind(this));
  private failure: { method: string; path: string } | undefined;
  private queryFailureStatus: number | undefined;

  reset(): void {
    this.get.mockClear();
    this.post.mockClear();
    this.put.mockClear();
    this.patch.mockClear();
    this.delete.mockClear();
    this.queryAds.mockClear();
    this.failure = undefined;
    this.queryFailureStatus = undefined;
  }

  mutationCount(): number {
    return (
      this.post.mock.calls.length +
      this.put.mock.calls.length +
      this.patch.mock.calls.length +
      this.delete.mock.calls.length
    );
  }

  failNext(method: string, path: string): void {
    this.failure = { method, path };
  }

  failQuery(status: number): void {
    this.queryFailureStatus = status;
  }

  private async queryAdsResponse(
    _body: Readonly<Record<string, unknown>>,
    _context: EngineCallerContext,
  ): Promise<EngineResponse<unknown>> {
    void _body;
    void _context;
    if (this.queryFailureStatus !== undefined) {
      const status = this.queryFailureStatus;
      this.queryFailureStatus = undefined;
      throw new EngineProblemError({
        type: "https://errors.alter.ai/upstream-service-error",
        title: "Upstream service error",
        status,
        detail: "Upstream service request failed.",
        instance: "/api/v1/ads/query",
        error_code: "UPSTREAM_SERVICE_ERROR",
        trace_id: "trc_ads",
        request_id: "req_ads",
        retryable: status === 429,
        field_errors: [],
        documentation_key: "upstream.service-error",
      });
    }
    return response(this.retrievalResponse);
  }

  private async getResponse(
    path: EnginePath,
    _context: EngineCallerContext,
  ): Promise<EngineResponse<unknown>> {
    void _context;
    this.throwIfFailed("GET", path);
    const pathname = new URL(path, "https://engine.internal").pathname;
    if (pathname === `/api/v1/ads/ingestion/jobs/${jobId}`) {
      return response(this.jobResource);
    }
    if (pathname === "/api/v1/ads/documents") {
      return response(this.documentPage);
    }
    if (pathname === "/api/v1/ads/sources") {
      return response(this.sourcePage);
    }
    if (pathname === `/api/v1/ads/sources/${sourceId}/detail`) {
      return response(this.sourceResource);
    }
    if (pathname === `/api/v1/ads/sources/${sourceId}/permissions`) {
      return response(this.sourcePermissionsResource);
    }
    if (pathname.endsWith("/permissions")) {
      return response(this.permissionsResource);
    }
    return response(this.documentResource);
  }

  private async patchResponse(
    path: EnginePath,
    _body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string; ifMatch: string },
  ): Promise<EngineResponse<unknown>> {
    void _body;
    void _context;
    void _options;
    this.throwIfFailed("PATCH", path);
    return response(this.permissionsResource);
  }

  private async putResponse(
    path: EnginePath,
    body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string; ifMatch: string },
  ): Promise<EngineResponse<unknown>> {
    void body;
    void _context;
    void _options;
    this.throwIfFailed("PUT", path);
    if (path === `/api/v1/ads/sources/${sourceId}/permissions`) {
      return response(this.sourcePermissionsResource);
    }
    return response({});
  }

  private async postResponse(
    path: EnginePath,
    body: EngineRequestBody,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string },
  ): Promise<EngineResponse<unknown>> {
    void body;
    void _context;
    void _options;
    this.throwIfFailed("POST", path);
    if (path === "/api/v1/ads/ingestion/uploads/presign") {
      return {
        status: 201,
        body: this.presignResource,
      };
    }
    if (path === "/api/v1/ads/ingestion/uploads/complete") {
      return { status: 202, body: this.jobResource };
    }
    if (path.endsWith("/actions/sync")) {
      return { status: 202, body: { id: sourceId, state: "syncing" } };
    }
    if (path.endsWith("/actions/reindex")) {
      return { status: 200, body: this.reindexResource };
    }
    if (path === "/api/v1/deletion-requests") {
      return { status: 201, body: this.deletionCertificate };
    }
    if (path === "/api/v1/deletion-requests/retention") {
      return { status: 201, body: this.retentionResult };
    }
    return {
      status: 201,
      body: path.endsWith("/sources")
        ? { id: sourceId, created: true }
        : { id: `knw_${uuid}`, created: true },
    };
  }

  private async deleteResponse(
    path: EnginePath,
    _context: EngineCallerContext,
    _options: { idempotencyKey: string },
  ): Promise<EngineResponse<unknown>> {
    void _context;
    void _options;
    this.throwIfFailed("DELETE", path);
    return response(this.deletedResource);
  }

  private throwIfFailed(method: string, path: string): void {
    if (this.failure?.method !== method || this.failure.path !== path) return;
    this.failure = undefined;
    throw new EngineProblemError({
      type: "https://errors.alter.ai/engine-ads-unavailable",
      title: "ENGINE_ADS_UNAVAILABLE",
      status: 503,
      detail: "Engine ADS unavailable",
      instance: path,
      error_code: "ENGINE_ADS_UNAVAILABLE",
      trace_id: "trc_engine",
      request_id: "req_engine",
      retryable: true,
      field_errors: [],
      documentation_key: "engine.ads.unavailable",
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

function response<T>(body: T): EngineResponse<T> {
  return { status: 200, body };
}

function mutationCases() {
  return [
    [
      "POST",
      "/api/v1/ads/deletion-requests/retention",
      undefined,
      201,
    ],
    ["POST", "/api/v1/ads/sources", { connector: "drive" }, 201],
    [
      "POST",
      `/api/v1/ads/sources/${sourceId}/actions/sync`,
      { full: true },
      202,
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads",
      {
        source_id: sourceId,
        filename: "policy.pdf",
        content_type: "application/pdf",
      },
      202,
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads/complete",
      {
        ingestion_job_id: jobId,
        source_id: sourceId,
        upload_key: "tenant/object",
      },
      202,
    ],
    ["DELETE", `/api/v1/ads/documents/${documentId}`, undefined, 200],
    [
      "POST",
      `/api/v1/ads/documents/${documentId}/actions/reindex`,
      undefined,
      200,
    ],
    [
      "PATCH",
      `/api/v1/ads/documents/${documentId}/permissions`,
      { shared_with: ["team_legal"] },
      200,
    ],
    [
      "PUT",
      `/api/v1/ads/sources/${sourceId}/permissions`,
      { visibility: "tenant", shared_with: [], retention_days: 90 },
      200,
    ],
    ["POST", "/api/v1/ads/knowledge", { title: "Policy" }, 201],
  ] as const;
}

function routeCases(): ReadonlyArray<
  readonly [method: string, url: string, body: unknown]
> {
  return [
    ["POST", "/api/v1/ads/deletion-requests/retention", undefined],
    ["POST", "/api/v1/ads/sources", { connector: "drive" }],
    [
      "POST",
      `/api/v1/ads/sources/${sourceId}/actions/sync`,
      { full: true },
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads",
      {
        source_id: sourceId,
        filename: "policy.pdf",
        content_type: "application/pdf",
      },
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads/complete",
      {
        ingestion_job_id: jobId,
        source_id: sourceId,
        upload_key: "tenant/object",
      },
    ],
    ["DELETE", `/api/v1/ads/documents/${documentId}`, undefined],
    [
      "POST",
      `/api/v1/ads/documents/${documentId}/actions/reindex`,
      undefined,
    ],
    ["POST", "/api/v1/ads/knowledge", { title: "Policy" }],
    ["POST", "/api/v1/ads/query", { query: "refund" }],
    ["GET", `/api/v1/ads/ingestion/jobs/${jobId}`, undefined],
    ["GET", "/api/v1/ads/documents", undefined],
    ["GET", `/api/v1/ads/documents/${documentId}`, undefined],
    [
      "PATCH",
      `/api/v1/ads/documents/${documentId}/permissions`,
      { shared_with: ["team_legal"] },
    ],
    [
      "PUT",
      `/api/v1/ads/sources/${sourceId}/permissions`,
      { visibility: "tenant", shared_with: [] },
    ],
    ["GET", `/api/v1/ads/documents/${documentId}/permissions`, undefined],
    ["GET", `/api/v1/ads/sources/${sourceId}/permissions`, undefined],
  ];
}

function engineErrorCases() {
  return [
    [
      "POST",
      "/api/v1/ads/deletion-requests/retention",
      undefined,
      "/api/v1/deletion-requests/retention",
    ],
    [
      "POST",
      "/api/v1/ads/sources",
      {},
      "/api/v1/ads/sources",
    ],
    [
      "POST",
      `/api/v1/ads/sources/${sourceId}/actions/sync`,
      {},
      `/api/v1/ads/sources/${sourceId}/actions/sync`,
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads",
      { source_id: sourceId, content_type: "application/pdf" },
      "/api/v1/ads/ingestion/uploads/presign",
    ],
    [
      "POST",
      "/api/v1/ads/ingestion/uploads/complete",
      {
        ingestion_job_id: jobId,
        source_id: sourceId,
        upload_key: "tenant/object",
      },
      "/api/v1/ads/ingestion/uploads/complete",
    ],
    [
      "GET",
      `/api/v1/ads/ingestion/jobs/${jobId}`,
      undefined,
      `/api/v1/ads/ingestion/jobs/${jobId}`,
    ],
    ["GET", "/api/v1/ads/documents", undefined, "/api/v1/ads/documents"],
    [
      "GET",
      `/api/v1/ads/documents/${documentId}`,
      undefined,
      `/api/v1/ads/documents/${documentId}`,
    ],
    [
      "DELETE",
      `/api/v1/ads/documents/${documentId}`,
      undefined,
      `/api/v1/ads/documents/${documentId}`,
    ],
    [
      "GET",
      `/api/v1/ads/documents/${documentId}/permissions`,
      undefined,
      `/api/v1/ads/documents/${documentId}/permissions`,
    ],
    [
      "PATCH",
      `/api/v1/ads/documents/${documentId}/permissions`,
      { shared_with: ["team_legal"] },
      `/api/v1/ads/documents/${documentId}/permissions`,
    ],
    [
      "POST",
      `/api/v1/ads/documents/${documentId}/actions/reindex`,
      undefined,
      `/api/v1/ads/documents/${documentId}/actions/reindex`,
    ],
    [
      "POST",
      "/api/v1/ads/knowledge",
      {},
      "/api/v1/ads/knowledge",
    ],
  ] as const;
}

function isMutation(method: string): boolean {
  return method !== "GET";
}

// ENGINE-FIX-B5-2: replaceSourcePermissions/updateDocumentPermissions now
// require a real If-Match header (see requireIfMatch in ./validation) --
// every other mutation case doesn't touch it and stays idempotency-key-only.
function mutationHeaders(
  method: string,
  url: string,
  idempotencyKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "idempotency-key": idempotencyKey,
  };
  if ((method === "PUT" || method === "PATCH") && url.endsWith("/permissions")) {
    headers["if-match"] = '"etag-mutation"';
  }
  return headers;
}

function expectProblem(
  responseValue: TestResponse,
  status: number,
  code: string,
): void {
  expect(responseValue.statusCode).toBe(status);
  expect(responseValue.headers["content-type"]).toContain(
    "application/problem+json",
  );
  expect(responseValue.json()).toMatchObject({
    status,
    error_code: code,
  });
}

interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
  actor?: ActorContextType;
  headers?: Record<string, string> | undefined;
}

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}
