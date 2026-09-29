import { describe, expect, it, vi } from "vitest";
import type { IdentityBrokerService } from "../identity-broker/identity-broker.service";
import {
  Auth0EngineM2mTokenProvider,
  IdentityBrokerEngineAuthProvider,
  type EngineM2mTokenProvider,
} from "./auth";
import { createSystemCallerContext } from "../system-jobs/system-caller";
import type { EngineCallerContext } from "./types";

describe("Auth0EngineM2mTokenProvider", () => {
  it("requests a service-level token, never tenant-scoped, and caches it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "engine-m2m",
          expires_in: 300,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    const resolveSecret = vi.fn().mockResolvedValue("secret-value");
    const provider = new Auth0EngineM2mTokenProvider({
      tokenUrl: "https://identity.test/oauth/token",
      audience: "https://engine.test",
      clientId: "platform-api",
      clientSecretRef: "env:ENGINE_SECRET",
      resolveSecret,
      fetchImpl,
      now: () => 1_000,
    });

    await expect(provider.getAccessToken()).resolves.toBe("engine-m2m");
    await expect(provider.getAccessToken()).resolves.toBe("engine-m2m");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resolveSecret).toHaveBeenCalledWith("env:ENGINE_SECRET");

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      grant_type: "client_credentials",
      audience: "https://engine.test",
    });
    // Regression guard: an Alter tenant id must never reach Auth0 as its
    // `organization` parameter. Auth0 organizations are a different id
    // namespace (`org_...`); sending a tenant UUID makes real Auth0 reject
    // every request with "The client is not permitted to use an organization
    // with this audience", and also fragments the token cache per tenant.
    expect(body).not.toHaveProperty("organization");
  });

  it("rejects failed and malformed token responses", async () => {
    const options = {
      tokenUrl: "https://identity.test/oauth/token",
      audience: "https://engine.test",
      clientId: "platform-api",
      clientSecretRef: "env:ENGINE_SECRET",
      resolveSecret: vi.fn().mockResolvedValue("secret"),
    };
    await expect(
      new Auth0EngineM2mTokenProvider({
        ...options,
        fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
      }).getAccessToken(),
    ).rejects.toThrow("M2M token request failed with status 401");

    await expect(
      new Auth0EngineM2mTokenProvider({
        ...options,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ token: "wrong" }), { status: 200 }),
        ),
      }).getAccessToken(),
    ).rejects.toThrow("M2M token response failed validation");
  });
});

describe("IdentityBrokerEngineAuthProvider", () => {
  it("mints a caller-scoped actor token and pairs it with service M2M auth", async () => {
    const identityBroker = {
      mintActorToken: vi.fn().mockResolvedValue({
        token: "actor-token",
        claims: {},
      }),
    } as unknown as IdentityBrokerService;
    const m2mProvider: EngineM2mTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValue("m2m-token"),
    };
    const provider = new IdentityBrokerEngineAuthProvider(
      identityBroker,
      m2mProvider,
    );
    const context: EngineCallerContext = {
      userId: "user-a",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      authTime: 100,
      roles: ["owner"],
      permissions: ["runs:create"],
      traceparent: "trace",
    };

    await expect(provider.authorize(context)).resolves.toEqual({
      m2mAccessToken: "m2m-token",
      actorToken: "actor-token",
    });
    expect(identityBroker.mintActorToken).toHaveBeenCalledWith({
      userId: "user-a",
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      authTime: 100,
      roles: ["owner"],
      permissions: ["runs:create"],
      callingTenantId: "tenant-a",
    });
    // Tenancy belongs to the actor token above, never to the service
    // credential -- the M2M call takes no arguments at all.
    expect(m2mProvider.getAccessToken).toHaveBeenCalledWith();
  });

  describe("system caller (D1)", () => {
    function setup() {
      const identityBroker = {
        mintActorToken: vi.fn().mockResolvedValue({ token: "user-actor", claims: {} }),
        mintSystemActorToken: vi.fn().mockResolvedValue({ token: "system-actor", claims: {} }),
      };
      const provider = new IdentityBrokerEngineAuthProvider(
        identityBroker as unknown as IdentityBrokerService,
        { getAccessToken: vi.fn().mockResolvedValue("m2m-token") },
      );
      return { identityBroker, provider };
    }

    it("mints the system token for a context made by createSystemCallerContext, for its own tenant", async () => {
      const { identityBroker, provider } = setup();
      const context = createSystemCallerContext({ tenantId: "tenant-a", traceparent: "trace" });

      await expect(provider.authorize(context)).resolves.toEqual({
        m2mAccessToken: "m2m-token",
        actorToken: "system-actor",
      });
      expect(identityBroker.mintSystemActorToken).toHaveBeenCalledWith({
        tenantId: "tenant-a",
        callingTenantId: "tenant-a",
      });
      expect(identityBroker.mintActorToken).not.toHaveBeenCalled();
    });

    it("never treats a look-alike as a system caller, however it is shaped", async () => {
      const { identityBroker, provider } = setup();
      const real = createSystemCallerContext({ tenantId: "tenant-a", traceparent: "trace" });
      const lookAlike: EngineCallerContext = { ...real };

      await provider.authorize(lookAlike);

      expect(identityBroker.mintSystemActorToken).not.toHaveBeenCalled();
      expect(identityBroker.mintActorToken).toHaveBeenCalledOnce();
    });
  });
});
