import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import { RbacModule, type RbacRequest } from "../rbac";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersRepository } from "./admin-users.repository";
import { AdminUsersService } from "./admin-users.service";
import type { AdminUserView } from "./types";

const userId = "018f47a5-7b2c-7d10-8f11-123456789abc";

function user(overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id: userId,
    email: "person@example.com",
    display_name: null,
    status: "active",
    tenant_ids: [],
    created_at: "2026-09-28T00:00:00.000Z",
    last_seen_at: null,
    active_sessions: 2,
    ...overrides,
  };
}

describe("Admin users routes (task B1.2)", () => {
  let app: NestFastifyApplication;
  const state = { user: user() };
  const repository = {
    list: vi.fn(async () => [state.user]),
    find: vi.fn(async (id: string) => (id === userId ? state.user : undefined)),
    setStatus: vi.fn(async (_id: string, status: "active" | "suspended") => {
      state.user = { ...state.user, status };
      return true;
    }),
    revokeSessions: vi.fn(async () => {
      const revoked = state.user.active_sessions;
      state.user = { ...state.user, active_sessions: 0 };
      return revoked;
    }),
    recordAction: vi.fn(async () => undefined),
    listActions: vi.fn(async () => []),
  };
  const audit = { record: vi.fn(async () => "a".repeat(64)) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdminUsersController],
      providers: [
        AdminUsersService,
        { provide: AdminUsersRepository, useValue: repository },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply, done) => {
      const value = request.headers["x-test-staff"];
      if (typeof value === "string") (request as RbacRequest).staffActorContext = JSON.parse(value);
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    state.user = user();
    vi.clearAllMocks();
  });
  afterAll(async () => app.close());

  const staff = (roles: string[]) =>
    JSON.stringify({ staff_user_id: "stf_1", identity_ref: "auth0|1", email: "ops@alter.example", roles });

  it("lists users for support, security and admins, not billing ops", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { "x-test-staff": staff(["staff_support"]) } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: { "x-test-staff": staff(["staff_billing_ops"]) } })).statusCode).toBe(403);
  });

  it("suspends with a reason: status, every session revoked, history and audit written", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/actions/suspend`,
      headers: { "x-test-staff": staff(["staff_security"]) },
      payload: { reason: "account takeover" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "suspended", active_sessions: 0 });
    expect(repository.revokeSessions).toHaveBeenCalledWith(userId);
    expect(repository.recordAction).toHaveBeenCalledWith(userId, "stf_1", "suspended", "account takeover");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "user.suspend", targetRef: userId }));
  });

  it("refuses a suspension without a reason, and support staff cannot act", async () => {
    expect(
      (await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${userId}/actions/suspend`,
        headers: { "x-test-staff": staff(["staff_admin"]) },
        payload: {},
      })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${userId}/actions/suspend`,
        headers: { "x-test-staff": staff(["staff_support"]) },
        payload: { reason: "x" },
      })).statusCode,
    ).toBe(403);
    expect(repository.setStatus).not.toHaveBeenCalled();
  });

  it("revokes sessions without suspending, and 404s an unknown user", async () => {
    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/actions/revoke-sessions`,
      headers: { "x-test-staff": staff(["staff_admin"]) },
      payload: { reason: "lost laptop" },
    });
    expect(revoked.json()).toEqual({ revoked: 2 });
    expect(repository.setStatus).not.toHaveBeenCalled();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/018f47a5-7b2c-7d10-8f11-000000000000",
      headers: { "x-test-staff": staff(["staff_admin"]) },
    });
    expect(missing.statusCode).toBe(404);
  });
});
