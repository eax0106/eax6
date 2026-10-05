import { TenantActivityWindowSchema, TenantActivityCountFromStorageSchema, TenantBilledSpendSchema, type TenantActivityWindow, type TenantBilledSpend } from "@alterx/contracts";
import type { RollupStore } from "./cost-rollup.service";

/** Read-only projection with the ledger's canonical integer billing rule. */
export class TenantSpendService {
  constructor(private readonly store: RollupStore, private readonly billable: (minor: string) => string) {}

  spend(input: TenantActivityWindow): Promise<TenantBilledSpend> {
    const window = TenantActivityWindowSchema.parse(input);
    return this.store.withTenant(window.tenant_id, async tx => {
      const result = await tx.query<{ currency: string; internal_minor: string; count: string }>(
        `SELECT currency,SUM(internal_cost_minor)::text AS internal_minor,count(*)::text AS count FROM cost_events
          WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY currency ORDER BY currency`,
        [window.tenant_id, window.start_at, window.end_at],
      );
      return TenantBilledSpendSchema.parse({ ...window, currencies: result.rows.map(row => ({
        currency: row.currency, billed_minor: this.billable(row.internal_minor), event_count: TenantActivityCountFromStorageSchema.parse(row.count),
      })) });
    });
  }
}
