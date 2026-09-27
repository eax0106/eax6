import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RbacExceptionFilter, RbacModule, type RbacRequest } from "../rbac";
import { STAFF_SESSION_FETCH, StaffSessionController } from "./staff-session.controller";
import { StaffService } from "./staff.service";

describe("StaffSessionController", () => {
  let app: NestFastifyApplication;
  const staff = { resolve: vi.fn() };
  const fetchImpl = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [StaffSessionController],
      providers: [
        { provide: StaffService, useValue: staff },
        { provide: STAFF_SESSION_FETCH, useValue: fetchImpl },
        { provide: APP_FILTER, useClass: RbacExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply, done) => {
      const staffHeader = request.headers["x-test-staff"];
      if (typeof staffHeader === "string") (request as RbacRequest).staffActorContext = JSON.parse(staffHeader);
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    staff.resolve.mockReset();
    fetchImpl.mockReset();
    vi.stubEnv("AUTH0_STAFF_DOMAIN", "staff.example.auth0.com");
    vi.stubEnv("AUTH0_STAFF_CLIENT_ID", "staff-client");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => app.close());

  it("builds a PKCE authorize URL on the staff tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/login",
      payload: { redirectUri: "https://app.example/staff/callback", state: "s1", codeChallenge: "c1" },
    });
    expect(response.statusCode).toBe(200);
    const url = new URL(response.json().url);
    expect(url.host).toBe("staff.example.auth0.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "staff-client",
      code_challenge: "c1",
      code_challenge_method: "S256",
      state: "s1",
      response_type: "code",
    });
  });

  it("sets an HttpOnly staff cookie only for a recognised staff member", async () => {
    fetchImpl.mockResolvedValue(Response.json({ access_token: "staff-token", expires_in: 3600 }));
    staff.resolve.mockResolvedValue({ id: "stf_1", email: "ops@alter.example", roles: ["staff_admin"] });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session/callback?code=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fstaff%2Fcallback&code_verifier=v1",
    });
    expect(response.statusCode).toBe(200);
    expect(staff.resolve).toHaveBeenCalledWith("staff-token");
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("alter_staff_access=staff-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://staff.example.auth0.com/oauth/token");
    expect(JSON.parse(String(init.body))).toMatchObject({ grant_type: "authorization_code", code: "abc", code_verifier: "v1" });
  });

  it("refuses an Auth0 account that is not a staff member and sets no cookie", async () => {
    fetchImpl.mockResolvedValue(Response.json({ access_token: "someone-token" }));
    staff.resolve.mockResolvedValue(undefined);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session/callback?code=abc&redirect_uri=https%3A%2F%2Fapp.example&code_verifier=v1",
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("sets no cookie when the identity provider rejects the code", async () => {
    fetchImpl.mockResolvedValue(new Response("{}", { status: 400 }));
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session/callback?code=bad&redirect_uri=https%3A%2F%2Fapp.example&code_verifier=v1",
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(staff.resolve).not.toHaveBeenCalled();
  });

  it("reports staff sign-in as unavailable when the staff tenant is not configured", async () => {
    vi.stubEnv("AUTH0_STAFF_DOMAIN", "");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/login",
      payload: { redirectUri: "https://app.example", state: "s", codeChallenge: "c" },
    });
    expect(response.statusCode).toBe(503);
  });

  it("returns the signed-in staff member, and refuses without one", async () => {
    const who = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session",
      headers: { "x-test-staff": JSON.stringify({ staff_user_id: "stf_1", identity_ref: "auth0|1", email: "ops@alter.example", roles: ["staff_support"] }) },
    });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toEqual({ staffUserId: "stf_1", email: "ops@alter.example", roles: ["staff_support"] });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/session" })).statusCode).toBe(403);
  });

  it("clears the cookie on logout", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/session/logout" });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toContain("alter_staff_access=; Max-Age=0");
  });
});
