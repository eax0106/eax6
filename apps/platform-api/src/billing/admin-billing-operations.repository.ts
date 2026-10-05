import {Injectable} from "@nestjs/common";
import {BillingOperationsTenantSchema,StaffBillingHistorySchema,StaffBillingOperationSchema,type StaffBillingOperation} from "@alterx/contracts";
import type {Pool,PoolClient} from "pg";
import {BillingHttpError} from "./problem";
export interface LockedBillingIssue {tenant_id:string;state:string;current_plan:string|null;first_failed_at:Date|null;revision:string;subscription_ref:string|null;provider_plan_ref:string|null;profile_status:string;commercial_snapshot:unknown;mutation_attempt_id:string|null;}
@Injectable()
export class AdminBillingOperationsRepository {
 constructor(private readonly pool:Pool){}
 async locked<T>(tenantInput:string,ifMatch:string|undefined,operation:(tx:PoolClient,issue:LockedBillingIssue)=>Promise<T>):Promise<T>{
  const tenant=BillingOperationsTenantSchema.parse(tenantInput),instance=`/api/v1/admin/billing/issues/${tenant}`;
  if(!ifMatch?.trim())throw new BillingHttpError(428,"IF_MATCH_REQUIRED","Reload the billing issue before acting",instance);
  return this.transaction(tenant,async tx=>{
   const subject=await tx.query("SELECT 1 FROM tenants WHERE id=$1 AND status<>'deleted' AND deleted_at IS NULL FOR SHARE",[tenant]);
   if(!subject.rowCount)throw new BillingHttpError(404,"BILLING_SUBJECT_NOT_FOUND","Billing subject is unavailable",instance);
   const profile=await tx.query("SELECT subscription_ref,provider_plan_ref,status AS profile_status,commercial_snapshot,mutation_attempt_id FROM billing_profiles WHERE tenant_id=$1 FOR UPDATE",[tenant]);
   const result=await tx.query("SELECT tenant_id,state,current_plan,first_failed_at,revision::text FROM billing_dunning_states WHERE tenant_id=$1 FOR UPDATE",[tenant]);
   if(!result.rows[0]||result.rows[0].state==="active")throw new BillingHttpError(409,"BILLING_ISSUE_CLOSED","This billing issue is already closed",instance);
   const issue={...result.rows[0],...(profile.rows[0]??{subscription_ref:null,provider_plan_ref:null,profile_status:"unknown",commercial_snapshot:null,mutation_attempt_id:null})} as LockedBillingIssue;
   if(ifMatch!==`"billing-${tenant}-${issue.revision}"`)throw new BillingHttpError(412,"BILLING_ISSUE_CHANGED","Billing issue changed; reload before acting",instance);
   return operation(tx,issue);
  });
 }
 async history(tenantInput:string):Promise<StaffBillingOperation[]>{
  const tenant=BillingOperationsTenantSchema.parse(tenantInput);
  return this.transaction(tenant,async tx=>{
   const exists=await tx.query("SELECT 1 FROM tenants WHERE id=$1 AND status<>'deleted' AND deleted_at IS NULL FOR SHARE",[tenant]);
   if(!exists.rowCount)throw new BillingHttpError(404,"BILLING_SUBJECT_NOT_FOUND","Billing subject is unavailable","/api/v1/admin/billing/issues");
   const rows=await tx.query(`SELECT o.*,d.published_at,(d.operation_id IS NOT NULL) AS has_delivery FROM billing_admin_operations o LEFT JOIN billing_admin_credit_deliveries d ON d.tenant_id=o.tenant_id AND d.operation_id=o.id WHERE o.tenant_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT 200`,[tenant]);
   return StaffBillingHistorySchema.parse(rows.rows.map(operationView));
  });
 }
 async append(tx:PoolClient,input:Omit<StaffBillingOperation,"created_at"|"etag"|"delivery">,resolved:boolean):Promise<StaffBillingOperation>{
  const state=await tx.query<{revision:string}>(`UPDATE billing_dunning_states SET state=CASE WHEN $2 THEN 'active' ELSE state END,first_failed_at=CASE WHEN $2 THEN NULL ELSE first_failed_at END,updated_at=clock_timestamp() WHERE tenant_id=$1 RETURNING revision::text`,[input.tenant_id,resolved]);
  if(!state.rows[0])throw new Error("Locked billing issue disappeared");
  const saved=await tx.query(`INSERT INTO billing_admin_operations(id,tenant_id,action,actor_ref,reason,revision,runs,credits,recovery_url,subscription_ref,invoice_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[input.id,input.tenant_id,input.action,input.actor_ref,input.reason,state.rows[0].revision,input.runs,input.credits,input.recovery_url,input.subscription_ref,input.invoice_ref]);
  if(input.action==="grant_credits")await tx.query("INSERT INTO billing_admin_credit_deliveries(tenant_id,operation_id,credits) VALUES($1,$2,$3)",[input.tenant_id,input.id,input.credits]);
  return operationView({...saved.rows[0],has_delivery:input.action==="grant_credits",published_at:null});
 }
 private async transaction<T>(tenant:string,operation:(tx:PoolClient)=>Promise<T>):Promise<T>{const tx=await this.pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);const value=await operation(tx);await tx.query("COMMIT");return value;}catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}}
}
function operationView(row:Record<string,unknown>):StaffBillingOperation{
 return StaffBillingOperationSchema.parse({id:row.id,tenant_id:row.tenant_id,action:row.action,actor_ref:row.actor_ref,reason:row.reason,created_at:(row.created_at as Date).toISOString(),etag:`"billing-${row.tenant_id}-${row.revision}"`,runs:row.runs,credits:row.credits,delivery:row.has_delivery?(row.published_at?"delivered":"pending"):null,recovery_url:row.recovery_url,subscription_ref:row.subscription_ref,invoice_ref:row.invoice_ref});
}
