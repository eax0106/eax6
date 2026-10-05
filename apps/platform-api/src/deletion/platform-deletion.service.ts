import { createHash } from "node:crypto";
import type {
  DeletionProvider,
  DeletionResult,
  ReplayResult,
  RetentionSweepResult,
  SubjectDataLocation,
  VerificationResult,
  WorkspaceDeletionProvider,
} from "@alterx/contracts";
import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import { planWorkspaceScope } from "@alterx/adapters";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import {
  LEGAL_HOLD_MONTHS,
  LEGAL_HOLD_SOURCES,
  SKELETON_RETENTION_DAYS,
  SKELETON_TABLES,
} from "./retention-config";

export interface ErasureTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly T[] }>;
}

export interface ErasureStore {
  /** One transaction with `app.current_tenant_id` set, so row security applies. */
  withTenant<T>(tenantId: string, operation: (tx: ErasureTransaction) => Promise<T>): Promise<T>;
  /** One transaction with no tenant set: for the tables and functions that are not tenant-secured. */
  withoutTenant<T>(operation: (tx: ErasureTransaction) => Promise<T>): Promise<T>;
}

const STORE = "platform-api";

// Every tenant-scoped table in platform_db that erasure is answerable for.
// scripts/deletion/certify.ts parses this exact block and fails CI if it and
// the deletion registry disagree, in either direction.
export const PLATFORM_TABLES = [
  "abuse_signals", "abuse_signal_actions", "action_item_annotations", "billing_dunning_audits", "billing_dunning_states",
  "billing_admin_operations", "billing_admin_credit_deliveries", "billing_policy_state", "billing_credit_deliveries", "billing_subscription_plans", "billing_events", "billing_payment_method_refs", "billing_profiles",
  "credential_refs", "credential_use_audits", "discovery_recommendations", "entitlements",
  "env_var_use_audits", "env_vars", "idempotency_keys", "installs", "jit_grant_audit",
  "jit_grants", "kyc_submissions", "listing_versions", "listings", "notification_digests",
  "notification_events", "notification_preferences", "notification_reads",
  "oauth_connection_use_audits", "oauth_connections", "oauth_states", "onboarding_states",
  "marketplace_governance_events", "orders", "payout_ledger", "payouts", "publishers", "repository_bindings", "reviews",
  "tenant_admin_actions", "tenant_members", "tenants",   "tool_manifests", "tool_revocations",
  "tool_scan_reports", "tool_versions", "user_admin_actions", "user_sessions", "users",
  "workflow_safeguards", "workspace_connector_configs", "workspace_exports", "workspace_invitations", "workspace_members", "workspaces",
] as const;

// Children before parents (a topological sort over every foreign key among the
// tables above, checked against a real schema by the integration spec). Left out
// on purpose, because they are not erased by a plain DELETE:
//   action_item_annotations, payout_ledger, marketplace_governance_events,
//   billing_admin_operations, billing_admin_credit_deliveries, abuse_signal_actions: guarded manifest erasure
//   tenants                                 becomes a tombstone
//   users                                   pseudonymised when no other tenant holds them
//   the SKELETON_TABLES                     staff access records, kept 90 days
export const PLATFORM_DELETE_ORDER = [
  "billing_subscription_plans", "billing_credit_deliveries", "billing_policy_state", "abuse_signals", "billing_dunning_audits", "billing_dunning_states", "billing_events",
  "billing_payment_method_refs", "billing_profiles", "credential_use_audits",
  "credential_refs", "discovery_recommendations", "entitlements", "env_var_use_audits",
  "env_vars", "idempotency_keys", "kyc_submissions", "notification_digests",
  "notification_preferences", "notification_reads", "notification_events",
  "oauth_connection_use_audits", "oauth_connections", "oauth_states", "onboarding_states",
  "payouts", "orders", "repository_bindings", "reviews", "installs", "tenant_members", "tool_revocations", "tool_scan_reports", "tool_versions",
  "tool_manifests", "publishers", "user_sessions", "workflow_safeguards",
  "workspace_connector_configs", "workspace_exports", "workspace_invitations", "workspace_members", "workspaces",
] as const;

const skeleton: ReadonlySet<string> = new Set(SKELETON_TABLES);

// D2 workspace erasure: legal-hold sources stay with the tenant (billing and
// seller records are tenant-level and erased, with their held minimum, only
// when the tenant is), so they are never scoped to a workspace.
const legalHold: ReadonlySet<string> = new Set(LEGAL_HOLD_SOURCES.map((source) => source.table));
const WORKSPACE_TABLES = PLATFORM_DELETE_ORDER.filter((table) => !legalHold.has(table));

export class PlatformDeletionService implements DeletionProvider, WorkspaceDeletionProvider {
  constructor(
    private readonly store: ErasureStore,
    private readonly secrets: MutableSecretsProvider,
    private readonly retentionStore?: ErasureStore,
    private readonly administrationStore: ErasureStore = store,
  ) {}

  async locateSubjectData(tenantId: string): Promise<readonly SubjectDataLocation[]> {
    const tenant = bareTenant(tenantId);
    return this.store.withTenant(tenant, async (tx) => {
      const locations: SubjectDataLocation[] = [];
      for (const table of PLATFORM_TABLES) {
        const result = await tx.query<{ count: string }>(countQuery(table), [tenant]);
        locations.push({ store: STORE, table, rowCount: Number(result.rows[0]?.count ?? 0), objectReferences: [] });
      }
      return locations;
    });
  }

  async deleteSubjectData(tenantId: string, manifestId: string): Promise<DeletionResult> {
    const tenant = bareTenant(tenantId);
    requireManifest(manifestId);
    const pseudonym = pseudonymOf(tenantId);

    const phase = await this.store.withTenant(tenant, async (tx) => {
      const existing = await tx.query<{ state: string; tenant_id: string; secret_refs: string[] }>(
        "SELECT state, tenant_id::text, secret_refs FROM tenant_erasure_manifests WHERE manifest_id = $1",
        [manifestId],
      );
      const row = existing.rows[0];
      if (row !== undefined && row.tenant_id !== tenant) {
        throw new Error("manifest belongs to another tenant");
      }
      if (row !== undefined && row.state !== "active") {
        return { rows: 0, secretRefs: row.secret_refs, members: [] as string[], done: row.state === "complete" };
      }
      await tx.query(
        `INSERT INTO tenant_erasure_manifests (manifest_id, tenant_id) VALUES ($1, $2)
         ON CONFLICT (manifest_id) DO NOTHING`,
        [manifestId, tenant],
      );

      const secretRefs = await collectSecretReferences(tx, tenant);
      const members = (
        await tx.query<{ user_id: string }>("SELECT DISTINCT user_id::text FROM tenant_members WHERE tenant_id = $1", [tenant])
      ).rows.map((member) => member.user_id);
      await tx.query("UPDATE tenant_erasure_manifests SET retained_user_ids = $2::uuid[] WHERE manifest_id = $1", [manifestId, members]);

      await holdWhatTheLawKeeps(tx, tenant, pseudonym);

      let rows = 0;
      rows += Number((await tx.query<{ n: number }>("SELECT erase_tenant_action_annotations($1::uuid, $2) AS n", [tenant, manifestId])).rows[0]?.n ?? 0);
      rows += Number((await tx.query<{ n: number }>("SELECT erase_tenant_payout_ledger($1::uuid, $2) AS n", [tenant, manifestId])).rows[0]?.n ?? 0);
      rows += Number((await tx.query<{n:number}>("SELECT erase_tenant_billing_admin_operations($1::uuid,$2) AS n",[tenant,manifestId])).rows[0]?.n ?? 0);
      // tenants.billing_profile_id and billing_profiles.tenant_id point at each other.
      await tx.query("UPDATE tenants SET billing_profile_id = NULL WHERE id = $1", [tenant]);
      rows += Number((await tx.query<{ n: number }>("SELECT erase_tenant_abuse_signal_actions($1::uuid,$2) AS n", [tenant,manifestId])).rows[0]?.n ?? 0);
      for (const table of PLATFORM_DELETE_ORDER) {
        rows += (await tx.query(table === "tool_versions" ? TOOL_VERSIONS_DELETE : `DELETE FROM "${table}" WHERE tenant_id = $1`, [tenant])).rowCount;
      }
      // After the tenant's own orders, installs and reviews are gone: keeps a listing others depend on, ownerless.
      rows += Number((await tx.query<{ n: number }>("SELECT erase_tenant_listings($1::uuid, $2) AS n", [tenant, manifestId])).rows[0]?.n ?? 0);
      // Governance history uses canonical bare tenant UUIDs and the same guarded erasure role.
      rows += Number((await tx.query<{n:number}>("SELECT erase_tenant_marketplace_governance($1::uuid,$2) AS n",[tenant,manifestId])).rows[0]?.n ?? 0);
      rows += (
        await tx.query(
          `UPDATE tenants
              SET name = '', status = 'deleted', region = DEFAULT, identity_org_ref = NULL,
                  data_residency = NULL, retention_overrides = NULL, security_policy = NULL,
                  sso_config = NULL, billing_profile_id = NULL,
                  deleted_at = COALESCE(deleted_at, now()),
                  created_at = COALESCE(deleted_at, now()), updated_at = COALESCE(deleted_at, now())
            WHERE id = $1`,
          [tenant],
        )
      ).rowCount;
      await tx.query(
        "UPDATE tenant_erasure_manifests SET state = 'secrets_pending', secret_refs = $2 WHERE manifest_id = $1",
        [manifestId, secretRefs],
      );
      return { rows, secretRefs, members, done: false };
    });

    // The erasure is committed; only now do the secrets go, without a recovery window.
    let pseudonymised = 0;
    if (phase.members.length > 0) {
      pseudonymised = await this.administrationStore.withoutTenant(async (tx) =>
        Number((await tx.query<{ n: number }>("SELECT pseudonymise_orphan_users($1::uuid[]) AS n", [phase.members])).rows[0]?.n ?? 0),
      );
    }
    let deletedSecrets = 0;
    if (!phase.done) {
      for (const reference of phase.secretRefs) {
        if (await this.deleteSecret(reference)) deletedSecrets += 1;
      }
      await this.store.withoutTenant((tx) =>
        tx.query("UPDATE tenant_erasure_manifests SET state = 'complete', completed_at = now() WHERE manifest_id = $1", [manifestId]),
      );
    }
    return { store: STORE, manifestId, deletedRows: phase.rows + pseudonymised, deletedObjects: deletedSecrets };
  }

  async verifyDeletion(tenantId: string, manifestId: string): Promise<VerificationResult> {
    requireManifest(manifestId);
    const remaining: SubjectDataLocation[] = (await this.locateSubjectData(tenantId)).filter(
      (item) => item.rowCount > 0 && !skeleton.has(item.table),
    );
    const tenant = bareTenant(tenantId);
    const manifests = await this.store.withoutTenant((tx) =>
      tx.query<{ secret_refs: string[] }>("SELECT secret_refs FROM tenant_erasure_manifests WHERE tenant_id = $1", [tenant]),
    );
    let surviving = 0;
    for (const manifest of manifests.rows) {
      for (const reference of manifest.secret_refs) {
        if (await this.secretExists(reference)) surviving += 1;
      }
    }
    if (surviving > 0) {
      remaining.push({ store: STORE, table: "secrets-store", rowCount: surviving, objectReferences: [] });
    }
    return { store: STORE, manifestId, deleted: remaining.length === 0, remaining };
  }

  /**
   * D2: one workspace's rows, scoped from the live schema with the workspaces
   * row as root. Tenant-wide tables (members, billing, sessions) have no path
   * to a workspace and are left alone.
   */
  async locateWorkspaceData(tenantId: string, workspaceId: string): Promise<readonly SubjectDataLocation[]> {
    const { tenant, workspace } = workspaceSubject(tenantId, workspaceId);
    return this.store.withTenant(tenant, async (tx) => {
      const scope = await workspaceScope(tx);
      const locations: SubjectDataLocation[] = [];
      for (const [table, predicate] of scope) {
        const result = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}" WHERE ${predicate}`, [tenant, workspace]);
        locations.push({ store: STORE, table, rowCount: Number(result.rows[0]?.count ?? 0), objectReferences: [] });
      }
      return locations;
    });
  }

  /**
   * Secrets first, then rows. A secret that fails to delete aborts before any
   * row goes, so a retry finds the same rows and references; once the rows are
   * gone, so are their secrets, which is what verification relies on.
   */
  async deleteWorkspaceData(tenantId: string, workspaceId: string, manifestId: string): Promise<DeletionResult> {
    const { tenant, workspace } = workspaceSubject(tenantId, workspaceId);
    requireManifest(manifestId);
    const references = await this.store.withTenant(tenant, async (tx) =>
      collectWorkspaceSecretReferences(tx, tenant, workspace, await workspaceScope(tx)),
    );
    let deletedSecrets = 0;
    for (const reference of references) {
      if (await this.deleteSecret(reference)) deletedSecrets += 1;
    }
    const rows = await this.store.withTenant(tenant, async (tx) => {
      const scope = await workspaceScope(tx);
      let deleted = 0;
      for (const table of WORKSPACE_TABLES) {
        const predicate = scope.get(table);
        if (predicate === undefined) continue;
        deleted += (await tx.query(`DELETE FROM "${table}" WHERE ${predicate}`, [tenant, workspace])).rowCount;
      }
      return deleted;
    });
    return { store: STORE, manifestId, deletedRows: rows, deletedObjects: deletedSecrets };
  }

  async verifyWorkspaceDeletion(tenantId: string, workspaceId: string, manifestId: string): Promise<VerificationResult> {
    requireManifest(manifestId);
    const remaining = (await this.locateWorkspaceData(tenantId, workspaceId)).filter((item) => item.rowCount > 0);
    return { store: STORE, manifestId, deleted: remaining.length === 0, remaining };
  }

  async applyRetentionPolicy(): Promise<RetentionSweepResult> {
    const retentionStore = this.retentionStore;
    if (!retentionStore) throw new Error("Dedicated retention connection required");
    const result = await this.store.withoutTenant(async (tx) => {
      const clock = await tx.query<{ swept_at: string }>("SELECT transaction_timestamp()::text AS swept_at");
      const sweptAt = clock.rows[0]?.swept_at;
      if (!sweptAt) throw new Error("retention sweep database clock unavailable");
      const removed = await tx.query("DELETE FROM legal_hold_records WHERE retain_until <= $1::timestamptz", [sweptAt]);
      // Y1: tombstones past the skeleton window lose their retained staff
      // access rows, manifests and themselves, only through the dedicated
      // expiry function. The cutoff is inclusive: exactly 90 days goes.
      const cutoff = new Date(new Date(sweptAt).getTime() - SKELETON_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const expired = await retentionStore.withoutTenant((retention) =>
        retention.query<{ n: number }>("SELECT expire_erasure_skeleton($1::timestamptz) AS n", [cutoff.toISOString()]),
      );
      return {
        deletedRows: removed.rowCount + Number(expired.rows[0]?.n ?? 0),
        sweptAt: new Date(sweptAt).toISOString(),
      };
    });
    return { store: STORE, ...result, deletedObjects: 0 };
  }

  async replayDeletionLedger(sinceTimestamp: string): Promise<ReplayResult> {
    void sinceTimestamp;
    throw new Error("Deletion-ledger replay is coordinated by audit-service");
  }

  async listSubjectIds(): Promise<readonly string[]> {
    return this.administrationStore.withoutTenant(async (tx) => {
      const result = await tx.query<{ id: string }>("SELECT list_platform_tenant_ids()::text AS id");
      return result.rows.map((row) => `ten_${row.id}`);
    });
  }

  private async deleteSecret(reference: string): Promise<boolean> {
    try {
      await this.secrets.deleteSecret(reference);
      return true;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async secretExists(reference: string): Promise<boolean> {
    try {
      await this.secrets.getSecret(reference);
      return true;
    } catch (error: unknown) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

/** Only secrets Alter created for this tenant, by their tenant-scoped paths. */
async function collectSecretReferences(tx: ErasureTransaction, tenant: string): Promise<string[]> {
  const references: string[] = [];
  for (const row of (await tx.query<{ id: string }>("SELECT id::text FROM credential_refs WHERE tenant_id = $1", [tenant])).rows) {
    references.push(`/alter/credentials/${tenant}/${row.id}`);
  }
  for (const row of (await tx.query<{ id: string }>("SELECT id::text FROM env_vars WHERE tenant_id = $1", [tenant])).rows) {
    references.push(`/alter/env-vars/${tenant}/${row.id}`);
  }
  for (const row of (await tx.query<{ id: string; workspace_id: string }>("SELECT id::text, workspace_id::text FROM oauth_connections WHERE tenant_id = $1", [tenant])).rows) {
    references.push(`/alter/integrations/${tenant}/${row.workspace_id}/${row.id}`);
  }
  return references;
}

async function workspaceScope(tx: ErasureTransaction): Promise<ReadonlyMap<string, string>> {
  return (await planWorkspaceScope(tx, WORKSPACE_TABLES, { table: "workspaces", keyColumn: "id" })).scoped;
}

/** The workspace's secrets, by the same tenant-scoped paths as the tenant's erasure, for scoped rows only. */
async function collectWorkspaceSecretReferences(
  tx: ErasureTransaction,
  tenant: string,
  workspace: string,
  scope: ReadonlyMap<string, string>,
): Promise<string[]> {
  const references: string[] = [];
  const ids = async (table: string) => {
    const predicate = scope.get(table);
    if (predicate === undefined) return [];
    return (await tx.query<{ id: string }>(`SELECT id::text FROM "${table}" WHERE ${predicate}`, [tenant, workspace])).rows.map((row) => row.id);
  };
  for (const id of await ids("credential_refs")) references.push(`/alter/credentials/${tenant}/${id}`);
  for (const id of await ids("env_vars")) references.push(`/alter/env-vars/${tenant}/${id}`);
  for (const id of await ids("oauth_connections")) references.push(`/alter/integrations/${tenant}/${workspace}/${id}`);
  return references;
}

function workspaceSubject(tenantId: string, workspaceId: string): { tenant: string; workspace: string } {
  const parsed = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) throw new Error("workspaceId must be a ws_ prefixed UUIDv7");
  return { tenant: bareTenant(tenantId), workspace: parsed.data.slice(3) };
}

/** Copy the minimum fields the law says to keep, once per source row, before anything is destroyed. */
async function holdWhatTheLawKeeps(tx: ErasureTransaction, tenant: string, pseudonym: string): Promise<void> {
  for (const source of LEGAL_HOLD_SOURCES) {
    const fields = source.columns.map((column) => `'${column}', "${column}"`).join(", ");
    await tx.query(
      `INSERT INTO legal_hold_records (tenant_pseudonym, kind, source_table, source_id, minimal, retain_until)
       SELECT $2, $3, $4, "${source.idColumn}"::text, jsonb_build_object(${fields}),
              now() + make_interval(months => $5::int)
         FROM "${source.table}" WHERE tenant_id = $1
       ON CONFLICT (source_table, source_id) DO NOTHING`,
      [tenant, pseudonym, source.kind, source.table, LEGAL_HOLD_MONTHS[source.kind]],
    );
  }
}

const TOOL_VERSIONS_DELETE =
  "DELETE FROM tool_versions WHERE manifest_id IN (SELECT id FROM tool_manifests WHERE tenant_id = $1)";

function countQuery(table: (typeof PLATFORM_TABLES)[number]): string {
  switch (table) {
    case "tenants":
      return `SELECT count(*)::text AS count FROM tenants WHERE id = $1 AND deleted_at IS NULL`;
    case "listing_versions":
      return `SELECT count(*)::text AS count FROM listing_versions WHERE listing_id IN (SELECT id FROM listings WHERE tenant_id = $1)`;
    case "tool_versions":
      return `SELECT count(*)::text AS count FROM tool_versions WHERE manifest_id IN (SELECT id FROM tool_manifests WHERE tenant_id = $1)`;
    case "jit_grant_audit":
      return `SELECT count(*)::text AS count FROM jit_grant_audit WHERE jit_grant_id IN (SELECT id FROM jit_grants WHERE tenant_id = $1)`;
    case "users":
      return `SELECT count(DISTINCT user_id)::text AS count FROM tenant_members WHERE tenant_id = $1`;
    case "user_admin_actions":
      return `SELECT count(*)::text AS count FROM user_admin_actions WHERE user_id IN (SELECT user_id FROM tenant_members WHERE tenant_id = $1)`;
    default:
      return `SELECT count(*)::text AS count FROM "${table}" WHERE tenant_id = $1`;
  }
}

/** The same shape as audit-service's tenant pseudonym prefix, unkeyed: a legal retrieval must find records by tenant id. */
export function pseudonymOf(tenantId: string): string {
  return `tnp_${createHash("sha256").update(tenantId).digest("hex")}`;
}

function bareTenant(value: string): string {
  const parsed = TenantIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function requireManifest(value: string): void {
  if (!/^del_[0-9a-f-]{36}$/i.test(value)) throw new Error("manifestId must be del_ prefixed UUID");
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = String(Reflect.get(error, "name") ?? "");
  return name === "ResourceNotFoundException" || name === "SecretNotFoundError";
}
