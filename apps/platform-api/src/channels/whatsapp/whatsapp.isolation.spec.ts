// CONN-ISO: proves WhatsApp accounts cannot be read, operated on, or routed
// across tenants. platform-api never fetches an account by id directly --
// every by-id operation (templates/test-send/health/configuration writes)
// derives the account from WhatsappService.list(context), which is scoped by
// the caller's own EngineCallerContext.tenantId/workspaceId (taken from the
// actor's JWT, never from client input). This fixture simulates Engine
// enforcing that scoping server-side, then proves platform-api's code paths
// respect the boundary: a tenant B context can never resolve a tenant A
// account id, and no mutating Engine call fires for a denied attempt.
import { describe, expect, it, vi } from "vitest";
import type { SecretsProvider } from "@alterx/shared-clients";
import type { EngineCallerContext, EngineClient } from "../../engine";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";
import type { ActorContextType } from "../../rbac";

const tenantAAccount = {
  id: "wac_tenant_a",
  workspaceId: "ws_tenant_a",
  phoneNumberId: "phone_a",
  wabaId: "waba_a",
  accessTokenRef: "secret://tenant-a-token",
  status: "connected" as const,
  escalationRules: [{ id: "wer_a1", target: "on-call-a" }],
};
const tenantBAccount = {
  id: "wac_tenant_b",
  workspaceId: "ws_tenant_b",
  phoneNumberId: "phone_b",
  wabaId: "waba_b",
  accessTokenRef: "secret://tenant-b-token",
  status: "connected" as const,
  escalationRules: [],
};

const actorA: ActorContextType = {
  user_id: "usr_a",
  tenant_id: "ten_a",
  workspace_id: "ws_tenant_a",
  session_id: "session_a",
  auth_time: 1,
  roles: ["admin"],
  permissions: ["integrations:read", "integrations:write"],
};
const actorB: ActorContextType = {
  user_id: "usr_b",
  tenant_id: "ten_b",
  workspace_id: "ws_tenant_b",
  session_id: "session_b",
  auth_time: 1,
  roles: ["admin"],
  permissions: ["integrations:read", "integrations:write"],
};

// Simulates Engine's own tenant scoping: the accounts list returned depends
// on which tenant's context called it, exactly as the real Engine boundary
// would behave once an actor token is bound to a single tenant.
class FakeEngineClient {
  readonly get = vi.fn(async (_path: string, context: EngineCallerContext) => ({
    status: 200,
    body: { accounts: context.tenantId === "ten_a" ? [tenantAAccount] : [tenantBAccount] },
  }));
  readonly post = vi.fn(async () => ({ status: 200, body: tenantBAccount }));
}

describe("WhatsApp cross-tenant isolation (CONN-ISO)", () => {
  function buildController(engine: FakeEngineClient) {
    const secrets = { getSecret: vi.fn() } as unknown as SecretsProvider;
    const service = new WhatsappService(engine as unknown as EngineClient, secrets);
    // Swap the real Meta Cloud API provider for a fake so these tests never
    // make a network call -- only the tenant-scoping code path is exercised.
    const fakeProvider = {
      getTemplates: vi.fn().mockResolvedValue([]),
      sendTemplateMessage: vi.fn().mockResolvedValue({ messageId: "wamid.1" }),
      getAccountHealth: vi.fn().mockResolvedValue({ status: "healthy" }),
    };
    (service as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    return { controller: new WhatsappController(service), service, engine, provider: fakeProvider };
  }

  it("excludes tenant A's account from tenant B's list", async () => {
    const { controller } = buildController(new FakeEngineClient());
    const listB = await controller.list(actorB, undefined);
    expect(listB).toEqual([tenantBAccount]);
    expect(listB.some((account) => account.id === tenantAAccount.id)).toBe(false);
  });

  it("404s templates/test-send/health for a tenant A account id requested by tenant B", async () => {
    const { controller, engine } = buildController(new FakeEngineClient());

    await expect(controller.templates(tenantAAccount.id, actorB, undefined)).rejects.toThrow(
      "WhatsApp account not found",
    );
    await expect(
      controller.testSend(tenantAAccount.id, { to: "15551234567", templateName: "hello" }, actorB, undefined),
    ).rejects.toThrow("WhatsApp account not found");
    await expect(controller.health(tenantAAccount.id, actorB, undefined)).rejects.toThrow(
      "WhatsApp account not found",
    );

    // Only the (tenant-scoped) list reads happened; no provider/mutation calls fired.
    expect(engine.post).not.toHaveBeenCalled();
  });

  it("404s configuration writes (monitoring/media) for a tenant A account id requested by tenant B", async () => {
    const { controller, engine } = buildController(new FakeEngineClient());

    await expect(
      controller.monitoring(tenantAAccount.id, { enabled: true }, actorB, undefined, "idem_1"),
    ).rejects.toThrow("WhatsApp account not found");
    await expect(
      controller.media(tenantAAccount.id, { maxBytes: 10 }, actorB, undefined, "idem_2"),
    ).rejects.toThrow("WhatsApp account not found");

    expect(engine.post).not.toHaveBeenCalled();
  });

  it("404s escalation read/write/update/delete for a tenant A account id requested by tenant B", async () => {
    const { controller, engine } = buildController(new FakeEngineClient());

    await expect(controller.escalations(tenantAAccount.id, actorB, undefined)).resolves.toEqual([]);
    await expect(
      controller.createEscalation(tenantAAccount.id, { target: "hijack" }, actorB, undefined, "idem_3"),
    ).rejects.toThrow(); // UnauthorizedException("WhatsApp account not found") from the controller's own guard
    await expect(
      controller.updateEscalation(tenantAAccount.id, "wer_a1", { target: "hijack" }, actorB, undefined, "idem_4"),
    ).rejects.toThrow();
    await expect(
      controller.deleteEscalation(tenantAAccount.id, "wer_a1", actorB, undefined, "idem_5"),
    ).rejects.toThrow();

    expect(engine.post).not.toHaveBeenCalled();
  });

  it("tenant A can still read and operate on its own account", async () => {
    const { controller } = buildController(new FakeEngineClient());
    await expect(controller.templates(tenantAAccount.id, actorA, undefined)).resolves.toEqual([]);
    await expect(controller.health(tenantAAccount.id, actorA, undefined)).resolves.toEqual({ status: "healthy" });
  });
});

// ENGINE-FIX-B7-1: WhatsappService.account() previously trusted list()'s
// result with no local workspace re-check -- if Engine's accounts list
// endpoint ever only scoped by tenant (not workspace), or was queried in a
// context where that scoping didn't hold, any workspace in the tenant could
// resolve another workspace's account by id. This worst-case Engine
// deliberately does NOT scope by workspace (only by tenant, unlike
// FakeEngineClient above) to prove the local re-check in account() is what
// actually enforces the boundary.
const workspaceAAccount = {
  id: "wac_workspace_a",
  workspaceId: "ws_workspace_a",
  phoneNumberId: "phone_ws_a",
  wabaId: "waba_ws_a",
  accessTokenRef: "secret://workspace-a-token",
  status: "connected" as const,
  escalationRules: [],
};
const sameTenantActorA: ActorContextType = {
  user_id: "usr_ws_a",
  tenant_id: "ten_shared",
  workspace_id: "ws_workspace_a",
  session_id: "session_ws_a",
  auth_time: 1,
  roles: ["admin"],
  permissions: ["integrations:read", "integrations:write"],
};
const sameTenantActorB: ActorContextType = {
  user_id: "usr_ws_b",
  tenant_id: "ten_shared",
  workspace_id: "ws_workspace_b",
  session_id: "session_ws_b",
  auth_time: 1,
  roles: ["admin"],
  permissions: ["integrations:read", "integrations:write"],
};

class WorstCaseTenantOnlyScopedEngineClient {
  readonly get = vi.fn(async (_path: string, context: EngineCallerContext) => ({
    status: 200,
    // Scopes by tenantId only -- every workspace in "ten_shared" gets the
    // same account list back, regardless of context.workspaceId.
    body: { accounts: context.tenantId === "ten_shared" ? [workspaceAAccount] : [] },
  }));
  readonly post = vi.fn(async () => ({ status: 200, body: workspaceAAccount }));
  readonly delete = vi.fn(async () => ({ status: 204, body: undefined }));
}

describe("WhatsApp cross-workspace isolation (ENGINE-FIX-B7-1)", () => {
  function buildController(engine: WorstCaseTenantOnlyScopedEngineClient) {
    const secrets = { getSecret: vi.fn() } as unknown as SecretsProvider;
    const service = new WhatsappService(engine as unknown as EngineClient, secrets);
    const fakeProvider = {
      getTemplates: vi.fn().mockResolvedValue([]),
      sendTemplateMessage: vi.fn().mockResolvedValue({ messageId: "wamid.1" }),
      getAccountHealth: vi.fn().mockResolvedValue({ status: "healthy" }),
    };
    (service as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    return { controller: new WhatsappController(service), engine };
  }

  it("still denies workspace B for workspace A's account against a worst-case Engine that only scopes by tenant", async () => {
    const { controller, engine } = buildController(new WorstCaseTenantOnlyScopedEngineClient());

    await expect(
      controller.templates(workspaceAAccount.id, sameTenantActorB, undefined),
    ).rejects.toThrow("WhatsApp account not found");
    await expect(
      controller.health(workspaceAAccount.id, sameTenantActorB, undefined),
    ).rejects.toThrow("WhatsApp account not found");
    expect(engine.post).not.toHaveBeenCalled();
  });

  it("refuses to delete workspace A's account from workspace B, without reaching Engine", async () => {
    const { controller, engine } = buildController(new WorstCaseTenantOnlyScopedEngineClient());

    await expect(
      controller.remove(workspaceAAccount.id, sameTenantActorB, undefined, "delete-b"),
    ).rejects.toThrow("WhatsApp account not found");
    expect(engine.delete).not.toHaveBeenCalled();
  });

  it("deletes workspace A's own account through Engine with the idempotency key", async () => {
    const { controller, engine } = buildController(new WorstCaseTenantOnlyScopedEngineClient());

    await controller.remove(workspaceAAccount.id, sameTenantActorA, undefined, "delete-a");

    expect(engine.delete).toHaveBeenCalledWith(
      `/api/v1/channels/whatsapp/accounts/${workspaceAAccount.id}`,
      expect.objectContaining({ tenantId: "ten_shared", workspaceId: "ws_workspace_a" }),
      { idempotencyKey: "delete-a" },
    );
  });

  it("still allows workspace A to operate on its own account", async () => {
    const { controller } = buildController(new WorstCaseTenantOnlyScopedEngineClient());

    await expect(
      controller.templates(workspaceAAccount.id, sameTenantActorA, undefined),
    ).resolves.toEqual([]);
  });

  it("lists accounts and escalation rules from the requested workspace", async () => {
    const { controller, engine } = buildController(new WorstCaseTenantOnlyScopedEngineClient());
    await expect(controller.list(sameTenantActorB, undefined)).resolves.toEqual([]);
    await expect(controller.escalations(workspaceAAccount.id, sameTenantActorB, undefined)).resolves.toEqual([]);
    await expect(controller.createEscalation(workspaceAAccount.id, { target: "fixture" }, sameTenantActorB, undefined, "create-b")).rejects.toThrow();
    await expect(controller.updateEscalation(workspaceAAccount.id, "rule", {}, sameTenantActorB, undefined, "update-b")).rejects.toThrow();
    await expect(controller.deleteEscalation(workspaceAAccount.id, "rule", sameTenantActorB, undefined, "remove-b")).rejects.toThrow();
    expect(engine.post).not.toHaveBeenCalled();
  });
});
