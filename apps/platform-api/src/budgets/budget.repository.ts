import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { BudgetCurrency, BudgetPeriod, BudgetRecord, BudgetThreshold, UpdateBudgetInput } from "./types";

interface BudgetRow {
  tenant_id: string;
  workspace_id: string;
  id: string;
  name: string;
  amount_minor: string;
  currency: BudgetCurrency;
  period: BudgetPeriod;
  thresholds: BudgetThreshold[];
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export type NewBudget = Omit<BudgetRecord, "createdAt" | "updatedAt">;

/** Tenant plane: every statement runs with the tenant's RLS context. */
@Injectable()
export class BudgetRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  insert(budget: NewBudget): Promise<BudgetRecord> {
    return this.withTenant(budget.tenantId, async (client) => {
      const result = await client.query<BudgetRow>(
        `INSERT INTO budgets
           (tenant_id, workspace_id, id, name, amount_minor, currency, period, thresholds, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING *`,
        [
          budget.tenantId, budget.workspaceId, budget.id, budget.name, budget.amountMinor,
          budget.currency, budget.period, JSON.stringify(budget.thresholds), budget.enabled, budget.createdBy,
        ],
      );
      return mapRow(result.rows[0]!);
    });
  }

  list(tenantId: string, workspaceId: string): Promise<BudgetRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<BudgetRow>(
        `SELECT * FROM budgets WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY created_at, id LIMIT 200`,
        [tenantId, workspaceId],
      );
      return result.rows.map(mapRow);
    });
  }

  update(tenantId: string, workspaceId: string, id: string, input: UpdateBudgetInput): Promise<BudgetRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<BudgetRow>(
        `UPDATE budgets SET
           name = COALESCE($4, name),
           amount_minor = COALESCE($5, amount_minor),
           thresholds = COALESCE($6::jsonb, thresholds),
           enabled = COALESCE($7, enabled),
           updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
         RETURNING *`,
        [
          tenantId, workspaceId, id, input.name ?? null, input.amountMinor ?? null,
          input.thresholds === undefined ? null : JSON.stringify(input.thresholds), input.enabled ?? null,
        ],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  remove(tenantId: string, workspaceId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        "DELETE FROM budgets WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3",
        [tenantId, workspaceId, id],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async withTenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapRow(row: BudgetRow): BudgetRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    id: row.id,
    name: row.name,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    period: row.period,
    thresholds: row.thresholds,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
