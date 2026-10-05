import { TenantActivityWindowSchema, TenantEngineActivitySchema, type TenantActivityWindow, type TenantEngineActivity } from "@alterx/contracts";
import type { OrchestrationTenantStore } from "../workflow-lifecycle/workflow-lifecycle.service";

/** Tenant projection only: no planner calls, execution or durable snapshot writes. */
export class TenantActivityService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  activity(input: TenantActivityWindow): Promise<TenantEngineActivity> {
    const window = TenantActivityWindowSchema.parse(input);
    return this.store.withTenant(window.tenant_id, async tx => {
      const counts = await tx.query<{ workflows: string; runs: string }>(
        `SELECT (SELECT count(*) FROM workflows WHERE tenant_id=$1)::text AS workflows,
          (SELECT count(*) FROM runs WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3)::text AS runs`,
        [window.tenant_id, window.start_at, window.end_at],
      );
      const workflows = await tx.query<{ id: string; workspace_id: string; name: string; status: string; updated_at: Date }>(
        "SELECT id,workspace_id::text,name,status,updated_at FROM workflows WHERE tenant_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 50", [window.tenant_id],
      );
      const runs = await tx.query<{ id: string; workspace_id: string; workflow_id: string | null; status: string; created_at: Date }>(
        `SELECT id,workspace_id::text,workflow_id,status,created_at FROM runs
          WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at DESC,id DESC LIMIT 50`,
        [window.tenant_id, window.start_at, window.end_at],
      );
      return TenantEngineActivitySchema.parse({ ...window, workflow_count: Number(counts.rows[0]!.workflows), run_count: Number(counts.rows[0]!.runs),
        workflows: workflows.rows.map(row => ({ ...row, updated_at: row.updated_at.toISOString() })),
        runs: runs.rows.map(row => ({ ...row, created_at: row.created_at.toISOString() })),
      });
    });
  }
}
