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
import type { ErasableSecretsProvider } from "@alterx/shared-clients";

import { tenantSecretPrefix } from "../trigger-bindings/ids";

import { sweepRunHistory } from "../run-retention/run-retention.service";

interface TransactionLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly T[] }>;
}
export interface DeletionTenantStore {
  withTenant<T>(tenantId: string, operation: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

const STORE = "orchestration-service";
// Where verifyDeletion reports webhook signing secrets left in the provider.
const WEBHOOK_SECRETS_LOCATION = "secrets:alter/webhook-endpoints";
// Every tenant-scoped table in this service's schema (29, drizzle/0000-0035).
// This list is hand-maintained -- ENGINE-FIX-P0-2 closed a gap where 10 of
// these (everything from migration 0019 onward) were missing, so
// verifyDeletion certified erasure complete while their rows survived.
// Adding a new tenant-scoped table without adding it here reintroduces that
// gap; there is currently no schema-derived check that would catch it.
// Exported only so deletion.integration.spec.ts can assert this exact,
// real, production array against a live schema -- not a hand-copied
// duplicate of it that could itself silently drift from this one.
export const TABLES = [
  "connection_registry",
  "trigger_webhook_secrets",
  "workflow_template_variable_values", "workflow_template_variable_definitions",
  "workflows", "workflow_versions", "triggers", "trigger_versions", "clarifications", "conversations",
  "conversation_goal_states", "events", "runs", "blackboard_checkpoints", "node_executions",
  "run_stream_events", "verification_results", "recovery_actions", "run_outcomes", "approvals",
  "projects", "deployments", "project_plans", "artifacts", "whatsapp_accounts",
  "webhook_endpoints", "webhook_endpoint_secrets", "trigger_integration_bindings",
  "escalations", "run_dispatch_queue", "side_effects",
  "budgets", "budget_usage", "budget_reservations",
  "workspace_holds",
  "workspace_run_retention",
  "approval_step_policies",
] as const;
// Children before parents. A child ordered after a table it has a plain FK
// to makes the DELETE fail outright; a child ordered after a table it has
// an ON DELETE CASCADE FK to makes the child's row vanish via cascade
// before its own explicit DELETE runs, silently undercounting deletedRows
// (this order used to get that wrong for escalations -> recovery_actions/
// node_executions/runs -- caught by deletion.integration.spec.ts, not by
// reading the migrations carefully enough by hand).
//
// This exact order is the output of a topological sort over every FK in
// apps/orchestration-service/drizzle/*.sql (all 40 REFERENCES clauses,
// cross-checked by count against `grep -c REFERENCES *.sql`), not a
// hand-derived guess. If a new migration adds a table or a FK, regenerate
// rather than hand-editing: extract every {child, parent} pair from
// CREATE TABLE / ALTER TABLE ... REFERENCES statements in that folder and
// run Kahn's algorithm over the 30 TABLES nodes; child must precede parent
// for every edge.
// Exported for the same reason as TABLES above.
export const DELETE_ORDER = [
  "connection_registry",
  "workspace_holds", "workspace_run_retention", "approval_step_policies", "budget_reservations", "budget_usage", "budgets", "approvals", "blackboard_checkpoints", "clarifications", "conversation_goal_states",
  "deployments", "artifacts", "escalations", "project_plans", "recovery_actions",
  "run_dispatch_queue", "run_outcomes", "run_stream_events", "side_effects", "trigger_integration_bindings",
  "trigger_webhook_secrets", "verification_results", "node_executions", "runs", "events",
  "conversations", "projects", "trigger_versions", "triggers", "webhook_endpoint_secrets",
  "webhook_endpoints", "whatsapp_accounts", "workflow_template_variable_definitions",
  "workflow_template_variable_values", "workflow_versions", "workflows",
] as const;

export class OrchestrationDeletionService implements DeletionProvider, WorkspaceDeletionProvider {
  constructor(
    private readonly store: DeletionTenantStore,
    private readonly systemStore: DeletionTenantStore = store,
    // Holds the tenant's webhook signing secrets (alter/webhook-endpoints/...).
    // Erasure deletes them and verification lists the prefix to prove none is
    // left; without it, erasure of those secrets cannot be claimed.
    private readonly secrets?: ErasableSecretsProvider,
  ) {}

  async locateSubjectData(tenantId: string): Promise<readonly SubjectDataLocation[]> {
    const tenant = bareTenant(tenantId);
    return this.store.withTenant(tenant, async (tx) => {
      const locations: SubjectDataLocation[] = [];
      for (const table of TABLES) {
        const result = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id=$1`, [tenant],
        );
        locations.push({ store: STORE, table, rowCount: Number(result.rows[0]?.count ?? 0), objectReferences: [] });
      }
      return locations;
    });
  }

  async deleteSubjectData(tenantId: string, manifestId: string): Promise<DeletionResult> {
    const tenant = bareTenant(tenantId);
    requireManifest(manifestId);
    // Secrets first: if this fails the rows still exist and a retry finds the
    // same endpoints. Listing the prefix also catches secrets whose rows are
    // already gone. deleteSecret is idempotent, so a retry is safe.
    let deletedObjects = 0;
    if (this.secrets !== undefined) {
      for (const reference of await this.secrets.listSecretReferences(tenantSecretPrefix(`ten_${tenant}`))) {
        await this.secrets.deleteSecret(reference);
        deletedObjects += 1;
      }
    }
    const deletedRows = await this.store.withTenant(tenant, async (tx) => {
      let deleted = 0;
      for (const table of DELETE_ORDER) {
        deleted += (await tx.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant])).rowCount;
      }
      return deleted;
    });
    return { store: STORE, manifestId, deletedRows, deletedObjects };
  }

  async verifyDeletion(tenantId: string, manifestId: string): Promise<VerificationResult> {
    const remaining = (await this.locateSubjectData(tenantId)).filter((item) => item.rowCount > 0);
    if (this.secrets !== undefined) {
      const secrets = await this.secrets.listSecretReferences(tenantSecretPrefix(`ten_${bareTenant(tenantId)}`));
      if (secrets.length > 0) {
        remaining.push({ store: STORE, table: WEBHOOK_SECRETS_LOCATION, rowCount: secrets.length, objectReferences: [] });
      }
    }
    return { store: STORE, manifestId, deleted: remaining.length === 0, remaining };
  }

  async applyRetentionPolicy(): Promise<RetentionSweepResult> {
    let deletedRows = 0;
    for (const tenantId of await this.listSubjectIds()) {
      deletedRows += (await this.applyTenantRetentionPolicy(tenantId)).deletedRows;
    }
    return {
      store: STORE,
      deletedRows,
      deletedObjects: 0,
      sweptAt: new Date().toISOString(),
    };
  }

  async applyTenantRetentionPolicy(tenantId: string): Promise<RetentionSweepResult> {
    const tenant = bareTenant(tenantId);
    const deletedRows = await this.store.withTenant(tenant, async (tx) => {
      let changed = 0;
      changed += (await tx.query(
        `UPDATE node_executions SET input_ref=NULL, output_ref=NULL
         WHERE tenant_id=$1 AND ended_at < now() - interval '90 days'
           AND (input_ref IS NOT NULL OR output_ref IS NOT NULL)`, [tenant],
      )).rowCount;
      const closed = await tx.query<{ id: string }>(
        `SELECT id FROM conversations WHERE tenant_id=$1 AND closed_at < now() - interval '90 days'`, [tenant],
      );
      for (const row of closed.rows) {
        changed += (await tx.query("DELETE FROM events WHERE tenant_id=$1 AND conversation_id=$2", [tenant, row.id])).rowCount;
        changed += (await tx.query("DELETE FROM runs WHERE tenant_id=$1 AND conversation_id=$2", [tenant, row.id])).rowCount;
        changed += (await tx.query("DELETE FROM conversation_goal_states WHERE tenant_id=$1 AND conversation_id=$2", [tenant, row.id])).rowCount;
        changed += (await tx.query("DELETE FROM conversations WHERE tenant_id=$1 AND id=$2", [tenant, row.id])).rowCount;
      }
      // D2: each workspace's run-history retention (365 days unless set).
      changed += await sweepRunHistory(tx, tenant);
      return changed;
    });
    return { store: STORE, deletedRows, deletedObjects: 0, sweptAt: new Date().toISOString() };
  }

  /**
   * D2: one workspace's rows, scoped from the live schema (planWorkspaceScope).
   * Every engine table is workspace data, so a table the plan cannot scope is
   * an error rather than silently skipped.
   */
  async locateWorkspaceData(tenantId: string, workspaceId: string): Promise<readonly SubjectDataLocation[]> {
    const { tenant, workspace } = workspaceSubject(tenantId, workspaceId);
    return this.store.withTenant(tenant, async (tx) => {
      const scope = await workspacePredicates(tx);
      const locations: SubjectDataLocation[] = [];
      for (const table of TABLES) {
        const result = await tx.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE ${scope.get(table)!}`, [tenant, workspace],
        );
        locations.push({ store: STORE, table, rowCount: Number(result.rows[0]?.count ?? 0), objectReferences: [] });
      }
      return locations;
    });
  }

  async deleteWorkspaceData(tenantId: string, workspaceId: string, manifestId: string): Promise<DeletionResult> {
    const { tenant, workspace } = workspaceSubject(tenantId, workspaceId);
    requireManifest(manifestId);
    // The workspace's webhook signing secrets go before its rows, as in the
    // tenant's erasure: a failure leaves the endpoints for a retry to find.
    let deletedObjects = 0;
    if (this.secrets !== undefined) {
      const endpoints = await this.store.withTenant(tenant, async (tx) => {
        const scope = await workspacePredicates(tx);
        return (await tx.query<{ id: string }>(
          `SELECT id FROM webhook_endpoints WHERE ${scope.get("webhook_endpoints")!}`, [tenant, workspace],
        )).rows.map((row) => row.id);
      });
      for (const endpoint of endpoints) {
        for (const reference of await this.secrets.listSecretReferences(`${tenantSecretPrefix(`ten_${tenant}`)}${endpoint}/`)) {
          await this.secrets.deleteSecret(reference);
          deletedObjects += 1;
        }
      }
    }
    const deletedRows = await this.store.withTenant(tenant, async (tx) => {
      const scope = await workspacePredicates(tx);
      let deleted = 0;
      // Children first, while their parents still exist for the predicates.
      for (const table of DELETE_ORDER) {
        deleted += (await tx.query(`DELETE FROM ${table} WHERE ${scope.get(table)!}`, [tenant, workspace])).rowCount;
      }
      return deleted;
    });
    return { store: STORE, manifestId, deletedRows, deletedObjects };
  }

  async verifyWorkspaceDeletion(tenantId: string, workspaceId: string, manifestId: string): Promise<VerificationResult> {
    const remaining = (await this.locateWorkspaceData(tenantId, workspaceId)).filter((item) => item.rowCount > 0);
    if (this.secrets !== undefined) {
      // No signing secret may outlive its endpoint: with the workspace's
      // endpoints gone, any of its secrets left is an orphan.
      const tenant = bareTenant(tenantId);
      const prefix = tenantSecretPrefix(`ten_${tenant}`);
      const references = await this.secrets.listSecretReferences(prefix);
      const endpoints = new Set(await this.store.withTenant(tenant, async (tx) =>
        (await tx.query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE tenant_id = $1", [tenant])).rows.map((row) => row.id),
      ));
      const orphans = references.filter((reference) => !endpoints.has(reference.slice(prefix.length).split("/")[0] ?? ""));
      if (orphans.length > 0) {
        remaining.push({ store: STORE, table: WEBHOOK_SECRETS_LOCATION, rowCount: orphans.length, objectReferences: [] });
      }
    }
    return { store: STORE, manifestId, deleted: remaining.length === 0, remaining };
  }

  async replayDeletionLedger(sinceTimestamp: string): Promise<ReplayResult> {
    void sinceTimestamp;
    throw new Error("Deletion-ledger replay is coordinated by audit-service");
  }

  async listSubjectIds(): Promise<readonly string[]> {
    return this.systemStore.withTenant("00000000-0000-7000-8000-000000000000", async (tx) => {
      const result = await tx.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id::text FROM (
           SELECT tenant_id FROM workflows UNION SELECT tenant_id FROM workflow_versions
           UNION SELECT tenant_id FROM trigger_webhook_secrets
           UNION SELECT tenant_id FROM workflow_template_variable_definitions
           UNION SELECT tenant_id FROM workflow_template_variable_values
           UNION SELECT tenant_id FROM clarifications
           UNION SELECT tenant_id FROM connection_registry
           UNION SELECT tenant_id FROM triggers UNION SELECT tenant_id FROM trigger_versions
           UNION SELECT tenant_id FROM conversations UNION SELECT tenant_id FROM conversation_goal_states
           UNION SELECT tenant_id FROM events UNION SELECT tenant_id FROM runs
           UNION SELECT tenant_id FROM blackboard_checkpoints UNION SELECT tenant_id FROM node_executions
           UNION SELECT tenant_id FROM run_stream_events UNION SELECT tenant_id FROM verification_results
           UNION SELECT tenant_id FROM recovery_actions UNION SELECT tenant_id FROM run_outcomes
           UNION SELECT tenant_id FROM approvals
         ) subjects ORDER BY tenant_id`,
      );
      return result.rows.map((row) => `ten_${row.tenant_id}`);
    });
  }
}

async function workspacePredicates(tx: TransactionLike): Promise<ReadonlyMap<string, string>> {
  const plan = await planWorkspaceScope(tx, TABLES);
  if (plan.unscoped.length > 0) {
    throw new Error(`Workspace erasure cannot scope tables: ${plan.unscoped.join(", ")}`);
  }
  return plan.scoped;
}

function workspaceSubject(tenantId: string, workspaceId: string): { tenant: string; workspace: string } {
  const parsed = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) throw new Error("workspaceId must be a ws_ prefixed UUIDv7");
  return { tenant: bareTenant(tenantId), workspace: parsed.data.slice(3) };
}

function bareTenant(value: string): string {
  const parsed = TenantIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice(4);
}

function requireManifest(value: string): void {
  if (!/^del_[0-9a-f-]{36}$/i.test(value)) throw new Error("manifestId must be del_ prefixed UUID");
}
