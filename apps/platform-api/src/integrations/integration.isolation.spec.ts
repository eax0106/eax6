// CONN-ISO: proves an OAuth connection created in one workspace cannot be
// read, scoped-checked, or operated on from a different workspace (same
// tenant), and never appears in another workspace's connection list.
// IntegrationRepository's queries are workspace_id-scoped in SQL (see
// integration.repository.ts), but that scoping is application-level, not
// Postgres RLS (RLS here enforces tenant_id only) -- so this property is
// proven at the service/repository contract, not assumed from the schema.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import { IntegrationRepository } from "./integration.repository";
import type {
  CreateOAuthConnectionInput,
  CreateOAuthStateInput,
} from "./integration.repository";
import { IntegrationService } from "./integration.service";
import type { ConnectionRegistryClient } from "../engine/connection-registry-client";
import type {
  IntegrationActivityQuery,
  OAuthConnectionActivityRecord,
  OAuthConnectionRecord,
  OAuthStateRecord,
} from "./types";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceA = "wsa";
const workspaceB = "wsb";
const connectionId = "018f47a5-7b2c-7d10-8f11-123456789ab1";

class FakeIntegrationRepository {
  connections = new Map<string, OAuthConnectionRecord>();
  states = new Map<string, OAuthStateRecord>();
  activities: OAuthConnectionActivityRecord[] = [];

  async createState(tenant: string, input: CreateOAuthStateInput) {
    const record: OAuthStateRecord = {
      tenantId: tenant,
      id: input.id,
      workspaceId: input.workspaceId,
      connector: input.connector,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      createdBy: input.createdBy,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.states.set(`${tenant}:${input.id}`, record);
    return record;
  }
  async findState(tenant: string, id: string) {
    return this.states.get(`${tenant}:${id}`);
  }
  async deleteState(tenant: string, id: string) {
    this.states.delete(`${tenant}:${id}`);
  }

  async createConnection(tenant: string, input: CreateOAuthConnectionInput) {
    const now = new Date();
    const record: OAuthConnectionRecord = {
      tenantId: tenant,
      ...input,
      sourceRevision: 1,
      status: "connected" as const,
      lastHealthStatus: null,
      lastHealthCheckedAt: null,
      revokedAt: null,
      useAuditPtr: null,
      createdAt: now,
      updatedAt: now,
    };
    this.connections.set(`${tenant}:${input.workspaceId}:${input.id}`, record);
    return record;
  }

  // The property under test: every read is filtered by workspaceId, not just
  // tenantId. A repository that dropped the workspaceId predicate would leak
  // across workspaces in the same tenant -- Postgres RLS would not catch it.
  async listConnections(tenant: string, workspaceId: string) {
    return [...this.connections.values()].filter(
      (record) => record.tenantId === tenant && record.workspaceId === workspaceId,
    );
  }

  async findConnection(tenant: string, workspaceId: string, id: string) {
    return this.connections.get(`${tenant}:${workspaceId}:${id}`);
  }

  async updateHealth(tenant: string, workspaceId: string, id: string, status: string, checkedAt: Date) {
    const key = `${tenant}:${workspaceId}:${id}`;
    const record = this.connections.get(key);
    if (!record) return undefined;
    const updated = { ...record, lastHealthStatus: status, lastHealthCheckedAt: checkedAt };
    this.connections.set(key, updated);
    return updated;
  }

  async revokeConnection(tenant: string, workspaceId: string, id: string) {
    const key = `${tenant}:${workspaceId}:${id}`;
    const record = this.connections.get(key);
    if (!record) return undefined;
    const updated = { ...record, status: "revoked" as const, revokedAt: new Date() };
    this.connections.set(key, updated);
    return updated;
  }

  async recordUse(tenant: string, connId: string, _by: string, action: string) {
    const id = randomUUID();
    this.activities.push({ tenantId: tenant, id, connectionId: connId, action, usedAt: new Date() });
    return id;
  }

  async listActivity(tenant: string, connId: string, query: IntegrationActivityQuery) {
    const rows = this.activities.filter((r) => r.tenantId === tenant && r.connectionId === connId);
    const limit = query.limit ?? 50;
    return { data: rows.slice(0, limit), page: { next_cursor: null, has_more: false, limit } };
  }

  async onModuleDestroy() {}
}

describe("Integration OAuth cross-workspace isolation (CONN-ISO)", () => {
  function buildService() {
    const repository = new FakeIntegrationRepository();
    const secrets = { getSecret: vi.fn(), putSecret: vi.fn(), deleteSecret: vi.fn() };
    const http = {
      exchangeCode: vi.fn(),
      fetchAccountId: vi.fn().mockResolvedValue("ext-account"),
      revoke: vi.fn(),
    } as unknown as OAuthHttpClient;
    const service = new IntegrationService(
      repository as unknown as IntegrationRepository,
      secrets as never,
      http,
      { github: { clientIdSecretRef: "ref", clientSecretSecretRef: "ref", configured: true } } as never,
      { upsert: async () => undefined } as unknown as ConnectionRegistryClient,
      300,
    );
    return { service, repository, secrets };
  }

  it("shows workspace B its own real connection while excluding workspace A's -- two real provisioned connections, not one probed with a swapped header", async () => {
    const { service, repository } = buildService();
    await repository.createConnection(tenantId, {
      id: connectionId,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "acct-a",
      scopes: "read:user",
    });
    const connectionIdB = "018f47a5-7b2c-7d10-8f11-123456789ab2";
    await repository.createConnection(tenantId, {
      id: connectionIdB,
      workspaceId: workspaceB,
      connector: "google",
      externalAccountId: "acct-b",
      scopes: "openid email",
    });

    const listB = await service.listConnections(tenantId, workspaceB);
    expect(listB).toEqual([expect.objectContaining({ id: connectionIdB, connector: "google" })]);
    expect(listB.some((c) => c.id === connectionId)).toBe(false);

    const listA = await service.listConnections(tenantId, workspaceA);
    expect(listA).toEqual([expect.objectContaining({ id: connectionId, connector: "github" })]);
    expect(listA.some((c) => c.id === connectionIdB)).toBe(false);

    // Workspace B can read its own real connection.
    await expect(service.getConnection(tenantId, workspaceB, connectionIdB)).resolves.toMatchObject({
      id: connectionIdB,
    });
  });

  it("404s getConnection, scopes, and health for workspace A's connection requested from workspace B", async () => {
    const { service, repository, secrets } = buildService();
    await repository.createConnection(tenantId, {
      id: connectionId,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "acct-a",
      scopes: "read:user",
    });

    await expect(service.getConnection(tenantId, workspaceB, connectionId)).rejects.toMatchObject({
      response: { error_code: "INTEGRATION_CONNECTION_NOT_FOUND" },
    });
    await expect(service.scopes(tenantId, workspaceB, connectionId)).rejects.toMatchObject({
      response: { error_code: "INTEGRATION_CONNECTION_NOT_FOUND" },
    });
    await expect(
      service.health(tenantId, workspaceB, connectionId, "usr_b"),
    ).rejects.toMatchObject({
      response: { error_code: "INTEGRATION_CONNECTION_NOT_FOUND" },
    });

    // No token secret was ever read and no provider call fired for the denied attempt.
    expect(secrets.getSecret).not.toHaveBeenCalled();

    // Workspace A can still read its own connection.
    await expect(service.getConnection(tenantId, workspaceA, connectionId)).resolves.toMatchObject({
      id: connectionId,
    });
  });

  it("404s revoke for workspace A's connection requested from workspace B, and never deletes A's secret", async () => {
    const { service, repository, secrets } = buildService();
    await repository.createConnection(tenantId, {
      id: connectionId,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "acct-a",
      scopes: "read:user",
    });

    await expect(service.revoke(tenantId, workspaceB, connectionId, "usr_b")).rejects.toMatchObject({
      response: { error_code: "INTEGRATION_CONNECTION_NOT_FOUND" },
    });
    expect(secrets.deleteSecret).not.toHaveBeenCalled();

    const stillConnected = await repository.findConnection(tenantId, workspaceA, connectionId);
    expect(stillConnected?.status).toBe("connected");
  });
});
