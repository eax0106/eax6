import type { Pool, PoolClient } from "pg";
import type { ErasureStore, ErasureTransaction } from "./platform-deletion.service";

/** ErasureStore over a pg pool: one transaction per call, tenant set with set_config (local to it). */
export class PgErasureStore implements ErasureStore {
  constructor(private readonly pool: Pool) {}

  withTenant<T>(tenantId: string, operation: (tx: ErasureTransaction) => Promise<T>): Promise<T> {
    return this.transaction(operation, tenantId);
  }

  withoutTenant<T>(operation: (tx: ErasureTransaction) => Promise<T>): Promise<T> {
    return this.transaction(operation);
  }

  private async transaction<T>(operation: (tx: ErasureTransaction) => Promise<T>, tenantId?: string): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (tenantId !== undefined) {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      }
      const result = await operation(adapt(client));
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

function adapt(client: PoolClient): ErasureTransaction {
  return {
    async query(statement, values) {
      const result = await client.query(statement, values === undefined ? undefined : [...values]);
      return { rowCount: result.rowCount ?? 0, rows: result.rows };
    },
  } as ErasureTransaction;
}
