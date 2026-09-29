import type { SessionGatewayRequest } from "@alterx/auth";
import { describe, expect, it, vi } from "vitest";
import { WhatsappAccountNotFoundError, type WhatsappAccount, type WhatsappAccountRegistryService } from "./whatsapp-account-registry.service";
import { WhatsappAccountsController } from "./whatsapp-accounts.controller";

const tenant = "11111111-1111-7111-8111-111111111111";
const workspace = "22222222-2222-7222-8222-222222222222";
const request = { actorContext: { tenant_id: `ten_${tenant}` } } as unknown as SessionGatewayRequest;

function stored(): WhatsappAccount {
  return {
    id: "wac_1", tenantId: tenant, workspaceId: workspace, phoneNumberId: "123", wabaId: "456",
    accessTokenRef: "env:WA", status: "connected", monitoringConfig: {}, mediaConfig: {}, escalationRules: [],
  };
}

function controller() {
  const registry = {
    register: vi.fn(async (_tenantId: string, account: Omit<WhatsappAccount, "id" | "tenantId">) => ({ ...stored(), ...account })),
    list: vi.fn(async () => [stored()]),
    updateConfiguration: vi.fn(async () => stored()),
    remove: vi.fn(async (_tenantId: string, _workspaceId: string, accountId: string) => {
      if (accountId !== "wac_1") throw new WhatsappAccountNotFoundError(accountId);
    }),
  };
  return { registry, controller: new WhatsappAccountsController(registry as unknown as WhatsappAccountRegistryService) };
}

describe("WhatsappAccountsController", () => {
  it("stores bare UUIDs and answers with the prefixed ids platform-api compares against", async () => {
    const { registry, controller: accounts } = controller();

    const created = await accounts.register(request, {
      workspaceId: `ws_${workspace}`, phoneNumberId: "123", wabaId: "456", accessTokenRef: "env:WA",
    });
    const listed = await accounts.list(request);
    const updated = await accounts.updateConfiguration(request, "wac_1", { monitoringConfig: { on: true } });

    expect(registry.register).toHaveBeenCalledWith(tenant, expect.objectContaining({ workspaceId: workspace }));
    expect(registry.list).toHaveBeenCalledWith(tenant);
    expect(registry.updateConfiguration).toHaveBeenCalledWith(tenant, "wac_1", { monitoringConfig: { on: true } });
    for (const account of [created, listed.accounts[0]!, updated]) {
      expect(account).toMatchObject({ tenantId: `ten_${tenant}`, workspaceId: `ws_${workspace}` });
    }
  });

  it("accepts the bare workspace UUID platform-api's actor context carries", async () => {
    const { registry, controller: accounts } = controller();

    await accounts.register(request, {
      workspaceId: workspace, phoneNumberId: "123", wabaId: "456", accessTokenRef: "env:WA",
    });

    expect(registry.register).toHaveBeenCalledWith(tenant, expect.objectContaining({ workspaceId: workspace }));
  });

  it("refuses a workspace id that is not a workspace UUID", async () => {
    const { registry, controller: accounts } = controller();

    await expect(accounts.register(request, {
      workspaceId: "ws_not-a-uuid", phoneNumberId: "123", wabaId: "456", accessTokenRef: "env:WA",
    })).rejects.toMatchObject({ status: 400 });
    expect(registry.register).not.toHaveBeenCalled();
  });

  it("deletes within the caller's workspace and answers 404 for an unknown account", async () => {
    const { registry, controller: accounts } = controller();
    const scoped = { actorContext: { tenant_id: `ten_${tenant}`, workspace_id: `ws_${workspace}` } } as unknown as SessionGatewayRequest;

    await accounts.remove(scoped, "wac_1");
    expect(registry.remove).toHaveBeenCalledWith(tenant, workspace, "wac_1");
    await expect(accounts.remove(scoped, "wac_unknown")).rejects.toMatchObject({ status: 404 });
    await expect(accounts.remove(request, "wac_1")).rejects.toMatchObject({ status: 500 });
  });
});
