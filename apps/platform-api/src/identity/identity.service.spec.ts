import { describe, expect, it, vi } from "vitest";
import type { IdentityProvider } from "./identity-provider.interface";
import { IdentityService } from "./identity.service";
import { hashToken, InMemorySessionStore } from "./session-store";
import type { StreamRevocationBus } from "../streaming/revocation";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000101";

describe("IdentityService", () => {
  it("forwards provider operations and issues a session without optional metadata", async () => {
    const provider = providerStub();
    const store = new InMemorySessionStore();
    const revocations = {
      publish: vi.fn(),
    } as unknown as StreamRevocationBus;
    const service = new IdentityService(provider, store, revocations);

    await expect(
      service.loginRedirectUrl({ redirectUri: "https://app.test", state: "s", codeChallenge: "c" }),
    ).resolves.toBe("https://identity.test");
    const issued = await service.handleCallback({ code: "c", redirectUri: "u", codeVerifier: "v" });
    await expect(service.authenticateAccessToken(issued.accessToken)).resolves.toMatchObject({
      tenantId,
      userId,
    });
    await expect(service.listActiveSessions(tenantId, userId)).resolves.toEqual([]);
    await service.revokeSession(tenantId, userId, "session-id");
    expect(revocations.publish).toHaveBeenCalledWith({
      tenantId,
      userId,
      sessionId: "session-id",
    });
    await expect(service.enrollMfa(userId)).resolves.toMatchObject({ enrollmentId: "mfa" });
    await expect(service.challengeMfa(userId, "mfa", "123456")).resolves.toMatchObject({
      status: "verified",
    });
    await expect(
      service.configureSso(tenantId, { type: "oidc", issuer: "https://idp.test", clientId: "id" }),
    ).resolves.toMatchObject({ type: "oidc" });
  });

  it("rejects malformed, unknown, and failed-rotation tokens", async () => {
    const provider = providerStub();
    const store = new InMemorySessionStore();
    const service = new IdentityService(provider, store);

    await expect(service.refreshSession("malformed")).rejects.toMatchObject({
      errorCode: "INVALID_SESSION_TOKEN",
    });
    await expect(service.authenticateAccessToken("malformed")).rejects.toMatchObject({
      errorCode: "INVALID_SESSION_TOKEN",
    });
    await expect(service.refreshSession(`${tenantId}.unknown`)).rejects.toMatchObject({
      errorCode: "INVALID_REFRESH_TOKEN",
    });
    await expect(service.authenticateAccessToken(`${tenantId}.unknown`)).rejects.toMatchObject({
      errorCode: "INVALID_ACCESS_TOKEN",
    });

    const token = `${tenantId}.refresh`;
    const session = await store.create({
      tenantId,
      userId,
      refreshTokenHash: hashToken(token),
      accessTokenHash: "access",
    });
    await store.revoke(tenantId, userId, session.id);
    await expect(service.refreshSession(token)).rejects.toMatchObject({
      errorCode: "INVALID_REFRESH_TOKEN",
    });

    vi.spyOn(store, "findByRefreshTokenHash").mockResolvedValue(session);
    vi.spyOn(store, "rotateRefreshToken").mockResolvedValue(false);
    await expect(new IdentityService(provider, store).refreshSession(token)).rejects.toMatchObject({
      errorCode: "INVALID_REFRESH_TOKEN",
    });
  });
});

function providerStub(): IdentityProvider {
  return {
    createOrganizationInvitation: vi.fn().mockRejectedValue(new Error("Invitation unused by this session fixture")),
    revokeOrganizationInvitation: vi.fn().mockRejectedValue(new Error("Invitation unused by this session fixture")),
    requestPasswordReset: vi.fn().mockRejectedValue(new Error("Reset unused by this session fixture")),
    getOrCreateOrgForTenant: vi.fn(async () => "org"),
    loginRedirectUrl: vi.fn(async () => "https://identity.test"),
    handleCallback: vi.fn(async () => ({
      userId,
      tenantId,
      identityRef: "auth0|user",
      email: "u@test",
      emailVerified: true,
    })),
    refreshSession: vi.fn(),
    listActiveSessions: vi.fn(async () => []),
    revokeSession: vi.fn(async () => undefined),
    enrollMfa: vi.fn(async () => ({ enrollmentId: "mfa", barcodeUri: "uri" })),
    challengeMfa: vi.fn(async () => ({
      challengeId: "challenge",
      status: "verified" as const,
    })),
    configureSso: vi.fn(async (_tenantId, config) => config),
    startDeviceAuthorization: vi.fn(async () => ({
      deviceCode: "device",
      userCode: "USER",
      verificationUri: "https://identity.test/activate",
      expiresIn: 600,
      interval: 5,
    })),
    pollDeviceToken: vi.fn(async () => ({ error: "authorization_pending" as const })),
  };
}
