import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { JsonValue } from "@alterx/shared-clients";
import type { Pool, PoolClient } from "pg";
import type { EntitlementAccessState } from "../entitlements";
import { PlanCommercialSchema, type PlanCommercial } from "../entitlements/plan-commercial";

export interface SubscriptionLifecycleRow {
  subscription_ref: string | null;
  provider_plan_ref: string | null;
  current_plan: string | null;
  status: string;
  checkout_attempt_id: string | null;
  last_provider_event_at: string;
  commercial_snapshot: PlanCommercial | null;
  mutation_attempt_id?: string | null;
  mutation_kind?: "change" | "cancel" | null;
  pending_plan?: string | null;
  pending_provider_plan_ref?: string | null;
  pending_commercial_snapshot?: PlanCommercial | null;
}

export interface DunningStateRecord {
  state: EntitlementAccessState;
  currentPlan: string | null;
  firstFailedAt: Date | null;
}

@Injectable()
export class BillingWebhookRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  async lockProfile(client: PoolClient, tenantId: string): Promise<SubscriptionLifecycleRow | null> {
    const result = await client.query<SubscriptionLifecycleRow>("SELECT * FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
    const row = result.rows[0];
    if (row?.commercial_snapshot) PlanCommercialSchema.parse(row.commercial_snapshot);
    return row ?? null;
  }

  async updateProviderState(client: PoolClient, tenantId: string, status: string, timestamp: number): Promise<void> {
    await client.query("UPDATE billing_profiles SET status=$2,last_provider_event_at=$3,updated_at=clock_timestamp() WHERE tenant_id=$1",[tenantId,status,timestamp]);
  }

  async bindCheckout(client: PoolClient, tenantId: string, subscriptionId: string, attemptId: string, providerPlan: string): Promise<void> {
    await client.query(`UPDATE billing_profiles SET subscription_ref=$2,checkout_attempt_id=NULL,status='created',
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND checkout_attempt_id=$3 AND provider_plan_ref=$4 AND subscription_ref IS NULL`,
    [tenantId,subscriptionId,attemptId,providerPlan]);
    await client.query(`INSERT INTO billing_subscription_plans(tenant_id,subscription_ref,provider_plan_ref,internal_plan,commercial_snapshot)
      SELECT tenant_id,subscription_ref,provider_plan_ref,current_plan,commercial_snapshot FROM billing_profiles WHERE tenant_id=$1
      ON CONFLICT(tenant_id,subscription_ref,provider_plan_ref) DO NOTHING`,[tenantId]);
    await this.auditTransition(client,{tenantId,providerEventId:`checkout:${attemptId}`,fromState:"active",toState:"active",reason:"checkout_bound_by_provider"});
  }

  async historicalPlan(client: PoolClient,tenantId: string,subscriptionId: string,providerPlan: string): Promise<{commercial_snapshot:PlanCommercial;internal_plan:string} | null> {
    const result=await client.query<{commercial_snapshot:PlanCommercial;internal_plan:string}>("SELECT commercial_snapshot,internal_plan FROM billing_subscription_plans WHERE tenant_id=$1 AND subscription_ref=$2 AND provider_plan_ref=$3",[tenantId,subscriptionId,providerPlan]);
    if(result.rows[0]) PlanCommercialSchema.parse(result.rows[0].commercial_snapshot);
    return result.rows[0]??null;
  }

  async promotePendingPlan(client: PoolClient,tenantId: string,eventId: string): Promise<void> {
    const result=await client.query(`UPDATE billing_profiles SET current_plan=pending_plan,provider_plan_ref=pending_provider_plan_ref,
      commercial_snapshot=pending_commercial_snapshot,mutation_attempt_id=NULL,mutation_kind=NULL,pending_plan=NULL,
      pending_provider_plan_ref=NULL,pending_commercial_snapshot=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND mutation_kind='change' RETURNING tenant_id,subscription_ref,provider_plan_ref,current_plan,commercial_snapshot`,[tenantId]);
    const row=result.rows[0];if(!row) return;
    await client.query(`INSERT INTO billing_subscription_plans(tenant_id,subscription_ref,provider_plan_ref,internal_plan,commercial_snapshot)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,subscription_ref,provider_plan_ref) DO NOTHING`,
    [tenantId,row.subscription_ref,row.provider_plan_ref,row.current_plan,JSON.stringify(row.commercial_snapshot)]);
    await this.auditTransition(client,{tenantId,providerEventId:eventId,fromState:"active",toState:"active",reason:"subscription_plan_confirmed"});
  }

  async clearMutation(client: PoolClient,tenantId: string): Promise<void> {
    await client.query(`UPDATE billing_profiles SET mutation_attempt_id=NULL,mutation_kind=NULL,pending_plan=NULL,
      pending_provider_plan_ref=NULL,pending_commercial_snapshot=NULL WHERE tenant_id=$1`,[tenantId]);
  }

  async enqueueCredits(client: PoolClient, tenantId: string, paymentRef: string, credits: number, eventId: string): Promise<void> {
    const inserted = await client.query(`INSERT INTO billing_credit_deliveries(tenant_id,payment_ref,credits,provider_event_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,payment_ref) DO NOTHING`,[tenantId,paymentRef,credits,eventId]);
    if (!inserted.rowCount) {
      const existing = await client.query<{credits:number}>("SELECT credits FROM billing_credit_deliveries WHERE tenant_id=$1 AND payment_ref=$2",[tenantId,paymentRef]);
      if (existing.rows[0]?.credits !== credits) throw new Error("Billing credit quantity conflicts with captured payment");
    }
  }

  async transaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
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

  async insertEvent(
    client: PoolClient,
    input: {
      tenantId: string;
      providerId: string;
      providerEventId: string;
      type: string;
      payload: JsonValue;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO billing_events
         (tenant_id, provider_id, provider_event_id, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [
        input.tenantId,
        input.providerId,
        input.providerEventId,
        input.type,
        JSON.stringify(input.payload),
      ],
    );
    return result.rowCount === 1;
  }

  async markEventProcessed(
    client: PoolClient,
    tenantId: string,
    providerEventId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE billing_events
          SET processed_at = clock_timestamp()
        WHERE tenant_id = $1 AND provider_event_id = $2`,
      [tenantId, providerEventId],
    );
  }

  async getDunningState(
    client: PoolClient,
    tenantId: string,
  ): Promise<DunningStateRecord> {
    const result = await client.query<{
      state: EntitlementAccessState;
      current_plan: string | null;
      first_failed_at: Date | null;
    }>(
      `SELECT state, current_plan, first_failed_at
         FROM billing_dunning_states
        WHERE tenant_id = $1
        FOR UPDATE`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row) {
      return {
        state: row.state,
        currentPlan: row.current_plan,
        firstFailedAt: row.first_failed_at,
      };
    }
    const profile = await client.query<{ plan: string; access_state: EntitlementAccessState }>(
      `SELECT plan,access_state FROM entitlements WHERE tenant_id=$1
        AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_to IS NULL OR effective_to>clock_timestamp())
        ORDER BY effective_from DESC NULLS LAST,created_at DESC LIMIT 1`,
      [tenantId],
    );
    return {
      state: profile.rows[0]?.access_state ?? "active",
      currentPlan: profile.rows[0]?.plan === "free" ? null : profile.rows[0]?.plan ?? null,
      firstFailedAt: null,
    };
  }

  async saveDunningState(
    client: PoolClient,
    tenantId: string,
    state: DunningStateRecord,
  ): Promise<void> {
    await client.query(
      `INSERT INTO billing_dunning_states
         (tenant_id, state, current_plan, first_failed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE
         SET state = EXCLUDED.state,
             current_plan = EXCLUDED.current_plan,
             first_failed_at = EXCLUDED.first_failed_at,
             updated_at = clock_timestamp()`,
      [tenantId, state.state, state.currentPlan, state.firstFailedAt],
    );
  }

  async auditTransition(
    client: PoolClient,
    input: {
      tenantId: string;
      providerEventId: string;
      fromState: EntitlementAccessState;
      toState: EntitlementAccessState;
      reason: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO billing_dunning_audits
         (tenant_id, id, provider_event_id, from_state, to_state, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.tenantId,
        randomUUID(),
        input.providerEventId,
        input.fromState,
        input.toState,
        input.reason,
      ],
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }
}
