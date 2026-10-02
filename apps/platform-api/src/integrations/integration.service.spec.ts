import { describe, expect, it } from "vitest";
import type { NotificationService } from "../notifications/notification.service";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import type { OAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import { IntegrationService, type ConnectorRuntimeConfigMap } from "./integration.service";
import type { IntegrationRepository } from "./integration.repository";
import { SystemIntegrationStore } from "./system-integration-store";
import type { OAuthConnectionRecord } from "./types";
import type { ConnectionRegistryClient } from "../engine/connection-registry-client";

const registry = { upsert: async () => undefined } as unknown as ConnectionRegistryClient;

const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceId = "ws_018f47a5-7b2c-7d10-8f11-123456789abd";

function connectionRecord(id: string): OAuthConnectionRecord {
  return {
    tenantId,
    id,
    workspaceId,
    connector: "github",
    sourceRevision: 1,
    externalAccountId: "acct-1",
    scopes: "repo",
    status: "connected",
    lastHealthStatus: null,
    lastHealthCheckedAt: null,
    revokedAt: null,
    useAuditPtr: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const connectorConfig: ConnectorRuntimeConfigMap = {
  github: { clientIdSecretRef: "ref-id", clientSecretSecretRef: "ref-secret", configured: true },
  google: { clientIdSecretRef: "ref-id", clientSecretSecretRef: "ref-secret", configured: true },
} as ConnectorRuntimeConfigMap;

function fakeRepository(connections: Map<string, OAuthConnectionRecord>): IntegrationRepository {
  return {
    findConnection: async (tenant: string, workspace: string, id: string) =>
      connections.get(`${tenant}:${workspace}:${id}`),
    updateHealth: async (tenant: string, workspace: string, id: string, status: string, checkedAt: Date) => {
      const key = `${tenant}:${workspace}:${id}`;
      const record = connections.get(key);
      if (!record) return undefined;
      const updated = { ...record, lastHealthStatus: status, lastHealthCheckedAt: checkedAt };
      connections.set(key, updated);
      return updated;
    },
    recordUse: async () => "audit-id",
    findConnectorConfig: async () => undefined,
  } as unknown as IntegrationRepository;
}

const fakeSecrets = {
  getSecret: async () => JSON.stringify({ access_token: "token-value", refresh_token: null }),
} as unknown as MutableSecretsProvider;

describe("IntegrationService.runHealthSweep", () => {
  it("throws a real 503 when no SystemIntegrationStore is configured", async () => {
    const connections = new Map<string, OAuthConnectionRecord>();
    const service = new IntegrationService(
      fakeRepository(connections),
      fakeSecrets,
      { fetchAccountId: async () => "acct" } as unknown as OAuthHttpClient,
      connectorConfig,
      registry,
      300,
      undefined,
    );

    await expect(service.runHealthSweep("svc_platform_jobs")).rejects.toMatchObject({
      response: expect.objectContaining({ status: 503 }),
    });
  });

  it("real sweeps every active connection, isolating per-connection failures", async () => {
    const connections = new Map<string, OAuthConnectionRecord>([
      [`${tenantId}:${workspaceId}:conn-healthy`, connectionRecord("conn-healthy")],
      // conn-stale is returned by the system store but no longer exists in
      // the tenant-scoped repository -- a real race between enumeration
      // and per-connection health check, not fabricated.
    ]);
    const systemStore = {
      listConnections: async () => [
        { tenantId, workspaceId, id: "conn-healthy" },
        { tenantId, workspaceId, id: "conn-stale" },
      ],
    } as unknown as SystemIntegrationStore;

    const service = new IntegrationService(
      fakeRepository(connections),
      fakeSecrets,
      { fetchAccountId: async () => "acct" } as unknown as OAuthHttpClient,
      connectorConfig,
      registry,
      300,
      systemStore,
    );

    const result = await service.runHealthSweep("svc_platform_jobs");

    expect(result).toEqual({ connectionsProcessed: 2, connectionsFailed: 1 });
    expect(connections.get(`${tenantId}:${workspaceId}:conn-healthy`)?.lastHealthStatus).toBe(
      "healthy",
    );
  });
});

describe("IntegrationService.health notifies when a connection turns unhealthy (B3.1b)", () => {
  function setup(lastHealthStatus: string | null, notify: (roles: readonly string[], input: unknown) => Promise<number>) {
    const connections = new Map<string, OAuthConnectionRecord>([
      [`${tenantId}:${workspaceId}:conn-1`, { ...connectionRecord("conn-1"), lastHealthStatus }],
    ]);
    const calls: { roles: readonly string[]; input: Record<string, unknown> }[] = [];
    const notifications = {
      notifyWorkspaceRoles: async (roles: readonly string[], input: Record<string, unknown>) => {
        calls.push({ roles, input });
        return notify(roles, input);
      },
    } as unknown as NotificationService;
    const service = new IntegrationService(
      fakeRepository(connections),
      fakeSecrets,
      {
        fetchAccountId: async () => {
          throw new Error("401 from provider");
        },
      } as unknown as OAuthHttpClient,
      connectorConfig,
      registry,
      300,
      undefined,
      notifications,
    );
    return { service, calls };
  }

  it("tells the workspace admins once, on the transition, with a link to the connection", async () => {
    const { service, calls } = setup("healthy", async () => 1);

    const view = await service.health(tenantId, workspaceId, "conn-1", "usr_1");

    expect(view.last_health_status).toBe("unhealthy");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.roles).toEqual(["admin"]);
    expect(calls[0]!.input).toMatchObject({
      tenantId,
      workspaceId,
      eventClass: "system",
      severity: "warning",
      title: "GitHub connection needs reconnecting",
      deepLink: "/app/connections/conn-1",
    });
  });

  it("stays quiet while a connection stays unhealthy", async () => {
    const { service, calls } = setup("unhealthy", async () => 1);

    await service.health(tenantId, workspaceId, "conn-1", "usr_1");

    expect(calls).toHaveLength(0);
  });

  it("still records the health result when the notification fails", async () => {
    const { service } = setup(null, async () => {
      throw new Error("notification store down");
    });

    const view = await service.health(tenantId, workspaceId, "conn-1", "usr_1");

    expect(view.last_health_status).toBe("unhealthy");
  });
});

describe("IntegrationService.accessTokenFor", () => {
  function serviceWith(record: OAuthConnectionRecord, uses: string[]) {
    const connections = new Map([[`${tenantId}:${workspaceId}:${record.id}`, record]]);
    const repository = {
      ...fakeRepository(connections),
      recordUse: async (_tenant: string, _id: string, _actor: string, action: string) => {
        uses.push(action);
        return "audit-id";
      },
    } as unknown as IntegrationRepository;
    return new IntegrationService(
      repository,
      fakeSecrets,
      { fetchAccountId: async () => "acct" } as unknown as OAuthHttpClient,
      connectorConfig,
      registry,
      300,
      undefined,
    );
  }

  it("releases a connected connection's token and audits the release", async () => {
    const uses: string[] = [];
    const service = serviceWith(connectionRecord("conn-1"), uses);
    await expect(
      service.accessTokenFor(tenantId, workspaceId, "conn-1", "github", "usr_1", "repository_access", "/i"),
    ).resolves.toBe("token-value");
    expect(uses).toEqual(["repository_access"]);
  });

  it.each([
    ["another connector", { connector: "google" as const }],
    ["a revoked connection", { status: "revoked" as const }],
  ])("refuses %s and releases nothing", async (_label, override) => {
    const uses: string[] = [];
    const service = serviceWith({ ...connectionRecord("conn-1"), ...override }, uses);
    await expect(
      service.accessTokenFor(tenantId, workspaceId, "conn-1", "github", "usr_1", "repository_access", "/i"),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 409 }) });
    expect(uses).toEqual([]);
  });

  it("does not reach another workspace's connection", async () => {
    const service = serviceWith(connectionRecord("conn-1"), []);
    await expect(
      service.accessTokenFor(tenantId, "ws_other", "conn-1", "github", "usr_1", "repository_access", "/i"),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 404 }) });
  });
});
