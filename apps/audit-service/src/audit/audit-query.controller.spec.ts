import { createHash } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import { ProblemDetailsSchema } from "@alterx/contracts";
import { AuditValidationError } from "@alterx/shared-clients";
import { ServiceAuthGuard, type M2mValidator } from "@alterx/auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_QUERY_SERVICE_TOKEN_HASH,
  AuditQueryController,
} from "./audit-query.controller";
import { AuditService } from "./audit.service";

const TOKEN = "audit-internal-query-token";
const queryEvents = vi.fn();
const recordEvent = vi.fn();
const verifyChain = vi.fn();
const verifyChainIncremental = vi.fn();

describe("AuditQueryController RFC 9457 internal surface", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditQueryController],
      providers: [
        {
          provide: AuditService,
          useValue: { queryEvents, recordEvent, verifyChain, verifyChainIncremental },
        },
        {
          provide: AUDIT_QUERY_SERVICE_TOKEN_HASH,
          useValue: createHash("sha256").update(TOKEN).digest("hex"),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    queryEvents.mockReset();
    recordEvent.mockReset();
    verifyChain.mockReset();
    verifyChainIncremental.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects missing credentials with a sanitized problem response", async () => {
    const response = await request("/internal/audit-events?tenant_id=ten_sensitive-tenant");
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 401, error_code: "AUDIT_QUERY_AUTHENTICATION_FAILED" });
    expect(JSON.stringify(problem)).not.toContain("sensitive-tenant");
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it("returns an authenticated successful query", async () => {
    queryEvents.mockResolvedValue({ events: [], next_cursor: null });
    const response = await request(
      "/internal/audit-events?tenant_id=ten_018f47a2-7b11-7b11-8a11-1234567890ab",
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [], next_cursor: null });
    expect(queryEvents).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab" }),
    );
  });

  it("records an authenticated audit event", async () => {
    recordEvent.mockResolvedValue({ id: "aud_event", entry_hash: "ab".repeat(32) });
    const body = {
      tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
      actor_type: "admin",
      actor_ref: "stf_ops",
      action: "tenant.suspend",
      target_type: "tenant",
      target_ref: "f0204070-2fd2-4bb7-a117-3222301822fe",
      result: "success",
      reason_code: "policy_violation",
      context_json: JSON.stringify({ scope: "tenant:write" }),
      occurred_at: "2026-08-06T10:00:00.000Z",
    };
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/internal/audit-events",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(recordEvent).toHaveBeenCalledWith(body);
  });

  it("maps a recordEvent AuditValidationError to a 400 problem", async () => {
    recordEvent.mockRejectedValue(new AuditValidationError("action is required"));
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/internal/audit-events",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 400, error_code: "AUDIT_QUERY_VALIDATION_FAILED" });
  });

  it("sanitizes an unexpected recordEvent failure", async () => {
    recordEvent.mockRejectedValue(new Error("database error containing connection-string-secret"));
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/internal/audit-events",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "AUDIT_QUERY_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("connection-string-secret");
  });

  it("rejects unauthenticated audit writes", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/internal/audit-events",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("applies the default limit when none is supplied and clamps an oversized limit", async () => {
    queryEvents.mockResolvedValue({ events: [], next_cursor: null });
    await request("/internal/audit-events", `Bearer ${TOKEN}`);
    expect(queryEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));

    queryEvents.mockClear();
    await request("/internal/audit-events?limit=5000", `Bearer ${TOKEN}`);
    expect(queryEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it("rejects a non-integer limit", async () => {
    const response = await request("/internal/audit-events?limit=not-a-number", `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(400);
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it("maps AuditValidationError to a 400 problem without leaking internals", async () => {
    queryEvents.mockRejectedValue(new AuditValidationError("actor_types contains an unsupported value"));
    const response = await request("/internal/audit-events", `Bearer ${TOKEN}`);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 400, error_code: "AUDIT_QUERY_VALIDATION_FAILED" });
  });

  it("sanitizes an unexpected failure", async () => {
    queryEvents.mockRejectedValue(new Error("database error containing connection-string-secret"));
    const response = await request("/internal/audit-events", `Bearer ${TOKEN}`);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "AUDIT_QUERY_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("connection-string-secret");
  });

  it("rejects an unauthenticated verify-chain call", async () => {
    const response = await postVerifyChain("/internal/audit-events/verify-chain");
    expect(response.statusCode).toBe(401);
    expect(verifyChainIncremental).not.toHaveBeenCalled();
  });

  it("returns the verification result, including an invalid chain, as 200", async () => {
    verifyChainIncremental.mockResolvedValue({
      valid: false,
      checkedEvents: 3,
      issue: "hash-mismatch",
      eventId: "aud_018f47a2-7b11-7b11-8a11-1234567890ab",
    });
    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain",
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false, issue: "hash-mismatch" });
    expect(verifyChainIncremental).toHaveBeenCalledWith(500);
  });

  it("applies the default and clamps an oversized verify-chain limit", async () => {
    verifyChainIncremental.mockResolvedValue({ valid: true, checkedEvents: 0 });
    await postVerifyChain("/internal/audit-events/verify-chain", `Bearer ${TOKEN}`);
    expect(verifyChainIncremental).toHaveBeenCalledWith(500);

    verifyChainIncremental.mockClear();
    await postVerifyChain(
      "/internal/audit-events/verify-chain?limit=50000",
      `Bearer ${TOKEN}`,
    );
    expect(verifyChainIncremental).toHaveBeenCalledWith(5_000);
  });

  it("sanitizes an unexpected verify-chain failure", async () => {
    verifyChainIncremental.mockRejectedValue(new Error("database error containing connection-string-secret"));
    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain",
      `Bearer ${TOKEN}`,
    );
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "AUDIT_QUERY_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("connection-string-secret");
  });

  it("rejects a non-integer verify-chain limit", async () => {
    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain?limit=not-a-number",
      `Bearer ${TOKEN}`,
    );
    expect(response.statusCode).toBe(400);
    expect(verifyChainIncremental).not.toHaveBeenCalled();
  });

  it("runs the full chain verification from genesis for an authenticated caller", async () => {
    verifyChain.mockResolvedValue({ valid: true, checkedEvents: 8 });

    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain/full",
      `Bearer ${TOKEN}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, checkedEvents: 8 });
    expect(verifyChain).toHaveBeenCalledOnce();
    expect(verifyChainIncremental).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated full-chain verification", async () => {
    const response = await postVerifyChain("/internal/audit-events/verify-chain/full");

    expect(response.statusCode).toBe(401);
    expect(verifyChain).not.toHaveBeenCalled();
  });

  it("returns a full-chain integrity finding as 200", async () => {
    verifyChain.mockResolvedValue({
      valid: false,
      checkedEvents: 4,
      issue: "hash-mismatch",
      eventId: "aud_018f47a2-7b11-7b11-8a11-1234567890ab",
    });

    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain/full",
      `Bearer ${TOKEN}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false, issue: "hash-mismatch" });
  });

  it("sanitizes an unexpected full-chain verification failure", async () => {
    verifyChain.mockRejectedValue(
      new Error("database error containing connection-string-secret"),
    );
    const response = await postVerifyChain(
      "/internal/audit-events/verify-chain/full",
      `Bearer ${TOKEN}`,
    );

    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 500, error_code: "AUDIT_QUERY_INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("connection-string-secret");
  });

  function postVerifyChain(url: string, authorization?: string) {
    return app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url,
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  function request(url: string, authorization?: string) {
    return app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url,
      headers: authorization === undefined ? {} : { authorization },
    });
  }
});

// ENGINE-FIX-PHASE2-N2 regression: the bug only manifests when the app-wide
// ServiceAuthGuard is actually wired (as it is in real boot, via
// AppModule.register()'s APP_GUARD provider) -- the suite above never
// wires it, so it couldn't have caught this. Wire it here for real,
// alongside the controller, with an M2mValidator stub that unconditionally
// rejects: if @Public() weren't in effect, every request below would 401
// from the guard before the controller's own authorize() ever ran.
describe("AuditQueryController under the real app-wide ServiceAuthGuard", () => {
  let app: NestFastifyApplication;
  const rejectingValidator = {
    validate: vi.fn().mockRejectedValue(new Error("stub: no request should ever reach this")),
  } as unknown as M2mValidator;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditQueryController],
      providers: [
        { provide: AuditService, useValue: { queryEvents, recordEvent, verifyChainIncremental } },
        {
          provide: AUDIT_QUERY_SERVICE_TOKEN_HASH,
          useValue: createHash("sha256").update(TOKEN).digest("hex"),
        },
        { provide: APP_GUARD, useFactory: () => new ServiceAuthGuard(rejectingValidator) },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reaches the controller's own shared-secret check instead of 401'ing from the JWT guard", async () => {
    queryEvents.mockResolvedValue({ events: [], next_cursor: null });
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/internal/audit-events",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(rejectingValidator.validate).not.toHaveBeenCalled();
  });

  it("verify-chain also reaches the controller's own check, not the JWT guard", async () => {
    verifyChainIncremental.mockResolvedValue({ valid: true, checkedEvents: 0 });
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/internal/audit-events/verify-chain",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(rejectingValidator.validate).not.toHaveBeenCalled();
  });

  it("still 401s a request with no credentials at all -- @Public() removes the JWT guard, not authentication", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/internal/audit-events",
    });
    expect(response.statusCode).toBe(401);
  });
});
