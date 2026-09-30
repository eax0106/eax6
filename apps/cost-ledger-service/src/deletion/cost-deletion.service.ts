import type {
  DeletionProvider,
  DeletionResult,
  ReplayResult,
  RetentionSweepResult,
  SubjectDataLocation,
  VerificationResult,
} from "@alterx/contracts";
import { TenantIdSchema } from "@alterx/contracts";
import type { CostTransaction } from "@alterx/adapters";

export interface CostDeletionStore {
  withProvisioner<T>(operation: (tx: CostTransaction) => Promise<T>): Promise<T>;
}

const STORE = "cost-ledger-service";

// Every tenant-scoped table in cost_db. scripts/deletion/certify.ts parses this exact block.
export const COST_TABLES = ["billing_rollups", "cost_events", "model_outcomes", "run_verdicts"] as const;

/**
 * Erasure of cost_db (D2, C3b). Costs, model outcomes and run verdicts go.
 * billing_rollups are the basis of what a tenant was invoiced, which the law
 * keeps (tax and billing records, about 72 months): they lose their tenant
 * reference (they already carry an HMAC pseudonym) and their breakdown, and keep
 * only totals and the period. The retention sweeper destroys them when the
 * period has passed.
 */
export class CostDeletionService implements DeletionProvider {
  constructor(private readonly store: CostDeletionStore) {}

  locateSubjectData(tenantId: string): Promise<readonly SubjectDataLocation[]> {
    const tenant = bareTenant(tenantId);
    return this.store.withProvisioner(async (tx) => {
      const locations: SubjectDataLocation[] = [];
      for (const table of COST_TABLES) {
        const result = await tx.query<{ count: SubjectDataLocation["rowCount"] }>(
          `SELECT count(*)::int AS count FROM "${table}" WHERE tenant_id = $1`,
          [tenant],
        );
        locations.push({ store: STORE, table, rowCount: result.rows[0]?.count ?? 0, objectReferences: [] });
      }
      return locations;
    });
  }

  async deleteSubjectData(tenantId: string, manifestId: string): Promise<DeletionResult> {
    const tenant = bareTenant(tenantId);
    requireManifest(manifestId);
    const deletedRows = await this.store.withProvisioner(async (tx) => {
      let changed = 0;
      for (const table of ["cost_events", "model_outcomes", "run_verdicts"] as const) {
        changed += (await tx.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenant])).rowCount;
      }
      changed += (
        await tx.query(
          `UPDATE billing_rollups SET tenant_id = NULL, detail = '{}'::jsonb, finalized = true WHERE tenant_id = $1`,
          [tenant],
        )
      ).rowCount;
      return changed;
    });
    return { store: STORE, manifestId, deletedRows, deletedObjects: 0 };
  }

  async verifyDeletion(tenantId: string, manifestId: string): Promise<VerificationResult> {
    const remaining = (await this.locateSubjectData(tenantId)).filter((item) => item.rowCount > 0);
    return { store: STORE, manifestId, deleted: remaining.length === 0, remaining };
  }

  async applyRetentionPolicy(): Promise<RetentionSweepResult> {
    // The sweep that destroys expired rollups lands with the retention sweeper.
    return { store: STORE, deletedRows: 0, deletedObjects: 0, sweptAt: new Date().toISOString() };
  }

  async replayDeletionLedger(sinceTimestamp: string): Promise<ReplayResult> {
    void sinceTimestamp;
    throw new Error("Deletion-ledger replay is coordinated by audit-service");
  }

  async listSubjectIds(): Promise<readonly string[]> {
    return this.store.withProvisioner(async (tx) => {
      const result = await tx.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id::text FROM (
           SELECT tenant_id FROM cost_events UNION SELECT tenant_id FROM model_outcomes
           UNION SELECT tenant_id FROM run_verdicts UNION SELECT tenant_id FROM billing_rollups WHERE tenant_id IS NOT NULL
         ) subjects ORDER BY tenant_id`,
      );
      return result.rows.map((row) => `ten_${row.tenant_id}`);
    });
  }
}

function bareTenant(value: string): string {
  const parsed = TenantIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function requireManifest(value: string): void {
  if (!/^del_[0-9a-f-]{36}$/i.test(value)) throw new Error("manifestId must be del_ prefixed UUID");
}
