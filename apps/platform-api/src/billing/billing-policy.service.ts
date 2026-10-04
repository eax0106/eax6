import { createHash } from "node:crypto";
import { Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { TenantIdSchema } from "@alterx/contracts";
import type { Pool, PoolClient } from "pg";
import type { ConfigProvider } from "../entitlements/config-provider.interface";
import type { PlanDefinitionStore } from "../entitlements/plan-definition-store";
import type { EntitlementAccessState, EntitlementLimits } from "../entitlements/types";
import { BillingPolicyClient } from "../engine/billing-policy-client";
import type { EntitlementProvider } from "../entitlements/entitlement-provider.interface";
import { BillingWebhookRepository } from "./billing-webhook.repository";

/** @driver startBillingPolicyPublication is called by the Nest module lifecycle; durable deliveries retry after restart. */
export class BillingPolicyService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining=false;
  private cursor: string | null=null;
  private readonly logger=new Logger(BillingPolicyService.name);
  constructor(private readonly pool: Pool, private readonly config: ConfigProvider, private readonly definitions: PlanDefinitionStore,
    private readonly client?: BillingPolicyClient,private readonly entitlements?: EntitlementProvider) {}
  onModuleInit(): void { this.startBillingPolicyPublication(); }
  private startBillingPolicyPublication(): void {
    if(!this.client)return;
    this.timer=setInterval(()=>{void this.drain();},1000);this.timer.unref();void this.drain();
  }
  onModuleDestroy(): void {if(this.timer)clearInterval(this.timer);}

  async recordVerifiedIdentity(tenantIdInput: string,userId: string,transaction?: PoolClient): Promise<void> {
    const tenantId=bareTenant(tenantIdInput),actor=userId.startsWith("usr_")?userId.slice(4):userId;
    const save=async(tx:PoolClient)=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`billing-policy:${tenantId}`]);
      const member=await tx.query("SELECT 1 FROM tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND u.status='active'",[tenantId,actor]);
      if(!member.rowCount)throw new Error("Verified identity has no active tenant membership");
      await tx.query(`INSERT INTO billing_policy_state(tenant_id,email_verified,verified_by) VALUES($1,true,$2)
        ON CONFLICT(tenant_id) DO UPDATE SET email_verified=true,verified_by=$2`,[tenantId,actor]);
      await this.prepare(tenantId,tx);
    };
    if(transaction)await save(transaction);else await this.transaction(tenantId,save);
  }

  async synchronize(tenantIdInput: string): Promise<void> {
    if(!this.client)return;
    const tenantId=bareTenant(tenantIdInput);
    await this.advanceDunning(tenantId);
    await this.transaction(tenantId,async tx=>{
      await this.prepare(tenantId,tx);
      const rows=await tx.query<{policy_payload: unknown;source_revision:Date;published_revision:Date|null}>("SELECT policy_payload,source_revision,published_revision FROM billing_policy_state WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
      const row=rows.rows[0];if(!row?.policy_payload)return;
      if(row.published_revision?.getTime()!==row.source_revision.getTime()){
        await this.client!.policy(row.policy_payload);
        await tx.query("UPDATE billing_policy_state SET published_revision=source_revision WHERE tenant_id=$1",[tenantId]);
      }
      const grants=await tx.query<{payment_ref:string;credits:number}>("SELECT payment_ref,credits FROM billing_credit_deliveries WHERE tenant_id=$1 AND published_at IS NULL ORDER BY created_at,payment_ref LIMIT 20 FOR UPDATE",[tenantId]);
      for(const grant of grants.rows){
        await this.client!.grant(tenantId,`razorpay:${grant.payment_ref}`,grant.credits);
        await tx.query("UPDATE billing_credit_deliveries SET published_at=clock_timestamp() WHERE tenant_id=$1 AND payment_ref=$2",[tenantId,grant.payment_ref]);
      }
    });
  }

  private async advanceDunning(tenantId: string): Promise<void> {
    if(!this.entitlements)return;
    const repository=new BillingWebhookRepository(this.pool);
    await repository.transaction(tenantId,async tx=>{
      const profile=await repository.lockProfile(tx,tenantId),current=await repository.getDunningState(tx,tenantId);
      if(!profile || ["cancelled","completed","expired"].includes(profile.status) || !current.firstFailedAt ||
          !current.currentPlan || current.currentPlan==="free" || !["grace","limited"].includes(current.state)) return;
      const config=await this.config.getDunningConfig(),elapsed=(Date.now()-current.firstFailedAt.getTime())/1000;
      const nextState:EntitlementAccessState=elapsed>=config.suspensionThresholdSeconds?"suspended":elapsed>=config.gracePeriodSeconds?"limited":"grace";
      if(nextState===current.state)return;
      const next={...current,state:nextState};
      await this.entitlements!.createEntitlement(tenantId,current.currentPlan,tx,{accessState:nextState});
      await repository.saveDunningState(tx,tenantId,next);
      await repository.auditTransition(tx,{tenantId,providerEventId:`dunning:${current.firstFailedAt.toISOString()}:${nextState}`,
        fromState:current.state,toState:nextState,reason:"dunning_elapsed"});
      await this.prepare(tenantId,tx);
    });
  }

  async account(tenantIdInput: string) {
    if(!this.client)throw new Error("Billing account synchronization unavailable");
    const tenantId=bareTenant(tenantIdInput);await this.synchronize(tenantId);return this.client.account(tenantId);
  }

  async prepare(tenantId: string,tx: PoolClient): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`billing-policy:${tenantId}`]);
    const source=await tx.query<{email_verified:boolean;policy_hash:string|null;source_revision:Date|null}>("SELECT * FROM billing_policy_state WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
    const state=source.rows[0];if(!state)return;
    const active=await tx.query<{plan:string;limits:Partial<EntitlementLimits>|null;access_state:EntitlementAccessState}>(`SELECT plan,limits,access_state FROM entitlements WHERE tenant_id=$1
      AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_to IS NULL OR effective_to>clock_timestamp())
      ORDER BY effective_from DESC NULLS LAST,created_at DESC LIMIT 1`,[tenantId]);
    const entitlement=active.rows[0],plan=entitlement?.plan??"free";
    const definition=await this.definitions.find(plan);
    const defaults=await this.config.getEntitlementDefaults(plan);
    let cap=entitlement?.limits?.maxRunsPerDay??defaults.maxRunsPerDay;
    if(entitlement?.access_state==="limited")cap=(await this.config.getDunningConfig()).limitedStateLimits.maxRunsPerDay;
    const body={tenantId:`ten_${tenantId}`,plan,accessState:entitlement?.access_state??"active",emailVerified:state.email_verified,free:plan==="free",
      maxRunsPerDay:cap,creditsPerVerifiedRun:plan==="free"?null:definition?.commercial?.creditsPerVerifiedRun??null};
    const hash=createHash("sha256").update(JSON.stringify(body)).digest("hex");if(state.policy_hash===hash)return;
    const revision=new Date(Math.max(Date.now(),(state.source_revision?.getTime()??0)+1)).toISOString();
    await tx.query("UPDATE billing_policy_state SET policy_hash=$2,source_revision=$3,policy_payload=$4::jsonb WHERE tenant_id=$1",[tenantId,hash,revision,JSON.stringify({...body,revision})]);
  }

  private async drain(): Promise<void> {
    if(this.draining)return;this.draining=true;
    try{
      const result=await this.pool.query<{tenant_id:string}>("SELECT tenant_id FROM list_billing_sync_tenants($1,100)",[this.cursor]);
      for(let offset=0;offset<result.rows.length;offset+=4){
        const batch=result.rows.slice(offset,offset+4);
        const outcomes=await Promise.allSettled(batch.map(row=>this.synchronize(row.tenant_id)));
        if(outcomes.some(outcome=>outcome.status==="rejected"))this.logger.error("Billing synchronization pending; durable delivery will retry");
        this.cursor=batch.at(-1)!.tenant_id;
      }
      if(result.rows.length<100)this.cursor=null;
    }catch{this.logger.error("Billing synchronization inventory unavailable; retrying");}
    finally{this.draining=false;}
  }
  private async transaction<T>(tenantId: string,operation:(tx:PoolClient)=>Promise<T>):Promise<T>{
    const tx=await this.pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenantId]);const result=await operation(tx);await tx.query("COMMIT");return result;}
    catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  }
}
function bareTenant(input:string):string{return TenantIdSchema.parse(input.startsWith("ten_")?input:`ten_${input}`).slice(4);}
