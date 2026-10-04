import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../../session-store";
import { InMemorySsoConfigStore } from "../../sso-config-store";
import { Auth0IdentityProvider } from "./auth0-identity-provider";

function provider(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return new Auth0IdentityProvider(
    {
      domain: "tenant.auth0.test",
      clientId: "client-id",
      fetchImpl,
      ...options,
    },
    new InMemorySessionStore(),
    new InMemorySsoConfigStore(),
  );
}

describe("Auth0IdentityProvider edge behavior", () => {
  it("uses Auth0 Device Authorization Flow endpoints and preserves polling states", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const auth0 = provider(
      (async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: input.toString(), init });
        if (input.toString().endsWith("/oauth/device/code")) {
          return response({ device_code: "device", user_code: "USER", verification_uri: "https://auth.test/activate", expires_in: 600, interval: 5 });
        }
        return response({ error: "slow_down" }, 400);
      }) as typeof fetch,
    );
    await expect(auth0.startDeviceAuthorization()).resolves.toMatchObject({ deviceCode: "device", userCode: "USER" });
    await expect(auth0.pollDeviceToken("device")).resolves.toEqual({ error: "slow_down" });
    expect(requests[0]?.init.body).toContain("client_id=client-id");
    expect(requests[1]?.init.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  it("returns a complete device authorization and issued token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const auth0 = provider(
      (async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: input.toString(), init });
        if (input.toString().endsWith("/oauth/device/code")) {
          return response({
            device_code: "device",
            user_code: "USER",
            verification_uri: "https://auth.test/activate",
            verification_uri_complete: "https://auth.test/activate?user_code=USER",
            expires_in: 600,
            interval: 5,
          });
        }
        return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      }) as typeof fetch,
    );

    await expect(auth0.startDeviceAuthorization()).resolves.toEqual({
      deviceCode: "device",
      userCode: "USER",
      verificationUri: "https://auth.test/activate",
      verificationUriComplete: "https://auth.test/activate?user_code=USER",
      expiresIn: 600,
      interval: 5,
    });
    await expect(auth0.pollDeviceToken("device")).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
    expect(requests[1]?.init.body).toContain("device_code=device");
  });

  it.each(["authorization_pending", "slow_down", "expired_token", "access_denied"])(
    "preserves the Auth0 %s device polling state",
    async (error) => {
      const auth0 = provider((async () => response({ error }, 400)) as typeof fetch);
      await expect(auth0.pollDeviceToken("device")).resolves.toEqual({ error });
    },
  );

  it("fails closed for invalid or unexpected device flow responses", async () => {
    const invalidAuthorization = provider(
      (async () => response({ user_code: "USER", verification_uri: "https://auth.test/activate", expires_in: 600, interval: 5 })) as typeof fetch,
    );
    await expect(invalidAuthorization.startDeviceAuthorization()).rejects.toThrow(
      "Auth0 device authorization response was invalid",
    );

    const invalidToken = provider(
      (async () => response({ access_token: "access" })) as typeof fetch,
    );
    await expect(invalidToken.pollDeviceToken("device")).rejects.toThrow(
      "Auth0 device token response was invalid",
    );

    const unexpectedError = provider(
      (async () => response({ error: "invalid_grant" }, 400)) as typeof fetch,
    );
    await expect(unexpectedError.pollDeviceToken("device")).rejects.toThrow(
      "Auth0 request failed with status 400",
    );
  });

  it("supports refresh and profile claim fallbacks without an interactive secret", async () => {
    const fetchStub = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/oauth/token")) return response({ access_token: "access" });
      if (url.endsWith("/userinfo")) {
        return response({
          sub: "auth0|fallback",
          email: "fallback@example.com",
          org_id: "org-fallback",
        });
      }
      return response({}, 404);
    }) as typeof fetch;
    const auth0 = provider(fetchStub);

    const redirect = await auth0.loginRedirectUrl({
      redirectUri: "https://app.test/callback",
      state: "state",
      codeChallenge: "challenge",
    });
    expect(redirect).not.toContain("organization=");
    expect(redirect).not.toContain("connection=");
    await expect(
      auth0.refreshSession("refresh-token"),
    ).resolves.toEqual({
      userId: "auth0|fallback",
      tenantId: "org-fallback",
      organizationId: "org-fallback",
      identityRef: "auth0|fallback",
      email: "fallback@example.com",
      emailVerified: false,
    });
  });

  it("maps rejected MFA challenges", async () => {
    const auth0 = provider(
      (async () => response({ id: "challenge", status: "rejected" })) as typeof fetch,
    );
    await expect(auth0.challengeMfa("user", "mfa", "000000")).resolves.toEqual({
      challengeId: "challenge",
      status: "rejected",
    });
  });

  it("fails closed when management credentials or secret resolution are unavailable", async () => {
    const unusedFetch = (async () => response({})) as typeof fetch;
    await expect(provider(unusedFetch).getOrCreateOrgForTenant("tenant", "Tenant")).rejects.toThrow(
      "management credentials unavailable",
    );
    await expect(
      provider(unusedFetch, {
        m2mClientId: "m2m",
        m2mClientSecretRef: "env:MISSING",
      }).getOrCreateOrgForTenant("tenant", "Tenant"),
    ).rejects.toThrow("secret resolver unavailable");
  });

  it("surfaces unsuccessful Auth0 HTTP responses", async () => {
    const auth0 = provider((async () => response({}, 503)) as typeof fetch);
    await expect(
      auth0.handleCallback({ code: "code", redirectUri: "uri", codeVerifier: "verifier" }),
    ).rejects.toThrow("Auth0 request failed with status 503");
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
