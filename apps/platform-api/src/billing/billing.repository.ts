import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type {
  BillingReferenceStore,
  BillingTenantReferences,
} from "@alterx/adapters";
import type { PaymentMethodRef, Subscription } from "@alterx/shared-clients";
import type { Pool, PoolClient } from "pg";
import type { PlanDefinitionRecord } from "../entitlements/plan-definition-store";
import { computeEtag, ifMatchIncludes } from "../concurrency/etag";
import { BillingHttpError } from "./problem";
import type { BillingProfileRecord } from "./types";

interface BillingProfileRow {
  tenant_id: string;
  id: string;
  provider_id: string;
  provider_customer_ref: string | null;
  subscription_ref: string | null;
  status: string;
  current_plan: string | null;
  created_at: Date;
  updated_at: Date;
  gstin?: string | null;
  commercial_snapshot?: import("../entitlements/plan-commercial").PlanCommercial | null;
  provider_plan_ref?: string | null;
  checkout_attempt_id?: string | null;
  checkout_started_at?: Date | null;
  mutation_attempt_id?: string | null;
  mutation_kind?: "change" | "cancel" | null;
  pending_plan?: string | null;
  pending_provider_plan_ref?: string | null;
  pending_commercial_snapshot?: import("../entitlements/plan-commercial").PlanCommercial | null;
}

interface PaymentMethodRow {
  ref: string;
  type: string;
  brand: string | null;
  last4: string | null;
}

@Injectable()
export class BillingRepository
  implements BillingReferenceStore, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  getProfile(tenantId: string): Promise<BillingProfileRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<BillingProfileRow>(
        `SELECT * FROM billing_profiles WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows[0] ? mapProfile(result.rows[0]) : null;
    });
  }

  async getTenantReferences(
    tenantId: string,
  ): Promise<BillingTenantReferences | null> {
    const profile = await this.getProfile(tenantId);
    return profile
      ? {
          providerCustomerRef: profile.providerCustomerRef,
          subscriptionRef: profile.subscriptionRef,
        }
      : null;
  }

  setSubscriptionReferences(
    tenantId: string,
    references: BillingTenantReferences,
  ): Promise<void> {
    return this.withTenant(tenantId, async (client) => {
      const id = randomUUID();
      const result = await client.query<{ id: string }>(
        `INSERT INTO billing_profiles
           (tenant_id, id, provider_id, provider_customer_ref,
            subscription_ref, status)
         VALUES ($1, $2, 'razorpay', $3, $4, 'created')
         ON CONFLICT (tenant_id) DO UPDATE
           SET provider_customer_ref = EXCLUDED.provider_customer_ref,
               subscription_ref = EXCLUDED.subscription_ref,
               updated_at = clock_timestamp()
         RETURNING id`,
        [
          tenantId,
          id,
          references.providerCustomerRef,
          references.subscriptionRef,
        ],
      );
      await client.query(
        `UPDATE tenants SET billing_profile_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [tenantId, result.rows[0]!.id],
      );
    });
  }

  syncSubscription(
    tenantId: string,
    subscription: Subscription,
  ): Promise<BillingProfileRecord> {
    return this.withTenant(tenantId, async (client) => {
      const id = randomUUID();
      const result = await client.query<BillingProfileRow>(
        `INSERT INTO billing_profiles
           (tenant_id, id, provider_id, provider_customer_ref,
            subscription_ref, status, current_plan)
         VALUES ($1, $2, 'razorpay', $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE
           SET provider_customer_ref =
                 COALESCE(EXCLUDED.provider_customer_ref,
                          billing_profiles.provider_customer_ref),
               subscription_ref = EXCLUDED.subscription_ref,
               status = EXCLUDED.status,
               current_plan = EXCLUDED.current_plan,
               updated_at = clock_timestamp()
         RETURNING *`,
        [
          tenantId,
          id,
          subscription.providerCustomerRef,
          subscription.id,
          subscription.status,
          subscription.planId,
        ],
      );
      const profile = result.rows[0]!;
      await client.query(
        `UPDATE tenants SET billing_profile_id = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [tenantId, profile.id],
      );
      return mapProfile(profile);
    });
  }

  claimCheckout(tenantId: string, actorRef: string, definition: PlanDefinitionRecord, gstin?: string): Promise<string> {
    return this.withTenant(tenantId, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`billing-checkout:${tenantId}`]);
      const configured = await client.query<{ updated_at: Date }>("SELECT updated_at FROM plan_definitions WHERE plan=$1 FOR SHARE",[definition.plan]);
      if (configured.rows[0]?.updated_at.toISOString() !== definition.updatedAt.toISOString()) {
        throw new BillingHttpError(412,"BILLING_PLAN_CHANGED","Plan changed; review its current price","/api/v1/billing/subscription");
      }
      const current = await client.query<BillingProfileRow>("SELECT * FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      const row = current.rows[0];
      if (row && (row.checkout_attempt_id || row.mutation_attempt_id || (row.subscription_ref && !["cancelled", "completed", "expired"].includes(row.status)))) {
        throw new BillingHttpError(409, "BILLING_SUBSCRIPTION_EXISTS", "Existing checkout or subscription must be resolved first", "/api/v1/billing/subscription");
      }
      const attemptId = randomUUID(), profileId = row?.id ?? randomUUID();
      await client.query(`INSERT INTO billing_profiles (tenant_id,id,provider_id,status,current_plan,
          gstin,commercial_snapshot,provider_plan_ref,checkout_attempt_id,checkout_started_at)
        VALUES ($1,$2,'razorpay','checkout_creating',$3,$4,$5::jsonb,$6,$7,clock_timestamp())
        ON CONFLICT (tenant_id) DO UPDATE SET status='checkout_creating',current_plan=$3,gstin=$4,
          commercial_snapshot=$5::jsonb,provider_plan_ref=$6,checkout_attempt_id=$7,checkout_started_at=clock_timestamp(),
          subscription_ref=NULL,last_provider_event_at=0,updated_at=clock_timestamp()`,
        [tenantId,profileId,definition.plan,gstin ?? null,JSON.stringify(definition.commercial),definition.commercial?.razorpayPlanId,attemptId]);
      await client.query("UPDATE tenants SET billing_profile_id=$2,updated_at=clock_timestamp() WHERE id=$1", [tenantId,profileId]);
      await this.auditCheckout(client,tenantId,attemptId,actorRef,"checkout_claimed");
      return attemptId;
    });
  }

  finishCheckout(tenantId: string, actorRef: string, attemptId: string, subscription: Subscription): Promise<BillingProfileRecord> {
    return this.withTenant(tenantId, async client => {
      if (subscription.tenantId !== tenantId || !/^sub_[A-Za-z0-9]{1,100}$/.test(subscription.id)) {
        throw new BillingHttpError(502,"BILLING_PROFILE_INCONSISTENT","Checkout response does not match its tenant","/api/v1/billing/subscription");
      }
      const locked = await client.query<BillingProfileRow>("SELECT * FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
      const current = locked.rows[0];
      // A signed callback may bind and activate before the create response arrives.
      if (current && !current.checkout_attempt_id && current.subscription_ref === subscription.id &&
          current.provider_plan_ref === subscription.planId) return mapProfile(current);
      const result = await client.query<BillingProfileRow>(`UPDATE billing_profiles SET subscription_ref=$3,
          provider_customer_ref=$4,status='created',checkout_attempt_id=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND checkout_attempt_id=$2 AND provider_plan_ref=$5
        RETURNING *`, [tenantId,attemptId,subscription.id,subscription.providerCustomerRef,subscription.planId]);
      if (!result.rows[0]) throw new BillingHttpError(409,"BILLING_CHECKOUT_CHANGED","Checkout state changed","/api/v1/billing/subscription");
      const row=result.rows[0];
      await client.query(`INSERT INTO billing_subscription_plans(tenant_id,subscription_ref,provider_plan_ref,internal_plan,commercial_snapshot)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,subscription_ref,provider_plan_ref) DO NOTHING`,
      [tenantId,row.subscription_ref,row.provider_plan_ref,row.current_plan,JSON.stringify(row.commercial_snapshot)]);
      await this.auditCheckout(client,tenantId,attemptId,actorRef,"checkout_created");
      return mapProfile(result.rows[0]);
    });
  }

  claimMutation(tenantId: string, actorRef: string, kind: "change" | "cancel", ifMatch: string | undefined,
    definition?: PlanDefinitionRecord): Promise<BillingProfileRecord> {
    return this.withTenant(tenantId,async client=>{
      if (!ifMatch) throw new BillingHttpError(428,"PRECONDITION_REQUIRED","If-Match header is required","/api/v1/billing/subscription");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`billing-checkout:${tenantId}`]);
      if (definition) {
        const current=await client.query<{updated_at:Date}>("SELECT updated_at FROM plan_definitions WHERE plan=$1 FOR SHARE",[definition.plan]);
        if(current.rows[0]?.updated_at.toISOString()!==definition.updatedAt.toISOString()) throw new BillingHttpError(412,"BILLING_PLAN_CHANGED","Plan changed; review its current price","/api/v1/billing/subscription");
      }
      const locked=await client.query<BillingProfileRow>("SELECT * FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE",[tenantId]),row=locked.rows[0];
      if (!row?.subscription_ref) throw new BillingHttpError(404,"BILLING_SUBSCRIPTION_NOT_FOUND","Billing subscription not found","/api/v1/billing/subscription");
      if (!ifMatchIncludes(ifMatch,computeEtag({},row.updated_at.toISOString()))) throw new BillingHttpError(412,"PRECONDITION_FAILED","Subscription changed; refresh its current status","/api/v1/billing/subscription");
      if(row.checkout_attempt_id || row.mutation_attempt_id) throw new BillingHttpError(409,"BILLING_OPERATION_PENDING","Previous billing operation must be confirmed first","/api/v1/billing/subscription");
      if(["cancelled","completed","expired"].includes(row.status) || (kind==="change" && !["active","authenticated"].includes(row.status))) throw new BillingHttpError(409,"BILLING_SUBSCRIPTION_STATE","Subscription cannot be changed in its current state","/api/v1/billing/subscription");
      if(kind==="change" && (!definition?.commercial?.razorpayPlanId || definition.commercial.razorpayPlanId===row.provider_plan_ref)) throw new BillingHttpError(409,"BILLING_PLAN_UNCHANGED","Choose a different configured provider plan","/api/v1/billing/subscription");
      if(row.provider_plan_ref && row.current_plan && row.commercial_snapshot) {
        await client.query(`INSERT INTO billing_subscription_plans(tenant_id,subscription_ref,provider_plan_ref,internal_plan,commercial_snapshot)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,subscription_ref,provider_plan_ref) DO NOTHING`,
        [tenantId,row.subscription_ref,row.provider_plan_ref,row.current_plan,JSON.stringify(row.commercial_snapshot)]);
      }
      if(definition?.commercial?.razorpayPlanId) {
        const history=await client.query<{equal:boolean}>("SELECT commercial_snapshot=$4::jsonb AND internal_plan=$5 AS equal FROM billing_subscription_plans WHERE tenant_id=$1 AND subscription_ref=$2 AND provider_plan_ref=$3",[tenantId,row.subscription_ref,definition.commercial.razorpayPlanId,JSON.stringify(definition.commercial),definition.plan]);
        if(history.rows[0] && !history.rows[0].equal) throw new BillingHttpError(409,"BILLING_PLAN_HISTORY_CONFLICT","A changed commercial configuration requires a new provider plan","/api/v1/billing/subscription");
      }
      const attempt=randomUUID();
      const updated=await client.query<BillingProfileRow>(`UPDATE billing_profiles SET mutation_attempt_id=$2,mutation_kind=$3,
        pending_plan=$4,pending_provider_plan_ref=$5,pending_commercial_snapshot=$6::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=$1 RETURNING *`,[tenantId,attempt,kind,definition?.plan??null,definition?.commercial?.razorpayPlanId??null,
        definition?.commercial?JSON.stringify(definition.commercial):null]);
      await this.auditCheckout(client,tenantId,attempt,actorRef,`${kind}_claimed`);
      return mapProfile(updated.rows[0]!);
    });
  }

  confirmMutationResponse(tenantId: string, actorRef: string, attemptId: string, subscription: Subscription): Promise<BillingProfileRecord> {
    return this.withTenant(tenantId,async client=>{
      const result=await client.query<BillingProfileRow>("SELECT * FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE",[tenantId]),row=result.rows[0];
      if(!row || subscription.tenantId!==tenantId || row.subscription_ref!==subscription.id ||
          subscription.planId!==(row.pending_provider_plan_ref??row.provider_plan_ref)) throw new BillingHttpError(502,"BILLING_PROFILE_INCONSISTENT","Provider response does not match its billing operation","/api/v1/billing/subscription");
      if(row.mutation_attempt_id===attemptId) await this.auditCheckout(client,tenantId,attemptId,actorRef,`${row.mutation_kind}_submitted`);
      return mapProfile(row);
    });
  }

  releaseUnsubmittedOperation(tenantId: string, actorRef: string, attemptId: string, kind: "checkout" | "mutation"): Promise<void> {
    return this.withTenant(tenantId, async client => {
      const changed = kind === "checkout"
        ? await client.query(`UPDATE billing_profiles SET status='checkout_failed',checkout_attempt_id=NULL,checkout_started_at=NULL,
            gstin=NULL,commercial_snapshot=NULL,provider_plan_ref=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND checkout_attempt_id=$2`, [tenantId,attemptId])
        : await client.query(`UPDATE billing_profiles SET mutation_attempt_id=NULL,mutation_kind=NULL,pending_plan=NULL,
            pending_provider_plan_ref=NULL,pending_commercial_snapshot=NULL,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND mutation_attempt_id=$2`, [tenantId,attemptId]);
      if (changed.rowCount) await this.auditCheckout(client,tenantId,attemptId,actorRef,`${kind}_not_submitted`);
    });
  }

  failCheckout(tenantId: string, actorRef: string, attemptId: string): Promise<void> {
    return this.withTenant(tenantId, async client => {
      const changed = await client.query(`UPDATE billing_profiles SET status='checkout_unconfirmed',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND checkout_attempt_id=$2`, [tenantId,attemptId]);
      if (changed.rowCount) await this.auditCheckout(client,tenantId,attemptId,actorRef,"checkout_unconfirmed");
    });
  }

  private async auditCheckout(client: PoolClient, tenantId: string, attemptId: string, actorRef: string, reason: string): Promise<void> {
    await client.query(`INSERT INTO billing_dunning_audits (tenant_id,id,provider_event_id,from_state,to_state,reason,actor_ref)
      VALUES ($1,$2,$3,'active','active',$4,$5)`, [tenantId,randomUUID(),`checkout:${attemptId}`,reason,actorRef]);
  }

  savePaymentMethod(
    tenantId: string,
    method: PaymentMethodRef,
  ): Promise<void> {
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO billing_payment_method_refs
           (tenant_id, ref, type, brand, last4)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, ref) DO UPDATE
           SET type = EXCLUDED.type,
               brand = EXCLUDED.brand,
               last4 = EXCLUDED.last4`,
        [tenantId, method.ref, method.type, method.brand, method.last4],
      );
    });
  }

  listPaymentMethods(tenantId: string): Promise<PaymentMethodRef[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<PaymentMethodRow>(
        `SELECT ref, type, brand, last4
         FROM billing_payment_method_refs
         WHERE tenant_id = $1 ORDER BY created_at, ref`,
        [tenantId],
      );
      return result.rows.map((row) => ({
        ref: row.ref,
        type: row.type,
        brand: row.brand,
        last4: row.last4,
      }));
    });
  }

  deletePaymentMethod(tenantId: string, ref: string): Promise<void> {
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM billing_payment_method_refs
         WHERE tenant_id = $1 AND ref = $2`,
        [tenantId, ref],
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async withTenant<T>(
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
}

function mapProfile(row: BillingProfileRow): BillingProfileRecord {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    providerId: row.provider_id,
    providerCustomerRef: row.provider_customer_ref,
    subscriptionRef: row.subscription_ref,
    status: row.status,
    currentPlan: row.current_plan,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gstin: row.gstin ?? null,
    commercialSnapshot: row.commercial_snapshot ?? null,
    providerPlanRef: row.provider_plan_ref ?? null,
    checkoutAttemptId: row.checkout_attempt_id ?? null,
    checkoutStartedAt: row.checkout_started_at ?? null,
    mutationAttemptId: row.mutation_attempt_id ?? null,
    mutationKind: row.mutation_kind ?? null,
    pendingPlan: row.pending_plan ?? null,
    pendingProviderPlanRef: row.pending_provider_plan_ref ?? null,
    pendingCommercialSnapshot: row.pending_commercial_snapshot ?? null,
  };
}
