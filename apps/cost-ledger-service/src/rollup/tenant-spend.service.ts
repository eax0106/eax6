import { TenantActivityWindowSchema, TenantBilledSpendSchema, type TenantActivityWindow, type TenantBilledSpend } from "@alterx/contracts";
import { applyMargin, type RollupStore } from "./cost-rollup.service";

/** Read-only projection with the ledger's canonical integer billing rule. */
export class TenantSpendService {
  constructor(private readonly store: RollupStore, private readonly marginRate: number) {
    if (!Number.isFinite(marginRate) || marginRate < 0 || Math.round(marginRate * 1_000_000) >= 1_000_000) throw new Error("Invalid billing margin rate");
  }

  spend(input: TenantActivityWindow): Promise<TenantBilledSpend> {
    const window = TenantActivityWindowSchema.parse(input);
    return this.store.withTenant(window.tenant_id, async tx => {
      const result = await tx.query<{ currency: string; internal_minor: string; count: string }>(
        `SELECT currency,SUM(internal_cost_minor)::text AS internal_minor,count(*)::text AS count FROM cost_events
          WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY currency ORDER BY currency`,
        [window.tenant_id, window.start_at, window.end_at],
      );
      return TenantBilledSpendSchema.parse({ ...window, currencies: result.rows.map(row => ({
        currency: row.currency, billed_minor: applyMargin(row.internal_minor, this.marginRate), event_count: Number(row.count),
      })) });
    });
  }
}
