import { describe, expect, it, vi } from "vitest";
import type { SecretsProvider } from "@alterx/shared-clients";
import type { EngineClient, EngineCallerContext } from "../../engine";
import { WhatsappService } from "./whatsapp.service";

describe("WhatsappService", () => {
  it("registers an account through the authenticated Engine boundary", async () => {
    const account = {
      id: "wac_1", workspaceId: "22222222-2222-7222-8222-222222222222",
      phoneNumberId: "phone-1", wabaId: "waba-1", accessTokenRef: "secret://token",
      status: "connected" as const,
    };
    const post = vi.fn().mockResolvedValue({ status: 201, body: account });
    const service = new WhatsappService(
      { post } as unknown as EngineClient,
      { getSecret: vi.fn() } as unknown as SecretsProvider,
    );
    const context: EngineCallerContext = {
      userId: "usr_1", tenantId: "11111111-1111-7111-8111-111111111111",
      workspaceId: account.workspaceId, sessionId: "session_1", authTime: 1,
      roles: ["admin"], permissions: ["integrations:write"],
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    };

    await expect(service.register({
      workspaceId: account.workspaceId, phoneNumberId: account.phoneNumberId,
      wabaId: account.wabaId, accessTokenRef: account.accessTokenRef,
    }, context, "idem_1")).resolves.toEqual(account);

    expect(post).toHaveBeenCalledWith(
      "/api/v1/channels/whatsapp/accounts",
      expect.objectContaining({ phoneNumberId: "phone-1", accessTokenRef: "secret://token" }),
      context,
      { idempotencyKey: "idem_1" },
    );
  });

  it("uses the account list as the tenant-scoped source for provider operations and configuration", async () => {
    const account = { id: "wac_1", workspaceId: "ws_1", phoneNumberId: "phone_1", wabaId: "waba_1", accessTokenRef: "secret://token", status: "connected" as const };
    const get = vi.fn().mockResolvedValue({ status: 200, body: { accounts: [account] } });
    const post = vi.fn().mockResolvedValue({ status: 200, body: account });
    const service = new WhatsappService(
      { get, post } as unknown as EngineClient,
      { getSecret: vi.fn() } as unknown as SecretsProvider,
    );
    const provider = { getTemplates: vi.fn().mockResolvedValue([{ name: "hello", language: "en_US", status: "APPROVED" }]), sendTemplateMessage: vi.fn().mockResolvedValue({ messageId: "wamid.1" }), getAccountHealth: vi.fn().mockResolvedValue({ status: "healthy" }) };
    (service as unknown as { provider: typeof provider }).provider = provider;
    const context: EngineCallerContext = { userId: "usr_1", tenantId: "ten_1", workspaceId: "ws_1", sessionId: "session_1", authTime: 1, roles: ["admin"], permissions: ["integrations:read"], traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" };

    await expect(service.list(context)).resolves.toEqual([account]);
    await expect(service.templates(account.id, context)).resolves.toHaveLength(1);
    await expect(service.testSend(account.id, "15551234567", "hello", undefined, context)).resolves.toEqual({ messageId: "wamid.1" });
    await expect(service.health(account.id, context)).resolves.toEqual({ status: "healthy" });
    await expect(service.updateConfiguration(account.id, { monitoringConfig: { enabled: true } }, context, "idem_2")).resolves.toEqual(account);
    await expect(service.templates("missing", context)).rejects.toThrow("WhatsApp account not found");
    expect(post).toHaveBeenCalledWith(`/api/v1/channels/whatsapp/accounts/${account.id}/configuration`, { monitoringConfig: { enabled: true } }, context, { idempotencyKey: "idem_2" });
  });

  it("matches the engine's ws_ workspace id against the actor's bare workspace UUID, and only that workspace", async () => {
    const workspace = "22222222-2222-7222-8222-222222222222";
    const account = { id: "wac_1", workspaceId: `ws_${workspace}`, phoneNumberId: "phone_1", wabaId: "waba_1", accessTokenRef: "secret://token", status: "connected" as const };
    const get = vi.fn().mockResolvedValue({ status: 200, body: { accounts: [account] } });
    const service = new WhatsappService(
      { get } as unknown as EngineClient,
      { getSecret: vi.fn() } as unknown as SecretsProvider,
    );
    (service as unknown as { provider: { getAccountHealth: () => Promise<unknown> } }).provider = { getAccountHealth: vi.fn().mockResolvedValue({ status: "healthy" }) };
    const context = (workspaceId: string): EngineCallerContext => ({ userId: "usr_1", tenantId: "ten_1", workspaceId, sessionId: "session_1", authTime: 1, roles: ["admin"], permissions: ["integrations:read"], traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" });

    await expect(service.health(account.id, context(workspace))).resolves.toEqual({ status: "healthy" });
    await expect(service.health(account.id, context("33333333-3333-7333-8333-333333333333"))).rejects.toThrow("WhatsApp account not found");
  });
});
