import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";

export interface BillingIssueView {
  tenant_id: string;
  tenant_name: string;
  state: "grace" | "limited" | "suspended";
  current_plan: string | null;
  first_failed_at: string | null;
  updated_at: string;
}

interface BillingIssueRow {
  tenant_id: string;
  tenant_name: string;
  state: BillingIssueView["state"];
  current_plan: string | null;
  first_failed_at: Date | null;
  updated_at: Date;
}

/**
 * Staff plane, cross-tenant by design (task B2.2). Tenants whose payments
 * failed, read through admin_list_billing_issues() -- a SECURITY DEFINER
 * function (migration 0023), because billing_dunning_states is tenant-RLS.
 */
@Injectable()
export class AdminBillingRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  async listIssues(): Promise<BillingIssueView[]> {
    const result = await this.pool.query<BillingIssueRow>("SELECT * FROM admin_list_billing_issues()");
    return result.rows.map((row) => ({
      tenant_id: row.tenant_id,
      tenant_name: row.tenant_name,
      state: row.state,
      current_plan: row.current_plan,
      first_failed_at: row.first_failed_at?.toISOString() ?? null,
      updated_at: row.updated_at.toISOString(),
    }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }
}
