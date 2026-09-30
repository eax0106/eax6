import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgIdempotencyStore, type IdempotencyExecution, type StoredHttpResponse } from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { WorkspaceExportController } from "./workspace-export.controller";
import { WorkspaceExportModule } from "./workspace-export.module";
import { WorkspaceExportHttpError } from "./problem";
import { WorkspaceExportService } from "./workspace-export.service";

const tenant = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";

const base: ActorContextType = {
  user_id: "usr_admin",
  tenant_id: tenant,
  workspace_id: workspace,
  session_id: "session-a",
  roles: ["admin"],
  permissions: ["workflows:read", "runs:read", "knowledge:read"],
};

const readyExport = {
  id: "exp_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  workspaceId: `ws_${workspace}`,
  status: "ready",
  failureReason: null,
  requestedAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:05:00.000Z",
  expiresAt: "2026-10-07T10:05:00.000Z",
};

// Export routes are workspace-admin reads/writes through the caller's identity.
describe("WorkspaceExport routes (D2, admin only)", () => {
  let app: NestFastifyApplication;
  const service = {
    request: vi.fn(async () => ({ ...readyExport, status: "requested" })),
    list: vi.fn(async () => [readyExport]),
    get: vi.fn(async () => readyExport),
    download: vi.fn(async () => ({ exportedAt: "2026-09-30T10:05:00.000Z", workspaceId: `ws_${workspace}` })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [WorkspaceExportController],
      providers: [
        { provide: WorkspaceExportService, useValue: service },
        {
          provide: PgIdempotencyStore,
          useValue: {
            execute: async (_input: IdempotencyExecution, operation: () => Promise<StoredHttpResponse>) => ({ ...(await operation()), replayed: false }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-test-actor"];
      if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());

  function headers(actor: ActorContextType, extra: Record<string, string> = {}) {
    return { "x-test-actor": JSON.stringify(actor), "idempotency-key": "export-1", ...extra };
  }

  it("lets a workspace admin request, list, read and download", async () => {
    const post = await app.inject({ method: "POST", url: `/api/v1/workspaces/ws_${workspace}/exports`, headers: headers(base), payload: {} });
    expect(post.statusCode).toBe(201);
    expect(service.request).toHaveBeenCalledWith(expect.objectContaining({ user_id: "usr_admin" }), `ws_${workspace}`);
    const list = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports`, headers: headers(base) });
    expect(list.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports/${readyExport.id}`, headers: headers(base) });
    expect(get.statusCode).toBe(200);
    const download = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports/${readyExport.id}/download`, headers: headers(base) });
    expect(download.statusCode).toBe(200);
  });

  it("refuses editors and viewers on every route", async () => {
    const editor = { ...base, roles: ["editor"] };
    const viewer = { ...base, roles: ["viewer"] };
    for (const actor of [editor, viewer]) {
      const post = await app.inject({ method: "POST", url: `/api/v1/workspaces/ws_${workspace}/exports`, headers: headers(actor), payload: {} });
      expect(post.statusCode).toBe(403);
      const list = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports`, headers: headers(actor) });
      expect(list.statusCode).toBe(403);
      const download = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports/${readyExport.id}/download`, headers: headers(actor) });
      expect(download.statusCode).toBe(403);
    }
    expect(service.request).not.toHaveBeenCalled();
    expect(service.download).not.toHaveBeenCalled();
  });

  it("refuses an admin without the read permission", async () => {
    const denied = { ...base, permissions: ["runs:read"] };
    const post = await app.inject({ method: "POST", url: `/api/v1/workspaces/ws_${workspace}/exports`, headers: headers(denied), payload: {} });
    expect(post.statusCode).toBe(403);
    expect(service.request).not.toHaveBeenCalled();
  });

  it("surfaces the service's not-found as 404", async () => {
    service.get.mockRejectedValueOnce(new WorkspaceExportHttpError(404, "EXPORT_NOT_FOUND", "Export not found", "x"));
    const get = await app.inject({ method: "GET", url: `/api/v1/workspaces/ws_${workspace}/exports/exp_018f4d6e-2b4a-7a3e-8c1a-1234567890ab`, headers: headers(base) });
    expect(get.statusCode).toBe(404);
  });

  it("is registered in the production module", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, WorkspaceExportModule)).toContain(WorkspaceExportController);
  });
});
