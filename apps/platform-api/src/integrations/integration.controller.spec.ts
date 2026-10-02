import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  IdempotencyExceptionFilter,
  IdempotencyHttpError,
  IdempotencyInterceptor,
  PgIdempotencyStore,
  type IdempotencyExecution,
  type StoredHttpResponse,
} from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import type { OAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import { IntegrationController } from "./integration.controller";
import { IntegrationExceptionFilter } from "./integration-exception.filter";
import { IntegrationModule } from "./integration.module";
import type {
  CreateOAuthConnectionInput,
  CreateOAuthStateInput,
} from "./integration.repository";
import type { ConnectorId, ConnectorTenantConfig } from "./connectors";
import {
  ActivityCursorNotFoundError,
  IntegrationRepository,
} from "./integration.repository";
import { IntegrationService } from "./integration.service";
import type { ConnectionRegistryClient } from "../engine/connection-registry-client";
import {
  INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
  INTEGRATION_OAUTH_HTTP_CLIENT,
  INTEGRATION_SECRETS_PROVIDER,
} from "./tokens";
import { integrationDeferredCapabilities } from "./types";
import type {
  IntegrationActivityQuery,
  OAuthConnectionActivityRecord,
  OAuthConnectionRecord,
  OAuthStateRecord,
  WorkspaceConnectorConfigRecord,
} from "./types";

const uuid = "018f47a5-7b2c-7d10-8f11-123456789abc";
const connectionId = uuid;
const actor: ActorContextType = {
  user_id: `usr_${uuid}`,
  tenant_id: `ten_${uuid}`,
  workspace_id: `ws_${uuid}`,
  session_id: "session-integration",
  auth_time: 1_700_000_000,
  roles: ["admin"],
  permissions: ["integrations:read", "integrations:write"],
};

class FakeIntegrationRepository {
  states = new Map<string, OAuthStateRecord>();
  connections = new Map<string, OAuthConnectionRecord>();
  activities: OAuthConnectionActivityRecord[] = [];
  configs = new Map<string, WorkspaceConnectorConfigRecord>();

  reset(): void {
    this.states.clear();
    this.connections.clear();
    this.activities = [];
    this.configs.clear();
  }

  async upsertConnectorConfig(
    tenantId: string,
    workspaceId: string,
    connector: ConnectorId,
    config: ConnectorTenantConfig,
  ): Promise<WorkspaceConnectorConfigRecord> {
    const now = new Date();
    const key = `${tenantId}:${workspaceId}:${connector}`;
    const record = {
      tenantId,
      workspaceId,
      connector,
      config,
      createdAt: this.configs.get(key)?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(key, record);
    return record;
  }

  async findConnectorConfig(
    tenantId: string,
    workspaceId: string,
    connector: ConnectorId,
  ) {
    return this.configs.get(`${tenantId}:${workspaceId}:${connector}`);
  }

  async createState(
    tenantId: string,
    input: CreateOAuthStateInput,
  ): Promise<OAuthStateRecord> {
    const record: OAuthStateRecord = {
      tenantId,
      id: input.id,
      workspaceId: input.workspaceId,
      connector: input.connector,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      createdBy: input.createdBy,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.states.set(`${tenantId}:${input.id}`, record);
    return record;
  }

  async findState(tenantId: string, id: string) {
    return this.states.get(`${tenantId}:${id}`);
  }

  async deleteState(tenantId: string, id: string) {
    this.states.delete(`${tenantId}:${id}`);
  }

  async createConnection(
    tenantId: string,
    input: CreateOAuthConnectionInput,
  ): Promise<OAuthConnectionRecord> {
    const now = new Date();
    const record: OAuthConnectionRecord = {
      tenantId,
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
    this.connections.set(`${tenantId}:${input.workspaceId}:${input.id}`, record);
    return record;
  }

  async listConnections(tenantId: string, workspaceId: string) {
    return [...this.connections.values()].filter(
      (r) => r.tenantId === tenantId && r.workspaceId === workspaceId,
    );
  }

  async findConnection(tenantId: string, workspaceId: string, id: string) {
    return this.connections.get(`${tenantId}:${workspaceId}:${id}`);
  }

  async updateHealth(
    tenantId: string,
    workspaceId: string,
    id: string,
    status: string,
    checkedAt: Date,
  ) {
    const key = `${tenantId}:${workspaceId}:${id}`;
    const record = this.connections.get(key);
    if (!record) return undefined;
    const updated = {
      ...record,
      lastHealthStatus: status,
      lastHealthCheckedAt: checkedAt,
      updatedAt: new Date(),
    };
    this.connections.set(key, updated);
    return updated;
  }

  async revokeConnection(tenantId: string, workspaceId: string, id: string) {
    const key = `${tenantId}:${workspaceId}:${id}`;
    const record = this.connections.get(key);
    if (!record) return undefined;
    const updated: OAuthConnectionRecord = {
      ...record,
      status: "revoked" as const,
      revokedAt: new Date(),
      updatedAt: new Date(),
    };
    this.connections.set(key, updated);
    return updated;
  }

  async recordUse(
    tenantId: string,
    connectionId: string,
    _usedBy: string,
    action: string,
  ): Promise<string> {
    const id = randomUUID();
    this.activities.push({
      tenantId,
      id,
      connectionId,
      action,
      usedAt: new Date(),
    });
    return id;
  }

  addActivity(record: OAuthConnectionActivityRecord): void {
    this.activities.push(record);
  }

  async listActivity(
    tenantId: string,
    connectionId: string,
    query: IntegrationActivityQuery,
  ) {
    const records = this.activities
      .filter(
        (record) =>
          record.tenantId === tenantId && record.connectionId === connectionId,
      )
      .sort(
        (left, right) =>
          right.usedAt.getTime() - left.usedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const cursorIndex = query.cursor
      ? records.findIndex((record) => record.id === query.cursor)
      : -1;
    if (query.cursor && cursorIndex < 0) {
      throw new ActivityCursorNotFoundError();
    }
    const limit = query.limit ?? 50;
    const rows = records.slice(cursorIndex + 1);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return {
      data,
      page: {
        next_cursor: hasMore ? data.at(-1)?.id ?? null : null,
        has_more: hasMore,
        limit,
      },
    };
  }

  async onModuleDestroy(): Promise<void> {}
}

class FakeOAuthHttpClient implements OAuthHttpClient {
  failExchange = false;
  exchangeTokenUrl: string | null = null;
  accountUrls: string[] = [];
  revokeUrl: string | null = null;

  reset(): void {
    this.failExchange = false;
    this.exchangeTokenUrl = null;
    this.accountUrls = [];
    this.revokeUrl = null;
  }

  async exchangeCode(params: Parameters<OAuthHttpClient["exchangeCode"]>[0]) {
    if (this.failExchange) throw new Error("token exchange failed");
    this.exchangeTokenUrl = params.endpoints.tokenUrl;
    return {
      accessToken: "fake-access-token",
      refreshToken: "fake-refresh-token",
      tokenType: "bearer",
      expiresAt: null,
      grantedScopes: "read:user repo",
    };
  }

  async fetchAccountId(
    _connector: ConnectorId,
    userInfoUrl: string,
  ) {
    this.accountUrls.push(userInfoUrl);
    return "fake-account-id";
  }

  async revoke(params: Parameters<OAuthHttpClient["revoke"]>[0]) {
    this.revokeUrl = params.endpoints.revokeUrl;
    return { revokedRemotely: true };
  }
}

describe("Integration OAuth Hub routes", () => {
  let app: NestFastifyApplication;
  let repository: FakeIntegrationRepository;
  let httpClient: FakeOAuthHttpClient;
  let secrets: ReturnType<typeof createMockMutableSecretsProvider>;
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    repository = new FakeIntegrationRepository();
    httpClient = new FakeOAuthHttpClient();
    secrets = createMockMutableSecretsProvider({
      secrets: {
        "/alter/integrations/github/client-id": "github-client-id",
        "/alter/integrations/github/client-secret": "github-client-secret",
        "/alter/integrations/zendesk/client-id": "zendesk-client-id",
        "/alter/integrations/zendesk/client-secret": "zendesk-client-secret",
      },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [IntegrationController],
      providers: [
        {
          provide: IntegrationService,
          inject: [
            IntegrationRepository,
            INTEGRATION_SECRETS_PROVIDER,
            INTEGRATION_OAUTH_HTTP_CLIENT,
            INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
          ],
          useFactory: (
            repo: IntegrationRepository,
            secretsProvider: typeof secrets,
            http: OAuthHttpClient,
            connectorConfig: unknown,
          ) =>
            new IntegrationService(
              repo,
              secretsProvider,
              http,
              connectorConfig as never,
              { upsert: async () => undefined } as unknown as ConnectionRegistryClient,
              300,
            ),
        },
        IntegrationExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        { provide: IntegrationRepository, useValue: repository },
        { provide: INTEGRATION_SECRETS_PROVIDER, useValue: secrets },
        { provide: INTEGRATION_OAUTH_HTTP_CLIENT, useValue: httpClient },
        {
          provide: INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
          useValue: {
            github: {
              clientIdSecretRef: "/alter/integrations/github/client-id",
              clientSecretSecretRef: "/alter/integrations/github/client-secret",
              configured: true,
            },
            google: {
              clientIdSecretRef: "/alter/integrations/google/client-id",
              clientSecretSecretRef: "/alter/integrations/google/client-secret",
              configured: false,
            },
            zendesk: {
              clientIdSecretRef: "/alter/integrations/zendesk/client-id",
              clientSecretSecretRef: "/alter/integrations/zendesk/client-secret",
              configured: true,
            },
          },
        },
        { provide: PgIdempotencyStore, useValue: store },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook(
        "preHandler",
        (request: FastifyRequest, _reply: unknown, done: () => void) => {
          const value = request.headers["x-test-actor"];
          if (typeof value === "string") {
            (request as RbacRequest).actorContext = JSON.parse(
              value,
            ) as ActorContextType;
          }
          done();
        },
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    repository.reset();
    store.clear();
    httpClient.reset();
  });

  afterAll(async () => app.close());

  it("returns connector catalog with configured flags per connector", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/integrations",
      actor,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github", configured: true }),
      expect.objectContaining({ id: "google", configured: false }),
      expect.objectContaining({ id: "slack", configured: false }),
      expect.objectContaining({ id: "hubspot", configured: false }),
      expect.objectContaining({ id: "linkedin", configured: false }),
      expect.objectContaining({ id: "zendesk", configured: true }),
    ]));
    expect(response.json()).toHaveLength(10);
  });

  it("authorizes github, persists state, and builds a real authorize_url", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor,
      headers: { "idempotency-key": "authorize-github" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authorize_url: string; state: string };
    expect(body.authorize_url).toContain("https://github.com/login/oauth/authorize");
    expect(body.authorize_url).toContain(`state=${body.state}`);
    expect(repository.states.size).toBe(1);
  });

  it("409s authorize for an unconfigured connector", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/google/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor,
      headers: { "idempotency-key": "authorize-google" },
    });
    expectProblem(response, 409, "INTEGRATION_CONNECTOR_NOT_CONFIGURED");
  });

  it("persists Zendesk workspace config and never reuses it across workspaces", async () => {
    const first = await request({
      method: "POST",
      url: "/api/v1/integrations/zendesk/actions/authorize",
      body: {
        redirect_uri: "https://app.alter.ai/integrations/callback",
        tenant_config: { subdomain: "workspace-a" },
      },
      actor,
      headers: { "idempotency-key": "authorize-zendesk-a" },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { authorize_url: string; state: string };
    expect(firstBody.authorize_url).toContain(
      "https://workspace-a.zendesk.com/oauth/authorizations/new",
    );

    const callback = await request({
      method: "POST",
      url: "/api/v1/integrations/zendesk/actions/callback",
      body: { code: "code", state: firstBody.state },
      actor,
      headers: { "idempotency-key": "callback-zendesk-a" },
    });
    expect(callback.statusCode).toBe(200);
    expect(httpClient.exchangeTokenUrl).toBe(
      "https://workspace-a.zendesk.com/oauth/tokens",
    );
    expect(httpClient.accountUrls).toContain(
      "https://workspace-a.zendesk.com/api/v2/users/me.json",
    );
    const connectionId = (callback.json() as { id: string }).id;

    await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/actions/health`,
      body: {},
      actor,
      headers: { "idempotency-key": "health-zendesk-a" },
    });
    await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/actions/revoke`,
      body: {},
      actor,
      headers: { "idempotency-key": "revoke-zendesk-a" },
    });
    expect(httpClient.revokeUrl).toBe(
      "https://workspace-a.zendesk.com/api/v2/oauth/tokens/current.json",
    );

    const workspaceB = { ...actor, workspace_id: `ws_${uuid.slice(0, -1)}d` };
    const missingConfig = await request({
      method: "POST",
      url: "/api/v1/integrations/zendesk/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor: workspaceB,
      headers: { "idempotency-key": "authorize-zendesk-b" },
    });
    expectProblem(missingConfig, 400, "INTEGRATION_VALIDATION_FAILED");
    expect(
      await repository.findConnectorConfig(
        actor.tenant_id,
        workspaceB.workspace_id,
        "zendesk",
      ),
    ).toBeUndefined();
  });

  it("completes callback end-to-end and lists the resulting connection", async () => {
    const authorize = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor,
      headers: { "idempotency-key": "authorize-flow" },
    });
    const { state } = authorize.json() as { state: string };

    const callback = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/callback",
      body: { code: "real-looking-code", state },
      actor,
      headers: { "idempotency-key": "callback-flow" },
    });
    expect(callback.statusCode).toBe(200);
    const connection = callback.json() as { id: string; connector: string };
    expect(connection.connector).toBe("github");
    expect(repository.states.size).toBe(0);

    const list = await request({
      method: "GET",
      url: "/api/v1/integrations/connections",
      actor,
    });
    expect(list.json()).toEqual([
      expect.objectContaining({ id: connection.id, connector: "github" }),
    ]);

    const scopes = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connection.id}/scopes`,
      actor,
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json()).toEqual({
      connection_id: connection.id,
      scopes: ["read:user", "repo"],
    });

    const health = await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connection.id}/actions/health`,
      body: {},
      actor,
      headers: { "idempotency-key": "health-flow" },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ last_health_status: "healthy" });

    const revoke = await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connection.id}/actions/revoke`,
      body: {},
      actor,
      headers: { "idempotency-key": "revoke-flow" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({
      status: "revoked",
      revoked_remotely: true,
    });
  });

  it("lists tenant and workspace-scoped connection activity with keyset pagination", async () => {
    await repository.createConnection(actor.tenant_id, {
      id: connectionId,
      workspaceId: actor.workspace_id!,
      connector: "github",
      externalAccountId: "activity-account",
      scopes: "read:user",
    });
    repository.addActivity({
      tenantId: actor.tenant_id,
      id: "018f47a5-7b2c-7d10-8f11-123456789ab1",
      connectionId,
      action: "health_check",
      usedAt: new Date("2026-08-05T08:00:00.000Z"),
    });
    repository.addActivity({
      tenantId: actor.tenant_id,
      id: "018f47a5-7b2c-7d10-8f11-123456789ab2",
      connectionId,
      action: "revoke",
      usedAt: new Date("2026-08-05T09:00:00.000Z"),
    });
    repository.addActivity({
      tenantId: actor.tenant_id,
      id: "018f47a5-7b2c-7d10-8f11-123456789ab3",
      connectionId,
      action: "health_check",
      usedAt: new Date("2026-08-05T10:00:00.000Z"),
    });

    const first = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity?limit=2`,
      actor,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      data: [
        {
          id: "018f47a5-7b2c-7d10-8f11-123456789ab3",
          connection_id: connectionId,
          action: "health_check",
          used_at: "2026-08-05T10:00:00.000Z",
        },
        {
          id: "018f47a5-7b2c-7d10-8f11-123456789ab2",
          connection_id: connectionId,
          action: "revoke",
          used_at: "2026-08-05T09:00:00.000Z",
        },
      ],
      page: {
        next_cursor: "018f47a5-7b2c-7d10-8f11-123456789ab2",
        has_more: true,
        limit: 2,
      },
    });

    const second = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity?limit=2&cursor=018f47a5-7b2c-7d10-8f11-123456789ab2`,
      actor,
    });
    expect(second.json()).toMatchObject({
      data: [
        {
          id: "018f47a5-7b2c-7d10-8f11-123456789ab1",
          action: "health_check",
        },
      ],
      page: { next_cursor: null, has_more: false, limit: 2 },
    });
  });

  it("does not expose activity across tenant or workspace boundaries", async () => {
    await repository.createConnection(actor.tenant_id, {
      id: connectionId,
      workspaceId: actor.workspace_id!,
      connector: "github",
      externalAccountId: "scoped-activity-account",
      scopes: "read:user",
    });
    repository.addActivity({
      tenantId: actor.tenant_id,
      id: "018f47a5-7b2c-7d10-8f11-123456789ab4",
      connectionId,
      action: "health_check",
      usedAt: new Date("2026-08-05T10:00:00.000Z"),
    });

    const otherTenant = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity`,
      actor: { ...actor, tenant_id: `ten_${uuid.slice(0, -1)}d` },
    });
    expectProblem(otherTenant, 404, "INTEGRATION_CONNECTION_NOT_FOUND");

    const otherWorkspace = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity`,
      actor: { ...actor, workspace_id: `ws_${uuid.slice(0, -1)}d` },
    });
    expectProblem(otherWorkspace, 404, "INTEGRATION_CONNECTION_NOT_FOUND");
  });

  it("rejects invalid activity pagination input", async () => {
    await repository.createConnection(actor.tenant_id, {
      id: connectionId,
      workspaceId: actor.workspace_id!,
      connector: "github",
      externalAccountId: "invalid-activity-page-account",
      scopes: "read:user",
    });

    const invalidCursor = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity?cursor=018f47a5-7b2c-7d10-8f11-123456789ab5`,
      actor,
    });
    expectProblem(invalidCursor, 400, "INTEGRATION_VALIDATION_FAILED");

    const invalidLimit = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}/activity?limit=0`,
      actor,
    });
    expectProblem(invalidLimit, 400, "INTEGRATION_VALIDATION_FAILED");
  });

  it("discloses health and revoke failures when the stored token secret is missing", async () => {
    const authorize = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor,
      headers: { "idempotency-key": "authorize-missing-secret" },
    });
    const { state } = authorize.json() as { state: string };
    const callback = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/callback",
      body: { code: "code", state },
      actor,
      headers: { "idempotency-key": "callback-missing-secret" },
    });
    const connection = callback.json() as { id: string };
    await secrets.deleteSecret(
      `/alter/integrations/${actor.tenant_id}/${actor.workspace_id}/${connection.id}`,
    );

    const health = await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connection.id}/actions/health`,
      body: {},
      actor,
      headers: { "idempotency-key": "health-missing-secret" },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ last_health_status: "unhealthy" });

    const revoke = await request({
      method: "POST",
      url: `/api/v1/integrations/connections/${connection.id}/actions/revoke`,
      body: {},
      actor,
      headers: { "idempotency-key": "revoke-missing-secret" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({
      status: "revoked",
      revoked_remotely: false,
    });
    expect((revoke.json() as { revoke_disclosure: string }).revoke_disclosure).toMatch(
      /remote revoke failed/,
    );
  });

  it("rejects callback with a mismatched or expired state", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/callback",
      body: { code: "any-code", state: "unknown-state" },
      actor,
      headers: { "idempotency-key": "callback-invalid-state" },
    });
    expectProblem(response, 400, "INTEGRATION_STATE_INVALID");
  });

  it("surfaces provider failure as a 502 problem", async () => {
    httpClient.failExchange = true;
    const authorize = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/integrations/callback" },
      actor,
      headers: { "idempotency-key": "authorize-fail" },
    });
    const { state } = authorize.json() as { state: string };
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/callback",
      body: { code: "code", state },
      actor,
      headers: { "idempotency-key": "callback-fail" },
    });
    expectProblem(response, 502, "INTEGRATION_PROVIDER_ERROR");
  });

  it("404s connection routes for unknown connection ids", async () => {
    const response = await request({
      method: "GET",
      url: `/api/v1/integrations/connections/${connectionId}`,
      actor,
    });
    expectProblem(response, 404, "INTEGRATION_CONNECTION_NOT_FOUND");
  });

  it("rejects a malformed connectionId with a validation problem", async () => {
    const response = await request({
      method: "GET",
      url: "/api/v1/integrations/connections/not-a-uuid",
      actor,
    });
    expectProblem(response, 400, "INTEGRATION_VALIDATION_FAILED");
  });

  it("rejects an authorize body missing redirect_uri", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: {},
      actor,
      headers: { "idempotency-key": "authorize-missing-redirect" },
    });
    expectProblem(response, 400, "INTEGRATION_VALIDATION_FAILED");
  });

  it("rejects a callback body missing code or state", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/callback",
      body: { code: "" },
      actor,
      headers: { "idempotency-key": "callback-missing-state" },
    });
    expectProblem(response, 400, "INTEGRATION_VALIDATION_FAILED");
  });

  it.each([
    ["GET", "/api/v1/integrations", undefined],
    [
      "POST",
      "/api/v1/integrations/github/actions/authorize",
      { redirect_uri: "https://app.alter.ai/cb" },
    ],
  ])("scope-gates %s %s", async (method, url, body) => {
    const response = await request({
      method,
      url,
      body,
      actor: { ...actor, permissions: [] },
      headers: method === "POST" ? { "idempotency-key": "denied" } : undefined,
    });
    expectProblem(response, 403, "RBAC_PERMISSION_DENIED");
  });

  it("requires privileged role for authorize", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/github/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/cb" },
      actor: { ...actor, roles: ["viewer"] },
      headers: { "idempotency-key": "viewer-authorize" },
    });
    expectProblem(response, 403, "RBAC_ROLE_DENIED");
  });

  it("rejects unsupported connector ids with validation problem", async () => {
    const response = await request({
      method: "POST",
      url: "/api/v1/integrations/not-a-connector/actions/authorize",
      body: { redirect_uri: "https://app.alter.ai/cb" },
      actor,
      headers: { "idempotency-key": "bad-connector" },
    });
    expectProblem(response, 400, "INTEGRATION_VALIDATION_FAILED");
  });

  it("default-denies absent actor and missing workspace context", async () => {
    const noActor = await request({
      method: "GET",
      url: "/api/v1/integrations",
    });
    expectProblem(noActor, 403, "RBAC_ROLE_DENIED");

    const { workspace_id: _workspaceId, ...withoutWorkspace } = actor;
    void _workspaceId;
    const noWorkspace = await request({
      method: "GET",
      url: "/api/v1/integrations/connections",
      actor: withoutWorkspace,
    });
    expectProblem(noWorkspace, 403, "INTEGRATION_WORKSPACE_REQUIRED");
  });

  it("controller itself rejects a missing actor at the method level", async () => {
    const controller = new IntegrationController({} as IntegrationService);
    await expect(async () =>
      controller.listConnections(undefined),
    ).rejects.toMatchObject({
      status: 401,
      response: { error_code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("flags real remaining gaps and wires production module", () => {
    expect(integrationDeferredCapabilities).toEqual([
      expect.objectContaining({
        capability: "oauth_round_trip_verified",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_slack",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_hubspot",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_linkedin",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_zendesk",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_salesforce",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_shopify",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_x",
        status: "NOT_MET",
      }),
      expect.objectContaining({
        capability: "oauth_round_trip_verified_m365",
        status: "NOT_MET",
      }),
    ]);
    expect(IntegrationModule).toBeDefined();
  });

  function request(options: RequestOptions): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method: options.method,
      url: options.url,
      payload: options.body as never,
      headers: {
        ...(options.actor
          ? { "x-test-actor": JSON.stringify(options.actor) }
          : {}),
        ...options.headers,
      },
    } as never) as Promise<TestResponse>;
  }
});

class MemoryIdempotencyStore {
  private readonly responses = new Map<
    string,
    StoredHttpResponse & { fingerprint: string }
  >();

  clear(): void {
    this.responses.clear();
  }

  async execute(
    input: IdempotencyExecution,
    operation: () => Promise<StoredHttpResponse>,
  ) {
    if (!input.key) {
      throw new IdempotencyHttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required",
        input.instance,
      );
    }
    const mapKey = `${input.tenantId}:${input.key}`;
    const stored = this.responses.get(mapKey);
    if (stored) {
      if (stored.fingerprint !== input.fingerprint) {
        throw new IdempotencyHttpError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key reused with different request",
          input.instance,
        );
      }
      return { status: stored.status, body: stored.body, replayed: true };
    }
    const result = await operation();
    this.responses.set(mapKey, { ...result, fingerprint: input.fingerprint });
    return { ...result, replayed: false };
  }
}

function expectProblem(
  response: TestResponse,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain(
    "application/problem+json",
  );
  expect(response.json()).toMatchObject({ status, error_code: code });
}

interface RequestOptions {
  method: string;
  url: string;
  body?: unknown;
  actor?: ActorContextType;
  headers?: Record<string, string> | undefined;
}

interface TestResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}
