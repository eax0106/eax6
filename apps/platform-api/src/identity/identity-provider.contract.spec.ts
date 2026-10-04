import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Auth0IdentityProvider } from "./adapters/auth0/auth0-identity-provider";
import { MockIdentityProvider } from "./adapters/mock/mock-identity-provider";
import type { IdentityProvider } from "./identity-provider.interface";
import { InMemorySessionStore } from "./session-store";
import { InMemorySsoConfigStore } from "./sso-config-store";

function auth0FetchStub(): typeof fetch {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "contract-id" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://tenant.auth0.test/", aud: "client-id", sub: "auth0|123", org_id: "00000000-0000-7000-8000-000000000001", iat: now, exp: now + 60 })).toString("base64url");
  const signed = head + "." + payload;
  const idToken = signed + "." + createSign("RSA-SHA256").update(signed).sign(pair.privateKey).toString("base64url");
  return (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/api/v2/organizations?")) {
      return json({ organizations: [] });
    }
    if (url.endsWith("/api/v2/organizations")) {
      return json({ id: "org_test" });
    }
    if (url.endsWith("/oauth/token")) {
      return json({ access_token: "auth0-access", id_token: idToken });
    }
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "contract-id", alg: "RS256", use: "sig" }] });
    if (url.endsWith("/userinfo")) {
      return json({
        sub: "auth0|123",
        email: "user@example.com",
        email_verified: true,
        name: "User Example",
        org_id: "00000000-0000-7000-8000-000000000001",
        "https://alter.dev/user_id": "00000000-0000-7000-8000-000000000101",
        "https://alter.dev/tenant_id": "00000000-0000-7000-8000-000000000001",
      });
    }
    if (url.endsWith("/api/v2/guardian/enrollments/ticket")) {
      return json({ ticket_id: "ticket_123", ticket_url: "otpauth://example" });
    }
    if (url.endsWith("/mfa/challenge")) {
      return json({ id: "challenge_123", status: "pending" });
    }
    if (url.includes("/api/v2/organizations/")) {
      return json({});
    }

    return json({}, 404);
  }) as typeof fetch;
}

interface ProviderHarness {
  name: string;
  provider: IdentityProvider;
  sessionStore: InMemorySessionStore;
  ssoConfigStore: InMemorySsoConfigStore;
}

function providerHarnesses(): ProviderHarness[] {
  const mockSessions = new InMemorySessionStore();
  const mockSso = new InMemorySsoConfigStore();
  const auth0Sessions = new InMemorySessionStore();
  const auth0Sso = new InMemorySsoConfigStore();

  return [
    {
      name: "mock",
      provider: new MockIdentityProvider(mockSessions, mockSso),
      sessionStore: mockSessions,
      ssoConfigStore: mockSso,
    },
    {
      name: "auth0",
      provider: new Auth0IdentityProvider({
      domain: "tenant.auth0.test",
      clientId: "client-id",
      managementToken: "test-management-token",
      fetchImpl: auth0FetchStub(),
      }, auth0Sessions, auth0Sso),
      sessionStore: auth0Sessions,
      ssoConfigStore: auth0Sso,
    },
  ];
}

describe.each(providerHarnesses())("IdentityProvider contract: $name", (harness) => {
  it("creates orgs, redirects, handles callback, MFA, SSO", async () => {
    const orgId = await harness.provider.getOrCreateOrgForTenant(
      "00000000-0000-7000-8000-000000000001",
      "Tenant A",
    );
    expect(orgId).toBeTruthy();
    if (harness.name === "mock") {
      await expect(
        harness.provider.getOrCreateOrgForTenant(
          "00000000-0000-7000-8000-000000000001",
          "Tenant A",
        ),
      ).resolves.toBe(orgId);
      await expect(harness.provider.refreshSession("refresh")).resolves.toMatchObject({
        tenantId: "00000000-0000-7000-8000-000000000001",
      });
    }

    const redirectUrl = await harness.provider.loginRedirectUrl({
      redirectUri: "https://app.test/callback",
      state: "state",
      codeChallenge: "challenge",
      organizationId: orgId,
      connection: "google-oauth2",
    });
    expect(redirectUrl).toContain("response_type=code");
    expect(redirectUrl).toContain("code_challenge=challenge");

    const identity = await harness.provider.handleCallback({
      code: "code",
      redirectUri: "https://app.test/callback",
      codeVerifier: "verifier",
    });
    expect(identity.email).toContain("@");
    expect(identity.emailVerified).toBe(true);
    expect(identity.tenantId).toBeTruthy();
    expect(identity.userId).toBeTruthy();

    const enrollment = await harness.provider.enrollMfa(identity.userId);
    expect(enrollment.enrollmentId).toBeTruthy();

    const challenge = await harness.provider.challengeMfa(
      identity.userId,
      enrollment.enrollmentId,
      "123456",
    );
    expect(["pending", "verified", "rejected"]).toContain(challenge.status);

    await expect(
      harness.provider.configureSso(identity.tenantId, {
        type: "oidc",
        issuer: "https://idp.test",
        clientId: "client",
        clientSecretRef: "secret/ref",
      }),
    ).resolves.toMatchObject({ type: "oidc" });
    expect(harness.ssoConfigStore.get(identity.tenantId)).toEqual({
      type: "oidc",
      issuer: "https://idp.test",
      clientId: "client",
      clientSecretRef: "secret/ref",
    });
  });

  it("lists and revokes only sessions inside the tenant", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const otherTenantId = "00000000-0000-7000-8000-000000000002";
    const userId = "00000000-0000-7000-8000-000000000101";
    const session = await harness.sessionStore.create({
      tenantId,
      userId,
      refreshTokenHash: "refresh-a",
      accessTokenHash: "access-a",
    });
    await harness.sessionStore.create({
      tenantId: otherTenantId,
      userId,
      refreshTokenHash: "refresh-b",
      accessTokenHash: "access-b",
    });

    await expect(harness.provider.listActiveSessions(tenantId, userId)).resolves.toEqual([
      expect.objectContaining({ id: session.id, tenantId }),
    ]);
    await harness.provider.revokeSession(tenantId, userId, session.id);
    await expect(harness.provider.listActiveSessions(tenantId, userId)).resolves.toEqual([]);
    await expect(
      harness.provider.listActiveSessions(otherTenantId, userId),
    ).resolves.toHaveLength(1);
  });
});

describe("Auth0 management authentication", () => {
  it("resolves secret references and caches an M2M management token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url.endsWith("/oauth/token")) {
        return json({ access_token: "m2m-token", expires_in: 3600 });
      }
      if (url.includes("/api/v2/organizations?")) {
        return json({ organizations: [{ id: "org_existing" }] });
      }
      return json({}, 404);
    }) as typeof fetch;
    const resolvedReferences: string[] = [];
    const provider = new Auth0IdentityProvider(
      {
        domain: "tenant.auth0.test",
        clientId: "client-id",
        m2mClientId: "m2m-client",
        m2mClientSecretRef: "env:AUTH0_M2M_CLIENT_SECRET",
        resolveSecret: async (reference) => {
          resolvedReferences.push(reference);
          return "resolved-secret";
        },
        fetchImpl: fetchStub,
      },
      new InMemorySessionStore(),
      new InMemorySsoConfigStore(),
    );

    await provider.getOrCreateOrgForTenant("tenant-a", "Tenant A");
    await provider.getOrCreateOrgForTenant("tenant-a", "Tenant A");

    expect(resolvedReferences).toEqual(["env:AUTH0_M2M_CLIENT_SECRET"]);
    const tokenRequest = requests.find((request) => request.url.endsWith("/oauth/token"));
    expect(JSON.parse(tokenRequest?.init.body as string)).toEqual({
      grant_type: "client_credentials",
      client_id: "m2m-client",
      client_secret: "resolved-secret",
      audience: "https://tenant.auth0.test/api/v2/",
    });
    const managementRequests = requests.filter((request) =>
      request.url.includes("/api/v2/organizations?"),
    );
    expect(managementRequests).toHaveLength(2);
    expect(managementRequests[0]?.init.headers).toMatchObject({
      Authorization: "Bearer m2m-token",
    });
  });
});

describe("MockIdentityProvider device flow", () => {
  it("returns pending, issued, and expired device states", async () => {
    const provider = new MockIdentityProvider();
    const authorization = await provider.startDeviceAuthorization();

    await expect(provider.pollDeviceToken(authorization.deviceCode)).resolves.toEqual({
      error: "authorization_pending",
    });
    await expect(provider.pollDeviceToken(authorization.deviceCode)).resolves.toMatchObject({
      accessToken: `mock-access-${authorization.deviceCode}`,
      refreshToken: `mock-refresh-${authorization.deviceCode}`,
      expiresIn: 3600,
      tokenType: "Bearer",
    });
    await expect(provider.pollDeviceToken("missing-device-code")).resolves.toEqual({
      error: "expired_token",
    });
  });
});

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
