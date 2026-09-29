import { generateKeyPairSync } from "node:crypto";
import { SystemActorTokenClaimsSchema } from "@alterx/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineHealthTransport } from "./engine-health.client";
import { EngineHealthClient } from "./engine-health.client";
import { identityBrokerProblem, IdentityBrokerError } from "./identity-broker.error";
import { IdentityBrokerService, serviceUserId } from "./identity-broker.service";
import { decodeActorToken, verifyActorToken } from "./jwt";
import { StaticSigningKeyResolver } from "./signing-key-resolver";

const tenantId = "00000000-0000-7000-8000-000000000001";
const workspaceId = "00000000-0000-7000-8000-000000000101";
const userId = "00000000-0000-7000-8000-000000000201";
const sessionId = "00000000-0000-7000-8000-000000000301";
const signingKeyRef = "test/actor-token-signing-key";

describe("IdentityBrokerService", () => {
  let service: IdentityBrokerService;
  let publicKey: string;
  let privateKey: string;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    const generated = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    service = new IdentityBrokerService(
      signingKeyRef,
      new StaticSigningKeyResolver(privateKey, publicKey),
      () => 1_785_000_000,
    );
    logSpy.mockClear();
    errorSpy.mockClear();
  });

  it("mints human actor token with exact claim shape", async () => {
    const minted = await service.mintActorToken({
      userId,
      tenantId,
      workspaceId,
      sessionId,
      authTime: 1_784_999_900,
      roles: ["owner"],
      permissions: ["workflow:read"],
      callingTenantId: tenantId,
    });
    const decoded = decodeActorToken(minted.token);

    expect(Object.keys(decoded).sort()).toEqual(
      [
        "aud",
        "auth_time",
        "exp",
        "iat",
        "iss",
        "jti",
        "permissions",
        "roles",
        "session_id",
        "tenant_id",
        "user_id",
        "workspace_id",
      ].sort(),
    );
    expect(decoded).toMatchObject({
      user_id: `usr_${userId}`,
      tenant_id: `ten_${tenantId}`,
      workspace_id: `ws_${workspaceId}`,
      roles: ["owner"],
      permissions: ["workflow:read"],
      session_id: sessionId,
      auth_time: 1_784_999_900,
      iss: "alter-platform-api.identity-broker",
      aud: "alter-engine",
      iat: 1_785_000_000,
      exp: 1_785_000_300,
    });
    expect(verifyActorToken(minted.token, publicKey)).toBe(true);
  });

  it("hard-caps expiry at exactly 300 seconds", async () => {
    const minted = await mintHuman();

    expect(minted.claims.exp - minted.claims.iat).toBe(300);
  });

  it("generates unique jti values", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 100 }, () => mintHuman()),
    );
    const jtis = new Set(tokens.map((token) => token.claims.jti));

    expect(jtis.size).toBe(100);
  });

  it("mints service actor token without fabricated human user id", async () => {
    const minted = await service.mintServiceActorToken({
      serviceName: "platform-workers",
      tenantId,
      permissions: ["runs:dispatch"],
      callingTenantId: tenantId,
    });

    expect(minted.claims.user_id).toBe("svc_platform_workers");
    expect(minted.claims.roles).toEqual(["service"]);
    expect(minted.claims.workspace_id).toBe("workspace_system");
    expect(minted.claims.user_id).not.toBe(userId);
  });

  it("preserves explicit service workspace and defaults permissions", async () => {
    const minted = await service.mintServiceActorToken({
      serviceName: "platform-workers",
      tenantId,
      workspaceId,
      callingTenantId: tenantId,
    });

    expect(minted.claims.workspace_id).toBe(`ws_${workspaceId}`);
    expect(minted.claims.permissions).toEqual([]);
  });

  it("rejects tenant scope mismatch at mint time", async () => {
    await expect(
      service.mintActorToken({
        userId,
        tenantId,
        workspaceId,
        sessionId,
        authTime: 1_784_999_900,
        roles: ["owner"],
        permissions: [],
        callingTenantId: "00000000-0000-7000-8000-000000000999",
      }),
    ).rejects.toBeInstanceOf(IdentityBrokerError);
  });

  it("does not log signing key material", async () => {
    await expect(mintHuman()).resolves.toBeTruthy();

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(privateKey));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(privateKey));
  });

  it("passes minted token to Engine health transport", async () => {
    let actorToken = "";
    const transport: EngineHealthTransport = {
      getHealth: async (headers) => {
        actorToken = headers["X-Alter-Actor-Token"] ?? "";
        return { status: "ok" };
      },
    };
    const client = new EngineHealthClient(service, transport);

    await expect(
      client.getHealthWithActor({
        userId,
        tenantId,
        workspaceId,
        sessionId,
        authTime: 1_784_999_900,
        roles: ["owner"],
        permissions: [],
        callingTenantId: tenantId,
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(verifyActorToken(actorToken, publicKey)).toBe(true);
  });

  async function mintHuman() {
    return service.mintActorToken({
      userId,
      tenantId,
      workspaceId,
      sessionId,
      authTime: 1_784_999_900,
      roles: ["owner"],
      permissions: [],
      callingTenantId: tenantId,
    });
  }
});

describe("service actor naming", () => {
  it("normalizes service actor ids", () => {
    expect(serviceUserId("Platform Workers")).toBe("svc_platform_workers");
  });

  it("uses default clock when none is injected", async () => {
    const generated = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const before = Math.floor(Date.now() / 1000);
    const defaultClockService = new IdentityBrokerService(
      signingKeyRef,
      new StaticSigningKeyResolver(generated.privateKey, generated.publicKey),
    );
    const minted = await defaultClockService.mintServiceActorToken({
      serviceName: "clock",
      tenantId,
      callingTenantId: tenantId,
    });
    expect(minted.claims.iat).toBeGreaterThanOrEqual(before);
  });
});

describe("IdentityBrokerService system caller (D1)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const service = new IdentityBrokerService(
    signingKeyRef,
    new StaticSigningKeyResolver(privateKey, publicKey),
    () => 1_785_000_000,
  );

  it("mints a one-tenant, read-only system token with no user and no workspace", async () => {
    const minted = await service.mintSystemActorToken({ tenantId, callingTenantId: tenantId });
    const decoded = decodeActorToken(minted.token) as unknown as Record<string, unknown>;

    expect(verifyActorToken(minted.token, publicKey)).toBe(true);
    expect(Object.keys(decoded).sort()).toEqual(
      ["aud", "auth_time", "exp", "iat", "iss", "jti", "permissions", "principal", "principal_type", "tenant_id"],
    );
    expect(decoded).toMatchObject({
      principal_type: "system",
      principal: "system:platform-jobs",
      tenant_id: expect.stringMatching(/^ten_/),
      aud: "alter-engine",
      iat: 1_785_000_000,
      exp: 1_785_000_300,
    });
    expect(SystemActorTokenClaimsSchema.safeParse(decoded).success).toBe(true);
    expect((decoded.permissions as string[]).every((p) => p.endsWith(":read"))).toBe(true);
  });

  it("mints a fresh single-use token every time", async () => {
    const a = await service.mintSystemActorToken({ tenantId, callingTenantId: tenantId });
    const b = await service.mintSystemActorToken({ tenantId, callingTenantId: tenantId });
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it("refuses a tenant other than the calling one", async () => {
    await expect(
      service.mintSystemActorToken({ tenantId, callingTenantId: "00000000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ errorCode: "ACTOR_TOKEN_TENANT_MISMATCH" });
  });
});

describe("identity broker problem details", () => {
  it("maps tenant errors and unknown failures", () => {
    expect(
      identityBrokerProblem(
        new IdentityBrokerError("ACTOR_TOKEN_TENANT_MISMATCH", "Access denied"),
        "/broker",
      ),
    ).toMatchObject({ status: 403, detail: "Access denied" });
    expect(identityBrokerProblem(new Error("hidden"), "/broker")).toMatchObject({
      status: 500,
      detail: "Actor token minting failed",
      error_code: "ACTOR_TOKEN_MINT_FAILED",
    });
  });
});
