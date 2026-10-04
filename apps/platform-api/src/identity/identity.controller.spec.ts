import { createHash } from "node:crypto";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MembershipIdentityResolver } from "./membership-identity-resolver";
import { MockIdentityProvider } from "./adapters/mock/mock-identity-provider";
import { IDENTITY_PROVIDER, IdentityModule } from "./identity.module";
import { UserProfileRepository } from "./user-profile.repository";

describe("IdentityController", () => {
  let app: NestFastifyApplication;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.IDENTITY_PROVIDER = "mock";
    process.env.INTERNAL_SERVICE_TOKEN_SHA256 = createHash("sha256")
      .update("identity-controller-test-service-token")
      .digest("hex");

    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule],
    }).overrideProvider(MembershipIdentityResolver).useValue({
      // Cookie/controller unit fixture; native invitation specs prove database resolution.
      resolve: async (identity: { userId: string; tenantId: string }) => ({ userId: identity.userId, tenantId: identity.tenantId,
        workspaceId: "00000000-0000-7000-8000-000000000101", tenantRole: "member", workspaceRole: "viewer" }),
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.INTERNAL_SERVICE_TOKEN_SHA256;
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  it("returns the Universal Login URL as JSON", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        redirectUri: "https://app.test/callback",
        state: "state",
        codeChallenge: "challenge",
        connection: "google-oauth2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).url).toContain("mock.identity.local/authorize");
  });

  it("sets secure HttpOnly cookies on callback", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/callback?code=user:00000000-0000-7000-8000-000000000201&redirect_uri=https://app.test/callback&code_verifier=verifier",
    });

    expect(response.statusCode).toBe(200);
    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
    }
  });

  it("rotates refresh token and rejects reused old token", async () => {
    const callback = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/callback?code=user:00000000-0000-7000-8000-000000000202&redirect_uri=https://app.test/callback&code_verifier=verifier",
    });
    const refreshCookie = callback.cookies.find(
      (cookie) => cookie.name === "alter_refresh",
    );
    expect(refreshCookie?.value).toBeTruthy();

    const refresh = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: refreshCookie?.value },
    });
    expect(refresh.statusCode).toBe(200);

    const reused = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: refreshCookie?.value },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({
      error_code: "INVALID_REFRESH_TOKEN",
      status: 401,
    });
  });

  it("revokes one session without affecting another session", async () => {
    const first = await createSession("00000000-0000-7000-8000-000000000203");
    const second = await createSession("00000000-0000-7000-8000-000000000203");

    const list = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `alter_access=${first.access}` },
    });
    const sessionId = list.json().sessions[0].id;

    const revoke = await app.getHttpAdapter().getInstance().inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${sessionId}`,
      headers: { cookie: `alter_access=${first.access}` },
    });
    expect(revoke.statusCode).toBe(204);

    const firstAfterRevoke = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `alter_access=${first.access}` },
    });
    expect(firstAfterRevoke.statusCode).toBe(401);

    const secondAfterRevoke = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `alter_access=${second.access}` },
    });
    expect(secondAfterRevoke.statusCode).toBe(200);
  });

  it("does not log cookie token values on failures", async () => {
    const token = "super-secret-token-value";
    await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `alter_access=${token}` },
    });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(token));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(token));
  });

  it("returns problem details for invalid requests and missing cookies", async () => {
    const cases: Array<{
      method: "GET" | "POST";
      url: string;
      payload?: Record<string, unknown>;
      code: string;
    }> = [
      { method: "POST", url: "/api/v1/auth/login", payload: {}, code: "INVALID_REQUEST_BODY" },
      { method: "GET", url: "/api/v1/auth/callback", code: "INVALID_CALLBACK" },
      { method: "POST", url: "/api/v1/auth/refresh", payload: {}, code: "REFRESH_TOKEN_REQUIRED" },
      { method: "GET", url: "/api/v1/auth/sessions", code: "ACCESS_TOKEN_REQUIRED" },
      {
        method: "POST",
        url: "/api/v1/auth/mfa/challenge",
        payload: {},
        code: "INVALID_REQUEST_BODY",
      },
    ];

    for (const testCase of cases) {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: testCase.method,
        url: testCase.url,
        ...(testCase.payload ? { payload: testCase.payload } : {}),
      });
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ error_code: testCase.code });
    }
  });

  it("refreshes from cookies and clears cookies on logout", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000204");
    const refresh = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: `ignored=x; alter_refresh=${session.refresh}` },
      payload: {},
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedAccess = refresh.cookies.find((cookie) => cookie.name === "alter_access")?.value;
    expect(rotatedAccess).toBeTruthy();

    const logout = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: `alter_access=${rotatedAccess}` },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("Max-Age=0")]),
    );

    const anonymousLogout = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/logout",
    });
    expect(anonymousLogout.statusCode).toBe(204);
  });

  it("handles MFA and restricts SSO configuration to internal calls", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000205");
    const cookie = { cookie: `alter_access=${session.access}` };
    const enrollment = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll",
      headers: cookie,
      payload: {},
    });
    expect(enrollment.statusCode).toBe(200);

    const targetOverride = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/mfa/enroll",
      headers: cookie,
      payload: { userId: "00000000-0000-7000-8000-000000000999" },
    });
    expect(targetOverride.statusCode).toBe(400);
    expect(targetOverride.json()).toMatchObject({
      error_code: "MFA_TARGET_OVERRIDE_FORBIDDEN",
    });

    const challenge = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      headers: cookie,
      payload: { enrollmentId: enrollment.json().enrollmentId, otp: "000000" },
    });
    expect(challenge.json()).toMatchObject({ status: "rejected" });

    const challengeTargetOverride = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/mfa/challenge",
      headers: cookie,
      payload: {
        userId: "00000000-0000-7000-8000-000000000999",
        enrollmentId: enrollment.json().enrollmentId,
        otp: "000000",
      },
    });
    expect(challengeTargetOverride.statusCode).toBe(400);
    expect(challengeTargetOverride.json()).toMatchObject({
      error_code: "MFA_TARGET_OVERRIDE_FORBIDDEN",
    });

    const forbidden = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/sso/configure",
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const spoofed = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/sso/configure",
      headers: { "x-alter-internal": "true" },
      payload: {
        tenantId: "00000000-0000-7000-8000-000000000001",
        config: { type: "saml", metadataUrl: "https://idp.test/metadata" },
      },
    });
    expect(spoofed.statusCode).toBe(403);

    const configured = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/sso/configure",
      headers: { authorization: "Bearer identity-controller-test-service-token" },
      payload: {
        tenantId: "00000000-0000-7000-8000-000000000001",
        config: { type: "saml", metadataUrl: "https://idp.test/metadata" },
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().config).toMatchObject({ type: "saml" });

    const wrongToken = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/api/v1/auth/sso/configure",
      headers: { authorization: "Bearer some-other-well-formed-token" },
      payload: {
        tenantId: "00000000-0000-7000-8000-000000000001",
        config: { type: "saml", metadataUrl: "https://idp.test/metadata" },
      },
    });
    expect(wrongToken.statusCode).toBe(403);
    expect(wrongToken.json()).toMatchObject({ error_code: "SSO_CONFIG_FORBIDDEN" });
  });

  it("signs out every other session of the user and keeps the current one", async () => {
    const userId = "00000000-0000-7000-8000-000000000207";
    const current = await createSession(userId);
    const other = await createSession(userId);
    const third = await createSession(userId);
    const bystander = await createSession("00000000-0000-7000-8000-000000000208");

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions",
      headers: { cookie: `alter_access=${current.access}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 2 });

    const statusWith = async (access: string) =>
      (await app.getHttpAdapter().getInstance().inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        headers: { cookie: `alter_access=${access}` },
      })).statusCode;
    expect(await statusWith(current.access)).toBe(200);
    expect(await statusWith(other.access)).toBe(401);
    expect(await statusWith(third.access)).toBe(401);
    expect(await statusWith(bystander.access)).toBe(200);
  });

  it("refuses an empty or oversized profile name before touching the profile", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000209");
    for (const payload of [{}, { name: "   " }, { name: "x".repeat(121) }, { name: 7 }]) {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "PATCH",
        url: "/api/v1/auth/me",
        headers: { cookie: `alter_access=${session.access}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error_code: "INVALID_PROFILE" });
    }
    const noBody = await app.getHttpAdapter().getInstance().inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: { cookie: `alter_access=${session.access}` },
    });
    expect(noBody.statusCode).toBe(400);
  });

  it("saves a valid profile name and answers 404 when the user has no profile row", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000210");
    const missing = await app.getHttpAdapter().getInstance().inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: { cookie: `alter_access=${session.access}` },
      payload: { name: "Ada" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error_code: "USER_NOT_FOUND" });

    const repository = app.get(UserProfileRepository);
    const update = vi.spyOn(repository, "updateDisplayName").mockResolvedValueOnce({
      id: "00000000-0000-7000-8000-000000000210",
      identity_ref: "auth0|ada",
      email: "ada@acme.test",
      display_name: "Ada",
    });
    const saved = await app.getHttpAdapter().getInstance().inject({
      method: "PATCH",
      url: "/api/v1/auth/me",
      headers: { cookie: `alter_access=${session.access}` },
      payload: { name: "  Ada  " },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ email: "ada@acme.test", name: "Ada" });
    expect(update).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000210", "Ada");
  });

  it("returns 404 when the authenticated user has no profile row", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000206");

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `alter_access=${session.access}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error_code: "USER_NOT_FOUND" });
  });

  it("requests provider password reset only for the authenticated profile email", async () => {
    const session = await createSession("00000000-0000-7000-8000-000000000211");
    vi.spyOn(app.get(UserProfileRepository), "findById").mockResolvedValue({ id: "00000000-0000-7000-8000-000000000211", identity_ref: "mock|ada", email: "ada@company.test", display_name: "Ada" });
    const response = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/api/v1/auth/password-reset", headers: { cookie: `alter_access=${session.access}` }, payload: { email: "foreign@company.test", userId: "another-user", password: "never-stored" } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ requested: true });
    expect(app.get<MockIdentityProvider>(IDENTITY_PROVIDER).passwordResetRequests).toEqual(["ada@company.test"]);
  });
  it("refuses anonymous/social/missing-profile reset and keeps provider failure visible", async () => {
    const http = app.getHttpAdapter().getInstance(), provider = app.get<MockIdentityProvider>(IDENTITY_PROVIDER);
    expect((await http.inject({ method: "POST", url: "/api/v1/auth/password-reset" })).statusCode).toBe(401);
    const session = await createSession("00000000-0000-7000-8000-000000000212"), headers = { cookie: `alter_access=${session.access}` };
    expect((await http.inject({ method: "POST", url: "/api/v1/auth/password-reset", headers })).statusCode).toBe(404);
    const profile = vi.spyOn(app.get(UserProfileRepository), "findById").mockResolvedValue({ id: "00000000-0000-7000-8000-000000000212", identity_ref: "google-oauth2|ada", email: "ada@company.test", display_name: "Ada" });
    const social = await http.inject({ method: "POST", url: "/api/v1/auth/password-reset", headers }); expect(social.statusCode).toBe(400); expect(social.json()).toMatchObject({ error_code: "PROVIDER_PASSWORD_REQUIRED" });
    profile.mockResolvedValue({ id: "00000000-0000-7000-8000-000000000212", identity_ref: "mock|ada", email: "ada@company.test", display_name: "Ada" });
    vi.spyOn(provider, "requestPasswordReset").mockRejectedValueOnce(new Error("provider unavailable"));
    const failed = await http.inject({ method: "POST", url: "/api/v1/auth/password-reset", headers }); expect(failed.statusCode).toBe(500); expect(failed.json()).not.toHaveProperty("requested");
    expect(provider.passwordResetRequests).toEqual([]);
  });
  async function createSession(userId: string): Promise<{ access: string; refresh: string }> {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: `/api/v1/auth/callback?code=user:${userId}&redirect_uri=https://app.test/callback&code_verifier=verifier`,
    });

    return {
      access: response.cookies.find((cookie) => cookie.name === "alter_access")?.value ?? "",
      refresh:
        response.cookies.find((cookie) => cookie.name === "alter_refresh")?.value ?? "",
    };
  }
});
