import { createHash } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";
import { ProblemDetailsSchema } from "@alterx/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELETION_SERVICE_TOKEN_HASH,
  DeletionController,
} from "./deletion.controller";
import { DeletionOrchestrator } from "./deletion-orchestrator";

const TOKEN = "audit-internal-deletion-token";
const execute = vi.fn();
const replayDeletionLedger = vi.fn();
const executeWorkspace = vi.fn();

describe("DeletionController RFC 9457 internal surface", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DeletionController],
      providers: [
        {
          provide: DeletionOrchestrator,
          useValue: { execute, replayDeletionLedger, executeWorkspace },
        },
        {
          provide: DELETION_SERVICE_TOKEN_HASH,
          useValue: createHash("sha256").update(TOKEN).digest("hex"),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    execute.mockReset();
    replayDeletionLedger.mockReset();
    executeWorkspace.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects missing credentials with a sanitized problem response", async () => {
    const response = await request("/internal/deletion/execute", { tenantId: "sensitive-subject" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 401, error_code: "DELETION_AUTHENTICATION_FAILED" });
    expect(JSON.stringify(problem)).not.toContain("sensitive-subject");
    expect(execute).not.toHaveBeenCalled();
  });

  it("erases one workspace only for valid ten_ and ws_ ids, authenticated (D2)", async () => {
    const tenantId = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
    const workspaceId = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
    expect((await request("/internal/deletion/workspace/execute", { tenantId, workspaceId })).statusCode).toBe(401);
    for (const body of [{ tenantId, workspaceId: "ws_nope" }, { tenantId: "nope", workspaceId }, {}]) {
      expect((await request("/internal/deletion/workspace/execute", body, `Bearer ${TOKEN}`)).statusCode).toBe(400);
    }
    expect(executeWorkspace).not.toHaveBeenCalled();
    executeWorkspace.mockResolvedValue({ manifestId: "del_fixture", completed: true });
    const response = await request("/internal/deletion/workspace/execute", { tenantId, workspaceId }, `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(201);
    expect(executeWorkspace).toHaveBeenCalledWith(tenantId, workspaceId);
    executeWorkspace.mockRejectedValue(new Error("Provider deletion verification failed"));
    expect((await request("/internal/deletion/workspace/execute", { tenantId, workspaceId }, `Bearer ${TOKEN}`)).statusCode).toBe(500);
  });

  it("returns an authenticated successful execution", async () => {
    execute.mockResolvedValue({ manifestId: "del_fixture", completed: true });
    const response = await request(
      "/internal/deletion/execute",
      { tenantId: "ten_fixture" },
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ manifestId: "del_fixture", completed: true });
  });

  it("sanitizes unexpected execution and replay failures", async () => {
    execute.mockRejectedValue(new Error("database error containing sensitive-subject"));
    let response = await request(
      "/internal/deletion/execute",
      { tenantId: "sensitive-subject" },
      `Bearer ${TOKEN}`,
    );
    let problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "DELETION_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("sensitive-subject");

    replayDeletionLedger.mockRejectedValue(new Error("sinceTimestamp must be ISO 8601"));
    response = await request(
      "/internal/deletion/replay",
      { sinceTimestamp: "bad" },
      `Bearer ${TOKEN}`,
    );
    problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 400, error_code: "DELETION_VALIDATION_FAILED" });

    replayDeletionLedger.mockRejectedValue(new Error("provider secret"));
    response = await request(
      "/internal/deletion/replay",
      { sinceTimestamp: "2026-07-30T00:00:00.000Z" },
      `Bearer ${TOKEN}`,
    );
    problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "DELETION_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("provider secret");
  });

  it("preserves already-safe HTTP failures and successful replay results", async () => {
    const safe = ProblemDetailsSchema.parse({
      type: "https://alter.dev/problems/deletion-conflict",
      title: "Conflict",
      status: 409,
      detail: "Deletion already running",
      instance: "/internal/deletion/execute",
      error_code: "DELETION_CONFLICT",
      trace_id: "trc_018f4d6e-2b4a-7a3e-8c1a-1234567890a1",
      request_id: "req_018f4d6e-2b4a-7a3e-8c1a-1234567890a2",
      retryable: false,
      field_errors: [],
      documentation_key: "deletion.conflict",
    });
    execute.mockRejectedValue(new HttpException(safe, 409));
    let response = await request(
      "/internal/deletion/execute",
      { tenantId: "ten_fixture" },
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(409);

    replayDeletionLedger.mockResolvedValue({
      store: "audit-service",
      ledgerEntriesReplayed: 1,
      deletedRows: 2,
      deletedObjects: 1,
    });
    response = await request(
      "/internal/deletion/replay",
      { sinceTimestamp: "2026-07-30T00:00:00.000Z" },
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ledgerEntriesReplayed: 1 });
  });

  function request(url: string, payload: object, authorization?: string) {
    return app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url,
      headers: authorization === undefined ? {} : { authorization },
      payload,
    });
  }
});
