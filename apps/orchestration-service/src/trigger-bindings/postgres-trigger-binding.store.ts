import type {
  NewWebhookEndpoint,
  NewWebhookSecret,
  RotationOutcome,
  TriggerBindingRecord,
  TriggerBindingStore,
  TriggerDispatchInfo,
  TriggerScope,
  UpsertBindingInput,
  WebhookEndpointRecord,
  WebhookRouting,
  WebhookSecretRecord,
} from "./types";
import { type TriggerBindingConfig, type TriggerBindingStatus } from "@alterx/contracts";
import { defaultDlqPolicy } from "../trigger-registry/dlq-policy";

interface Transaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * The tenant used for the public receiver's pre-authentication lookup. It
 * only ever runs resolve_webhook_endpoint(), a SECURITY DEFINER function that
 * returns routing identifiers and a secret REFERENCE for the single active
 * secret -- never secret material, never another tenant's rows.
 */
const SYSTEM_TENANT_ID = "00000000-0000-7000-8000-000000000000";

export class PostgresTriggerBindingStore implements TriggerBindingStore {
  constructor(private readonly store: OrchestrationTenantStore) {}

  private withTenant<T>(tenantId: string, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.store.withTenant(tenantId.replace(/^ten_/, ""), operation);
  }

  async findTriggerScope(
    tenantId: string,
    triggerId: string,
  ): Promise<TriggerScope | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ workspace_id: string; type: string }>(
        `SELECT workspace_id, type FROM triggers WHERE tenant_id = $1 AND id = $2`,
        [tenantId.replace(/^ten_/, ""), triggerId],
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { triggerId, workspaceId: `ws_${row.workspace_id}`, type: row.type };
    });
  }

  async findTriggerDispatchInfo(
    tenantId: string,
    triggerId: string,
  ): Promise<TriggerDispatchInfo | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        workspace_id: string;
        type: string;
        status: string;
        active_version: number | null;
        version_config: unknown;
      }>(
        `SELECT t.workspace_id, t.type, t.status,
                tv.version AS active_version, tv.config AS version_config
         FROM triggers t
         LEFT JOIN trigger_versions tv
           ON tv.tenant_id = t.tenant_id AND tv.trigger_id = t.id
          AND tv.status = 'active'
         WHERE t.tenant_id = $1 AND t.id = $2`,
        [tenantId.replace(/^ten_/, ""), triggerId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        triggerId,
        workspaceId: `ws_${row.workspace_id}`,
        type: row.type,
        status: row.status,
        activeVersion: row.active_version === null ? null : Number(row.active_version),
        dlqMaxReceiveCount:
          row.active_version === null
            ? null
            : readDlqMaxReceiveCount(row.version_config),
      };
    });
  }

  async findEndpointByIntegration(
    tenantId: string,
    workspaceId: string,
    integrationId: string,
  ): Promise<WebhookEndpointRecord | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<EndpointRow>(
        `${ENDPOINT_COLUMNS}
         WHERE tenant_id = $1 AND workspace_id = $2 AND integration_id = $3`,
        [tenantId.replace(/^ten_/, ""), workspaceId.replace(/^ws_/, ""), integrationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toEndpoint(tenantId, row);
    });
  }

  async findEndpointById(
    tenantId: string,
    endpointId: string,
  ): Promise<WebhookEndpointRecord | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<EndpointRow>(
        `${ENDPOINT_COLUMNS} WHERE tenant_id = $1 AND id = $2`,
        [tenantId.replace(/^ten_/, ""), endpointId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toEndpoint(tenantId, row);
    });
  }

  async createEndpointWithSecret(
    tenantId: string,
    endpoint: NewWebhookEndpoint,
    secret: NewWebhookSecret,
  ): Promise<{
    readonly endpoint: WebhookEndpointRecord;
    readonly secret: WebhookSecretRecord;
  }> {
    return this.withTenant(tenantId, async (tx) => {
      const endpointResult = await tx.query<EndpointRow>(
        `INSERT INTO webhook_endpoints
           (id, tenant_id, workspace_id, integration_id, path_token, max_skew_seconds)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, workspace_id, integration_id, path_token, max_skew_seconds, created_at`,
        [
          endpoint.id,
          tenantId.replace(/^ten_/, ""),
          endpoint.workspaceId.replace(/^ws_/, ""),
          endpoint.integrationId,
          endpoint.pathToken,
          endpoint.maxSkewSeconds,
        ],
      );
      const secretResult = await tx.query<SecretRow>(
        `INSERT INTO webhook_endpoint_secrets
           (id, tenant_id, endpoint_id, version, secret_ref, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id, endpoint_id, version, secret_ref, status, created_at, revoked_at`,
        [secret.id, tenantId.replace(/^ten_/, ""), endpoint.id, secret.version, secret.secretRef],
      );
      return {
        endpoint: toEndpoint(tenantId, endpointResult.rows[0]!),
        secret: toSecret(tenantId, secretResult.rows[0]!),
      };
    });
  }

  async upsertBinding(
    tenantId: string,
    input: UpsertBindingInput,
  ): Promise<TriggerBindingRecord> {
    return this.withTenant(tenantId, async (tx) => {
      // Re-binding the same (trigger, integration) pair is an update, not a
      // duplicate row, and re-activates a previously disabled binding.
      const result = await tx.query<BindingRow>(
        `INSERT INTO trigger_integration_bindings
           (id, tenant_id, workspace_id, trigger_id, integration_id, webhook_endpoint_id, config, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         ON CONFLICT (tenant_id, trigger_id, integration_id) DO UPDATE
           SET config = EXCLUDED.config,
               webhook_endpoint_id = EXCLUDED.webhook_endpoint_id,
               status = 'active',
               updated_at = now()
         RETURNING ${BINDING_FIELDS}`,
        [
          input.id,
          tenantId.replace(/^ten_/, ""),
          input.workspaceId.replace(/^ws_/, ""),
          input.triggerId,
          input.integrationId,
          input.webhookEndpointId,
          JSON.stringify(input.config),
        ],
      );
      return toBinding(tenantId, result.rows[0]!);
    });
  }

  async listBindings(
    tenantId: string,
    triggerId: string,
  ): Promise<readonly TriggerBindingRecord[]> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<BindingRow>(
        `SELECT ${BINDING_FIELDS} FROM trigger_integration_bindings
         WHERE tenant_id = $1 AND trigger_id = $2
         ORDER BY created_at DESC`,
        [tenantId.replace(/^ten_/, ""), triggerId],
      );
      return result.rows.map((row) => toBinding(tenantId, row));
    });
  }

  async disableBinding(
    tenantId: string,
    triggerId: string,
    bindingId: string,
  ): Promise<TriggerBindingRecord | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<BindingRow>(
        `UPDATE trigger_integration_bindings
         SET status = 'disabled', updated_at = now()
         WHERE tenant_id = $1 AND trigger_id = $2 AND id = $3
         RETURNING ${BINDING_FIELDS}`,
        [tenantId.replace(/^ten_/, ""), triggerId, bindingId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toBinding(tenantId, row);
    });
  }

  async findActiveSecret(
    tenantId: string,
    endpointId: string,
  ): Promise<WebhookSecretRecord | null> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<SecretRow>(
        `SELECT id, endpoint_id, version, secret_ref, status, created_at, revoked_at
         FROM webhook_endpoint_secrets
         WHERE tenant_id = $1 AND endpoint_id = $2 AND status = 'active'`,
        [tenantId.replace(/^ten_/, ""), endpointId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSecret(tenantId, row);
    });
  }

  /**
   * Revoke-then-insert inside one withTenant transaction. The revoke runs
   * first so the partial unique index
   * (webhook_endpoint_secrets_single_active) can never see two active rows;
   * if the insert fails, the whole rotation rolls back and the previous
   * secret stays active rather than the endpoint being left with none.
   */
  async rotateSecret(
    tenantId: string,
    endpointId: string,
    next: NewWebhookSecret,
    rotatedAt: Date,
  ): Promise<RotationOutcome> {
    return this.withTenant(tenantId, async (tx) => {
      const revoked = await tx.query<SecretRow>(
        `UPDATE webhook_endpoint_secrets
         SET status = 'revoked', revoked_at = $3
         WHERE tenant_id = $1 AND endpoint_id = $2 AND status = 'active'
         RETURNING id, endpoint_id, version, secret_ref, status, created_at, revoked_at`,
        [tenantId.replace(/^ten_/, ""), endpointId, rotatedAt.toISOString()],
      );
      const inserted = await tx.query<SecretRow>(
        `INSERT INTO webhook_endpoint_secrets
           (id, tenant_id, endpoint_id, version, secret_ref, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         RETURNING id, endpoint_id, version, secret_ref, status, created_at, revoked_at`,
        [next.id, tenantId.replace(/^ten_/, ""), endpointId, next.version, next.secretRef],
      );
      const previousRow = revoked.rows[0];
      return {
        previous: previousRow === undefined ? null : toSecret(tenantId, previousRow),
        next: toSecret(tenantId, inserted.rows[0]!),
        rotatedAt,
      };
    });
  }

  async resolveByPathToken(pathToken: string): Promise<WebhookRouting | null> {
    const result = await this.withTenant(SYSTEM_TENANT_ID, (tx) =>
      tx.query<{
        endpoint_id: string;
        tenant_id: string;
        workspace_id: string;
        integration_id: string;
        max_skew_seconds: number;
        secret_ref: string;
        secret_version: number;
      }>(
        `SELECT endpoint_id, tenant_id, workspace_id, integration_id,
                max_skew_seconds, secret_ref, secret_version
         FROM resolve_webhook_endpoint($1)`,
        [pathToken],
      ),
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          endpointId: row.endpoint_id,
          tenantId: `ten_${row.tenant_id}`,
          workspaceId: `ws_${row.workspace_id}`,
          integrationId: row.integration_id,
          maxSkewSeconds: Number(row.max_skew_seconds),
          secretRef: row.secret_ref,
          secretVersion: Number(row.secret_version),
        };
  }

  async listActiveBindingsForEndpoint(
    tenantId: string,
    endpointId: string,
  ): Promise<readonly TriggerBindingRecord[]> {
    return this.withTenant(tenantId, async (tx) => {
      const result = await tx.query<BindingRow>(
        `SELECT ${BINDING_FIELDS} FROM trigger_integration_bindings
         WHERE tenant_id = $1 AND webhook_endpoint_id = $2 AND status = 'active'
         ORDER BY created_at ASC`,
        [tenantId.replace(/^ten_/, ""), endpointId],
      );
      return result.rows.map((row) => toBinding(tenantId, row));
    });
  }
}

const ENDPOINT_COLUMNS = `SELECT id, workspace_id, integration_id, path_token, max_skew_seconds, created_at
   FROM webhook_endpoints`;

const BINDING_FIELDS = `id, workspace_id, trigger_id, integration_id, webhook_endpoint_id, config, status, created_at, updated_at`;

interface EndpointRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  integration_id: string;
  path_token: string;
  max_skew_seconds: number;
  created_at: string | Date;
}

interface SecretRow extends Record<string, unknown> {
  id: string;
  endpoint_id: string;
  version: number;
  secret_ref: string;
  status: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
}

interface BindingRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  trigger_id: string;
  integration_id: string;
  webhook_endpoint_id: string;
  config: unknown;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function toEndpoint(tenantId: string, row: EndpointRow): WebhookEndpointRecord {
  return {
    id: row.id,
    tenantId,
    workspaceId: `ws_${row.workspace_id}`,
    integrationId: row.integration_id,
    pathToken: row.path_token,
    maxSkewSeconds: Number(row.max_skew_seconds),
    createdAt: toDate(row.created_at),
  };
}

function toSecret(tenantId: string, row: SecretRow): WebhookSecretRecord {
  return {
    id: row.id,
    tenantId,
    endpointId: row.endpoint_id,
    version: Number(row.version),
    secretRef: row.secret_ref,
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: toDate(row.created_at),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
  };
}

function toBinding(tenantId: string, row: BindingRow): TriggerBindingRecord {
  return {
    id: row.id,
    tenantId,
    workspaceId: `ws_${row.workspace_id}`,
    triggerId: row.trigger_id,
    integrationId: row.integration_id,
    webhookEndpointId: row.webhook_endpoint_id,
    config: parseConfig(row.config),
    status: row.status === "disabled" ? "disabled" : ("active" as TriggerBindingStatus),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function parseConfig(value: unknown): TriggerBindingConfig {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const eventTypes = Array.isArray(record.eventTypes)
    ? record.eventTypes.filter((entry): entry is string => typeof entry === "string")
    : [];
  const filter = record.filter;
  return {
    eventTypes,
    ...(typeof filter === "object" && filter !== null && !Array.isArray(filter)
      ? { filter: filter as TriggerBindingConfig["filter"] }
      : {}),
  };
}

function readDlqMaxReceiveCount(versionConfig: unknown): number {
  const raw: unknown =
    typeof versionConfig === "string" ? JSON.parse(versionConfig) : versionConfig;
  const config = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const dlqPolicy = (typeof config.dlqPolicy === "object" && config.dlqPolicy !== null
    ? config.dlqPolicy
    : {}) as Record<string, unknown>;
  const maxReceiveCount = Number(dlqPolicy.maxReceiveCount);
  return Number.isInteger(maxReceiveCount) && maxReceiveCount >= 1
    ? maxReceiveCount
    : defaultDlqPolicy().maxReceiveCount;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
