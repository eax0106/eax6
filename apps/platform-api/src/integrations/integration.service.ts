import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import {
  CONNECTOR_CATALOG,
  findConnector,
  type ConnectorDefinition,
  type ConnectorId,
  type ResolvedConnectorEndpoints,
} from "./connectors";
import { generatePkcePair, generateState } from "./adapters/oauth/oauth-http-client";
import type { OAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import {
  ActivityCursorNotFoundError,
  IntegrationRepository,
} from "./integration.repository";
import type { NotificationService } from "../notifications/notification.service";
import { IntegrationHttpError } from "./problem";
import { SystemIntegrationStore } from "./system-integration-store";
import {
  INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
  INTEGRATION_OAUTH_HTTP_CLIENT,
  INTEGRATION_SECRETS_PROVIDER,
} from "./tokens";
import type {
  ConnectorCatalogEntry,
  IntegrationActivityQuery,
  OAuthAuthorizeInput,
  OAuthAuthorizeView,
  OAuthConnectionActivityPage,
  OAuthConnectionActivityRecord,
  OAuthCallbackInput,
  OAuthConnectionRecord,
  OAuthConnectionView,
  OAuthRevokeView,
  OAuthScopesView,
} from "./types";

export interface ConnectorRuntimeConfig {
  readonly clientIdSecretRef: string;
  readonly clientSecretSecretRef: string;
  readonly configured: boolean;
}

export type ConnectorRuntimeConfigMap = Readonly<
  Record<ConnectorId, ConnectorRuntimeConfig>
>;

const DEFAULT_STATE_TTL_SECONDS = 300;

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(
    private readonly repository: IntegrationRepository,
    @Inject(INTEGRATION_SECRETS_PROVIDER)
    private readonly secrets: MutableSecretsProvider,
    @Inject(INTEGRATION_OAUTH_HTTP_CLIENT)
    private readonly http: OAuthHttpClient,
    @Inject(INTEGRATION_CONNECTOR_RUNTIME_CONFIG)
    private readonly connectorConfig: ConnectorRuntimeConfigMap,
    private readonly stateTtlSeconds: number = DEFAULT_STATE_TTL_SECONDS,
    private readonly systemStore?: SystemIntegrationStore,
    private readonly notifications?: NotificationService,
  ) {}

  catalog(): ConnectorCatalogEntry[] {
    return CONNECTOR_CATALOG.map((connector) => ({
      id: connector.id,
      display_name: connector.displayName,
      scopes: connector.scopes,
      pkce: connector.pkce,
      configured: this.connectorConfig[connector.id]?.configured ?? false,
    }));
  }

  async authorize(
    tenantId: string,
    workspaceId: string,
    actorId: string,
    connectorId: string,
    input: OAuthAuthorizeInput,
  ): Promise<OAuthAuthorizeView> {
    const instance = `/api/v1/integrations/${connectorId}/actions/authorize`;
    const definition = this.requireConnector(connectorId, instance);
    const runtime = this.requireConfigured(definition.id, instance);
    const clientId = await this.secrets.getSecret(runtime.clientIdSecretRef);

    if (input.tenant_config) {
      await this.repository.upsertConnectorConfig(
        tenantId,
        workspaceId,
        definition.id,
        input.tenant_config,
      );
    }
    const endpoints = await this.resolveEndpoints(
      tenantId,
      workspaceId,
      definition,
      instance,
    );

    const state = generateState();
    const pkce = definition.pkce ? generatePkcePair() : null;
    const expiresAt = new Date(Date.now() + this.stateTtlSeconds * 1_000);

    await this.repository.createState(tenantId, {
      id: state,
      workspaceId,
      connector: definition.id,
      codeVerifier: pkce?.verifier ?? null,
      redirectUri: input.redirect_uri,
      createdBy: actorId,
      expiresAt,
    });

    const url = new URL(endpoints.authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirect_uri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", definition.scopes.join(definition.scopeSeparator));
    url.searchParams.set("state", state);
    if (pkce) {
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }

    return {
      authorize_url: url.toString(),
      state,
      expires_at: expiresAt.toISOString(),
    };
  }

  async callback(
    tenantId: string,
    workspaceId: string,
    actorId: string,
    connectorId: string,
    input: OAuthCallbackInput,
  ): Promise<OAuthConnectionView> {
    const instance = `/api/v1/integrations/${connectorId}/actions/callback`;
    const definition = this.requireConnector(connectorId, instance);
    const runtime = this.requireConfigured(definition.id, instance);
    const endpoints = await this.resolveEndpoints(
      tenantId,
      workspaceId,
      definition,
      instance,
    );

    const stateRecord = await this.repository.findState(tenantId, input.state);
    if (
      !stateRecord ||
      stateRecord.workspaceId !== workspaceId ||
      stateRecord.connector !== definition.id ||
      stateRecord.expiresAt.getTime() < Date.now()
    ) {
      throw new IntegrationHttpError(
        400,
        "INTEGRATION_STATE_INVALID",
        "OAuth state is missing, mismatched, or expired",
        instance,
      );
    }

    const [clientId, clientSecret] = await Promise.all([
      this.secrets.getSecret(runtime.clientIdSecretRef),
      this.secrets.getSecret(runtime.clientSecretSecretRef),
    ]);

    let tokenResult;
    let accountId: string;
    try {
      tokenResult = await this.http.exchangeCode({
        connector: definition.id,
        endpoints,
        code: input.code,
        codeVerifier: stateRecord.codeVerifier,
        redirectUri: stateRecord.redirectUri,
        clientId,
        clientSecret,
      });
      accountId = await this.http.fetchAccountId(
        definition.id,
        endpoints.userInfoUrl,
        tokenResult.accessToken,
      );
    } catch (error) {
      throw providerFailure(error, instance);
    }

    const id = randomUUID();
    const secretReference = tokenReference(tenantId, workspaceId, id);
    try {
      await this.secrets.putSecret(
        secretReference,
        JSON.stringify({
          access_token: tokenResult.accessToken,
          refresh_token: tokenResult.refreshToken,
          token_type: tokenResult.tokenType,
          expires_at: tokenResult.expiresAt,
        }),
      );
      const record = await this.repository.createConnection(tenantId, {
        id,
        workspaceId,
        connector: definition.id,
        externalAccountId: accountId,
        scopes: tokenResult.grantedScopes ?? definition.scopes.join(" "),
      });
      await this.repository.deleteState(tenantId, input.state);
      return project(record);
    } catch (error) {
      await bestEffortDelete(this.secrets, secretReference);
      throw providerFailure(error, instance);
    }
  }

  async listConnections(
    tenantId: string,
    workspaceId: string,
  ): Promise<OAuthConnectionView[]> {
    return (await this.repository.listConnections(tenantId, workspaceId)).map(
      project,
    );
  }

  async getConnection(
    tenantId: string,
    workspaceId: string,
    id: string,
  ): Promise<OAuthConnectionView> {
    const instance = `/api/v1/integrations/connections/${id}`;
    return project(
      await this.requireConnection(tenantId, workspaceId, id, instance),
    );
  }

  async scopes(
    tenantId: string,
    workspaceId: string,
    id: string,
  ): Promise<OAuthScopesView> {
    const instance = `/api/v1/integrations/connections/${id}/scopes`;
    const record = await this.requireConnection(
      tenantId,
      workspaceId,
      id,
      instance,
    );
    return { connection_id: record.id, scopes: splitScopes(record.scopes) };
  }

  async activity(
    tenantId: string,
    workspaceId: string,
    id: string,
    query: IntegrationActivityQuery,
  ): Promise<OAuthConnectionActivityPage> {
    const instance = `/api/v1/integrations/connections/${id}/activity`;
    await this.requireConnection(tenantId, workspaceId, id, instance);
    try {
      const page = await this.repository.listActivity(tenantId, id, query);
      return {
        data: page.data.map(projectActivity),
        page: page.page,
      };
    } catch (error) {
      if (error instanceof ActivityCursorNotFoundError) {
        throw new IntegrationHttpError(
          400,
          "INTEGRATION_VALIDATION_FAILED",
          "Activity cursor does not belong to this connection",
          instance,
          [{ field: "cursor", message: "Invalid activity cursor" }],
        );
      }
      throw error;
    }
  }

  async health(
    tenantId: string,
    workspaceId: string,
    id: string,
    actorId: string,
  ): Promise<OAuthConnectionView> {
    const instance = `/api/v1/integrations/connections/${id}/actions/health`;
    const record = await this.requireConnection(
      tenantId,
      workspaceId,
      id,
      instance,
    );
    const definition = this.requireConnector(record.connector, instance);
    const endpoints = await this.resolveEndpoints(
      tenantId,
      workspaceId,
      definition,
      instance,
    );

    let status: string;
    try {
      const token = await this.readToken(tenantId, workspaceId, id, instance);
      await this.http.fetchAccountId(
        definition.id,
        endpoints.userInfoUrl,
        token.access_token,
      );
      status = "healthy";
    } catch {
      status = "unhealthy";
    }

    await this.repository.recordUse(tenantId, id, actorId, "health_check");
    const updated = await this.repository.updateHealth(
      tenantId,
      workspaceId,
      id,
      status,
      new Date(),
    );
    if (!updated) throw notFound(instance);
    if (status === "unhealthy" && record.lastHealthStatus !== "unhealthy") {
      await this.notifyConnectionUnhealthy(updated, definition);
    }
    return project(updated);
  }

  /**
   * Design log §4 bucket 3: a broken credential is a hard stop that only a
   * human can fix, so the people who can reconnect it are told once, when the
   * connection turns unhealthy -- not on every sweep while it stays broken.
   * A failed notification never fails the health check itself.
   */
  private async notifyConnectionUnhealthy(
    record: OAuthConnectionRecord,
    definition: ConnectorDefinition,
  ): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notifyWorkspaceRoles(["admin"], {
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        eventClass: "system",
        severity: "warning",
        title: `${definition.displayName} connection needs reconnecting`,
        body: `Alter could not use the ${definition.displayName} connection. Workflows that depend on it will stop at that step until someone reconnects it.`,
        deepLink: `/app/connections/${encodeURIComponent(record.id)}`,
        sourceService: "platform-api.integrations",
      });
    } catch (error) {
      this.logger.error({
        tenantId: record.tenantId,
        connectionId: record.id,
        message: "connection-unhealthy notification failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A connection's access token, for another platform-api module that acts
   * through it (the Repository Manager reads GitHub as the workspace's own
   * connection). Only a connected connection of the expected connector is
   * released, and every release is written to the connection's use audit, the
   * same trail a health check leaves.
   */
  async accessTokenFor(
    tenantId: string,
    workspaceId: string,
    id: string,
    connector: ConnectorId,
    actorId: string,
    purpose: string,
    instance: string,
  ): Promise<string> {
    const record = await this.requireConnection(tenantId, workspaceId, id, instance);
    if (record.connector !== connector || record.status !== "connected") {
      throw new IntegrationHttpError(
        409,
        "INTEGRATION_CONNECTION_UNUSABLE",
        `Connection is not a connected ${connector} connection`,
        instance,
      );
    }
    const token = await this.readToken(tenantId, workspaceId, id, instance);
    await this.repository.recordUse(tenantId, id, actorId, purpose);
    return token.access_token;
  }

  async runHealthSweep(
    actorId: string,
  ): Promise<{ readonly connectionsProcessed: number; readonly connectionsFailed: number }> {
    if (!this.systemStore) {
      throw new IntegrationHttpError(
        503,
        "INTEGRATION_HEALTH_SWEEP_NOT_CONFIGURED",
        "Connector health sweeping requires the platform_db bypass-RLS system store, which is not configured",
        "/internal/integrations/run-health-sweep",
      );
    }
    const connections = await this.systemStore.listActiveConnections();
    let connectionsFailed = 0;
    for (const connection of connections) {
      try {
        await this.health(connection.tenantId, connection.workspaceId, connection.id, actorId);
      } catch (error) {
        connectionsFailed += 1;
        this.logger.error({
          tenantId: connection.tenantId,
          connectionId: connection.id,
          message: "connector health check failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { connectionsProcessed: connections.length, connectionsFailed };
  }

  async revoke(
    tenantId: string,
    workspaceId: string,
    id: string,
    actorId: string,
  ): Promise<OAuthRevokeView> {
    const instance = `/api/v1/integrations/connections/${id}/actions/revoke`;
    const record = await this.requireConnection(
      tenantId,
      workspaceId,
      id,
      instance,
    );
    const definition = this.requireConnector(record.connector, instance);
    const endpoints = await this.resolveEndpoints(
      tenantId,
      workspaceId,
      definition,
      instance,
    );
    const runtime = this.connectorConfig[definition.id];
    const secretReference = tokenReference(tenantId, workspaceId, id);

    let revokedRemotely = false;
    let reason: string | undefined;
    try {
      if (!runtime?.configured) {
        reason = `${definition.id} client credentials not configured; local invalidation only`;
      } else {
        const token = await this.readToken(tenantId, workspaceId, id, instance);
        const [clientId, clientSecret] = await Promise.all([
          this.secrets.getSecret(runtime.clientIdSecretRef),
          this.secrets.getSecret(runtime.clientSecretSecretRef),
        ]);
        const result = await this.http.revoke({
          connector: definition.id,
          endpoints,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          clientId,
          clientSecret,
        });
        revokedRemotely = result.revokedRemotely;
        reason = result.reason;
      }
    } catch (error) {
      reason = `remote revoke failed: ${error instanceof Error ? error.message : "unknown error"}`;
    }

    await bestEffortDelete(this.secrets, secretReference);
    await this.repository.recordUse(tenantId, id, actorId, "revoke");
    const updated = await this.repository.revokeConnection(
      tenantId,
      workspaceId,
      id,
    );
    if (!updated) throw notFound(instance);
    return {
      ...project(updated),
      revoked_remotely: revokedRemotely,
      ...(reason ? { revoke_disclosure: reason } : {}),
    };
  }

  private async readToken(
    tenantId: string,
    workspaceId: string,
    id: string,
    instance: string,
  ): Promise<{ access_token: string; refresh_token: string | null }> {
    const secretReference = tokenReference(tenantId, workspaceId, id);
    try {
      const raw = await this.secrets.getSecret(secretReference);
      return JSON.parse(raw) as { access_token: string; refresh_token: string | null };
    } catch (error) {
      throw providerFailure(error, instance);
    }
  }

  private async resolveEndpoints(
    tenantId: string,
    workspaceId: string,
    definition: ConnectorDefinition,
    instance: string,
  ): Promise<ResolvedConnectorEndpoints> {
    const record = await this.repository.findConnectorConfig(
      tenantId,
      workspaceId,
      definition.id,
    );
    try {
      return definition.resolveEndpoints(record?.config ?? null);
    } catch {
      throw new IntegrationHttpError(
        400,
        "INTEGRATION_TENANT_CONFIG_REQUIRED",
        `Workspace configuration required for ${definition.id}`,
        instance,
        [{ field: "tenant_config", message: `Missing ${definition.id} workspace configuration` }],
      );
    }
  }

  private requireConnector(
    id: string,
    instance: string,
  ): ConnectorDefinition {
    const definition = findConnector(id);
    if (!definition) {
      throw new IntegrationHttpError(
        400,
        "INTEGRATION_CONNECTOR_UNKNOWN",
        `Unsupported connector: ${id}`,
        instance,
      );
    }
    return definition;
  }

  private requireConfigured(
    connectorId: ConnectorId,
    instance: string,
  ): ConnectorRuntimeConfig {
    const runtime = this.connectorConfig[connectorId];
    if (!runtime?.configured) {
      throw new IntegrationHttpError(
        409,
        "INTEGRATION_CONNECTOR_NOT_CONFIGURED",
        `Connector ${connectorId} has no client credentials configured`,
        instance,
      );
    }
    return runtime;
  }

  private async requireConnection(
    tenantId: string,
    workspaceId: string,
    id: string,
    instance: string,
  ): Promise<OAuthConnectionRecord> {
    const record = await this.repository.findConnection(
      tenantId,
      workspaceId,
      id,
    );
    if (!record) throw notFound(instance);
    return record;
  }
}

export function tokenReference(
  tenantId: string,
  workspaceId: string,
  connectionId: string,
): string {
  return `/alter/integrations/${tenantId}/${workspaceId}/${connectionId}`;
}

function splitScopes(scopes: string): string[] {
  return scopes.split(/[ ,]+/).filter((scope) => scope.length > 0);
}

function project(record: OAuthConnectionRecord): OAuthConnectionView {
  return {
    id: record.id,
    connector: record.connector,
    external_account_id: record.externalAccountId,
    scopes: splitScopes(record.scopes),
    status: record.status,
    last_health_status: record.lastHealthStatus,
    last_health_checked_at: record.lastHealthCheckedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
    version: record.updatedAt.toISOString(),
  };
}

function projectActivity(
  record: OAuthConnectionActivityRecord,
): OAuthConnectionActivityPage["data"][number] {
  return {
    id: record.id,
    connection_id: record.connectionId,
    action: record.action,
    used_at: record.usedAt.toISOString(),
  };
}

function notFound(instance: string): IntegrationHttpError {
  return new IntegrationHttpError(
    404,
    "INTEGRATION_CONNECTION_NOT_FOUND",
    "Integration connection not found",
    instance,
  );
}

function providerFailure(error: unknown, instance: string): IntegrationHttpError {
  if (error instanceof IntegrationHttpError) return error;
  return new IntegrationHttpError(
    502,
    "INTEGRATION_PROVIDER_ERROR",
    error instanceof Error ? error.message : "Integration provider operation failed",
    instance,
  );
}

async function bestEffortDelete(
  provider: MutableSecretsProvider,
  reference: string,
): Promise<void> {
  try {
    await provider.deleteSecret(reference);
  } catch {
    // Preserve the original provider failure; deletion is best-effort cleanup.
  }
}
