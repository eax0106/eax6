import {Inject,Injectable} from "@nestjs/common";
import {v7 as uuidv7} from "uuid";
import {RazorpayRecoveryUrlSchema,StaffBillingActionRequestSchema,type StaffBillingOperation} from "@alterx/contracts";
import type {BillingProvider,Subscription,Invoice} from "@alterx/shared-clients";
import {AdminAuditService} from "../admin-audit";
import {ENTITLEMENT_PROVIDER,type EntitlementProvider} from "../entitlements/entitlement-provider.interface";
import {PLAN_DEFINITION_STORE,type PlanDefinitionStore} from "../entitlements/plan-definition-store";
import {checkoutAmounts,PlanCommercialSchema} from "../entitlements/plan-commercial";
import {BILLING_PROVIDER} from "./tokens";
import {BillingPolicyService} from "./billing-policy.service";
import {AdminBillingOperationsRepository,type LockedBillingIssue} from "./admin-billing-operations.repository";
import {BillingHttpError} from "./problem";
@Injectable()
export class AdminBillingOperationsService {
 constructor(private readonly repository:AdminBillingOperationsRepository,@Inject(BILLING_PROVIDER)private readonly provider:BillingProvider,private readonly audit:AdminAuditService,private readonly policy:BillingPolicyService,@Inject(ENTITLEMENT_PROVIDER)private readonly entitlements:EntitlementProvider,@Inject(PLAN_DEFINITION_STORE)private readonly definitions:PlanDefinitionStore){}
 async history(tenant:string,staff:string){const items=await this.repository.history(tenant);const ack=await this.audit.record({tenantId:tenant,actorType:"admin",actorRef:staff,action:"billing.issue.history.read",targetType:"tenant",targetRef:tenant,reasonCode:"staff_billing_read",scope:"billing:read"});requireAck(ack);return items;}
 async apply(tenant:string,staff:string,input:unknown,ifMatch:string|undefined):Promise<StaffBillingOperation>{
  const request=StaffBillingActionRequestSchema.parse(input),instance=`/api/v1/admin/billing/issues/${tenant}/actions/${request.action}`;
  if(!/^stf_[a-z0-9._:-]{1,127}$/i.test(staff))throw new BillingHttpError(401,"AUTHENTICATION_REQUIRED","Current staff identity required",instance);
  const result=await this.repository.locked(tenant,ifMatch,async(tx,issue)=>{
   const actor=await tx.query("SELECT 1 FROM staff_users WHERE id=$1 AND deactivated_at IS NULL AND roles && ARRAY['staff_admin','staff_billing_ops']::text[] FOR SHARE",[staff]);
   if(!actor.rowCount)throw new BillingHttpError(403,"BILLING_STAFF_UNAVAILABLE","Current billing staff role required",instance);
   if(issue.mutation_attempt_id)throw new BillingHttpError(409,"BILLING_OPERATION_PENDING","Wait for the existing subscription change to finish",instance);
   const id=`bop_${uuidv7()}`;let runs:number|null=null,credits:number|null=null,recovery_url:string|null=null,invoice_ref:string|null=null;
   if(request.action==="grant_credits"){
    if(!issue.current_plan||issue.current_plan==="free")throw new BillingHttpError(409,"BILLING_PAID_PLAN_REQUIRED","Extra run credits require a paid plan",instance);
    const definition=await this.definitions.find(issue.current_plan),perRun=definition?.commercial?.creditsPerVerifiedRun;
    if(!perRun||!checkoutAmounts(definition?.commercial))throw new BillingHttpError(503,"BILLING_PLAN_UNCONFIGURED","Verified-run credit configuration is unavailable",instance);
    const quantity=BigInt(request.runs)*BigInt(perRun);if(quantity>1_000_000_000n)throw new BillingHttpError(400,"BILLING_CREDIT_QUANTITY_INVALID","Run credit quantity exceeds the supported limit",instance);
    runs=request.runs;credits=Number(quantity);
   }else{
    const subscription=await deadline(()=>this.provider.getSubscription(tenant),instance);assertSubscription(issue,subscription,instance);
    if(request.action==="retry"){
     if(!["pending","halted"].includes(subscription!.status))throw new BillingHttpError(409,"BILLING_RETRY_NOT_PENDING","Provider has no failed subscription to recover; refresh its status",instance);
     const parsed=RazorpayRecoveryUrlSchema.safeParse(subscription!.checkoutUrl);if(!parsed.success)throw new BillingHttpError(503,"BILLING_RECOVERY_UNAVAILABLE","Provider recovery link is unavailable; use the Razorpay Dashboard",instance);recovery_url=parsed.data;
    }else{
     if(subscription!.status!=="active"||["cancelled","completed","expired"].includes(issue.profile_status))throw new BillingHttpError(409,"BILLING_PAYMENT_UNCONFIRMED","Provider has not confirmed active paid recovery",instance);
     const commercial=PlanCommercialSchema.safeParse(issue.commercial_snapshot),expected=checkoutAmounts(commercial.success?commercial.data:null);
     if(!expected||!issue.first_failed_at||!issue.current_plan)throw new BillingHttpError(503,"BILLING_RECOVERY_EVIDENCE_UNAVAILABLE","Current billing recovery configuration is unavailable",instance);
     const page=await deadline(()=>this.provider.listInvoices(tenant,undefined,100),instance);
     const candidates=page.items.filter(item=>item.subscriptionId===subscription!.id&&Number.isFinite(Date.parse(item.issuedAt))).sort((a,b)=>Date.parse(b.issuedAt)-Date.parse(a.issuedAt)||b.id.localeCompare(a.id));
     const invoice=candidates[0];
     // Equal provider timestamps do not establish which invoice supersedes another.
     const latest=candidates.filter(item=>Date.parse(item.issuedAt)===Date.parse(invoice?.issuedAt??""));
     if(page.nextCursor||!invoice||!latest.every(item=>paidRecovery(item,subscription!,expected,issue.first_failed_at!)))throw new BillingHttpError(409,"BILLING_PAYMENT_UNCONFIRMED","Latest invoice has no complete matching paid recovery evidence",instance);
     if(!invoice)throw new BillingHttpError(409,"BILLING_PAYMENT_UNCONFIRMED","No matching paid invoice confirms this failed billing period",instance);
     invoice_ref=invoice.id;await this.entitlements.createEntitlement(tenant,issue.current_plan,tx,{accessState:"active"});
     await tx.query("UPDATE billing_profiles SET status='active',updated_at=clock_timestamp() WHERE tenant_id=$1",[tenant]);
    }
   }
   const saved=await this.repository.append(tx,{id,tenant_id:tenant,action:request.action,actor_ref:staff,reason:request.reason,runs,credits,recovery_url,subscription_ref:issue.subscription_ref,invoice_ref},request.action==="resolve");
   await this.policy.prepare(tenant,tx);
   const ack=await this.audit.record({tenantId:tenant,actorType:"admin",actorRef:staff,action:`billing.issue.${request.action}`,targetType:"tenant",targetRef:tenant,reasonCode:"staff_billing_decision",scope:`billing:operation:${id}`});requireAck(ack);
   return saved;
  });
  if(request.action==="grant_credits"){
   // The accepted grant remains durable and visible if the acknowledgement is uncertain.
   try{await this.policy.synchronize(tenant);}catch{return result;}
   return (await this.repository.history(tenant)).find(item=>item.id===result.id)??result;
  }
  return result;
 }
}
function requireAck(ack:string){if(!/^[a-f0-9]{64}$/i.test(ack))throw new Error("Mandatory central billing audit acknowledgement unavailable");}
function assertSubscription(issue:LockedBillingIssue,subscription:Subscription|null,instance:string):void{if(!subscription||!issue.subscription_ref||!issue.provider_plan_ref||subscription.tenantId!==issue.tenant_id||subscription.id!==issue.subscription_ref||subscription.planId!==issue.provider_plan_ref)throw new BillingHttpError(502,"BILLING_PROVIDER_SCOPE_MISMATCH","Provider subscription does not match this billing subject",instance);}
function paidRecovery(invoice:Invoice,subscription:Subscription,expected:{totalMinor:number;currency:string},failedAt:Date):boolean{const paid=invoice.paidAt?Date.parse(invoice.paidAt):NaN;return /^inv_[A-Za-z0-9]{1,100}$/.test(invoice.id)&&invoice.subscriptionId===subscription.id&&invoice.status==="paid"&&invoice.currency===expected.currency&&invoice.amount===expected.totalMinor&&Number.isFinite(paid)&&paid>=failedAt.getTime()&&paid<=Date.now()+300_000;}
/** @driver deadline bounds the provider read using an independent timer cleared in finally. */
async function deadline<T>(operation:()=>Promise<T>,instance:string):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BillingHttpError(504,"BILLING_PROVIDER_TIMEOUT","Provider status lookup timed out",instance)),5000);})]);}catch(error){if(error instanceof BillingHttpError)throw error;throw new BillingHttpError(502,"BILLING_PROVIDER_ERROR","Provider status lookup failed",instance);}finally{if(timer)clearTimeout(timer);}}
