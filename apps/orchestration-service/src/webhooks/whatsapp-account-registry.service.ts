import { randomUUID } from "node:crypto";

interface Transaction {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface WhatsappAccountStore {
  withTenant<T>(tenantId: string, operation: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface WhatsappAccount {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessTokenRef: string;
  readonly status: "connected" | "disconnected";
  readonly monitoringConfig: Readonly<Record<string, unknown>>;
  readonly mediaConfig: Readonly<Record<string, unknown>>;
  readonly escalationRules: readonly Readonly<Record<string, unknown>>[];
}

export interface WhatsappRouting {
  readonly accountId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
}

export class WhatsappAccountNotFoundError extends Error {
  constructor(phoneNumberId: string) {
    super(`No connected WhatsApp account is registered for phone number ${phoneNumberId}`);
    this.name = "WhatsappAccountNotFoundError";
  }
}

const SYSTEM_TENANT_ID = "00000000-0000-7000-8000-000000000000";

export class WhatsappAccountRegistryService {
  constructor(private readonly store: WhatsappAccountStore) {}

  async resolveInbound(phoneNumberId: string | undefined): Promise<WhatsappRouting> {
    if (!phoneNumberId) throw new WhatsappAccountNotFoundError("unknown");
    const result = await this.store.withTenant(SYSTEM_TENANT_ID, (tx) =>
      tx.query<{ account_id: string; tenant_id: string; workspace_id: string }>(
        "SELECT account_id, tenant_id, workspace_id FROM resolve_whatsapp_routing($1)",
        [phoneNumberId],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new WhatsappAccountNotFoundError(phoneNumberId);
    return { accountId: row.account_id, tenantId: row.tenant_id, workspaceId: row.workspace_id };
  }

  async register(tenantId: string, account: Omit<WhatsappAccount, "id" | "tenantId">): Promise<WhatsappAccount> {
    const id = `wac_${randomUUID()}`;
    await this.store.withTenant(tenantId, (tx) => tx.query(
      `INSERT INTO whatsapp_accounts (id, tenant_id, workspace_id, phone_number_id, waba_id, access_token_ref, status, monitoring_config, media_config, escalation_rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, tenantId, account.workspaceId, account.phoneNumberId, account.wabaId, account.accessTokenRef, account.status, JSON.stringify(account.monitoringConfig), JSON.stringify(account.mediaConfig), JSON.stringify(account.escalationRules)],
    ));
    return { id, tenantId, ...account };
  }

  async list(tenantId: string, workspaceId: string): Promise<readonly WhatsappAccount[]> {
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, workspace_id, phone_number_id, waba_id, access_token_ref, status, monitoring_config, media_config, escalation_rules
         FROM whatsapp_accounts WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY created_at DESC`, [tenantId, workspaceId],
      );
      return result.rows.map((row) => fromRow(tenantId, row));
    });
  }

  /**
   * Removes an account from one workspace. Scoped by workspace as well as
   * tenant, so an account registered in another workspace of the same
   * tenant is not found. Inbound messages for its phone number stop routing
   * at once, since routing reads this table.
   */
  async remove(tenantId: string, workspaceId: string, accountId: string): Promise<void> {
    await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query(
        "DELETE FROM whatsapp_accounts WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
        [tenantId, workspaceId, accountId],
      );
      if (result.rowCount === 0) throw new WhatsappAccountNotFoundError(accountId);
    });
  }

  async updateConfiguration(
    tenantId: string,
    workspaceId: string,
    accountId: string,
    configuration: {
      readonly monitoringConfig?: Readonly<Record<string, unknown>>;
      readonly mediaConfig?: Readonly<Record<string, unknown>>;
      readonly escalationRules?: readonly Readonly<Record<string, unknown>>[];
    },
  ): Promise<WhatsappAccount> {
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE whatsapp_accounts
         SET monitoring_config = COALESCE($4::jsonb, monitoring_config),
             media_config = COALESCE($5::jsonb, media_config),
             escalation_rules = COALESCE($6::jsonb, escalation_rules),
             updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         RETURNING id, workspace_id, phone_number_id, waba_id, access_token_ref, status, monitoring_config, media_config, escalation_rules`,
        [tenantId, workspaceId, accountId,
          configuration.monitoringConfig === undefined ? null : JSON.stringify(configuration.monitoringConfig),
          configuration.mediaConfig === undefined ? null : JSON.stringify(configuration.mediaConfig),
          configuration.escalationRules === undefined ? null : JSON.stringify(configuration.escalationRules)],
      );
      const row = result.rows[0];
      if (!row) throw new WhatsappAccountNotFoundError(accountId);
      return fromRow(tenantId, row);
    });
  }
}

function fromRow(tenantId: string, row: Record<string, unknown>): WhatsappAccount {
  return {
    id: String(row.id), tenantId, workspaceId: String(row.workspace_id), phoneNumberId: String(row.phone_number_id),
    wabaId: String(row.waba_id), accessTokenRef: String(row.access_token_ref), status: row.status === "disconnected" ? "disconnected" : "connected",
    monitoringConfig: asObject(row.monitoring_config), mediaConfig: asObject(row.media_config), escalationRules: asArray(row.escalation_rules),
  };
}
function asObject(value: unknown): Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): readonly Readonly<Record<string, unknown>>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : []; }
