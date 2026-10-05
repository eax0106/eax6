import type {StaffBillingOperation,StaffBillingActionRequest} from "@alterx/contracts";
import {isLiveApi} from "../http";
import * as live from "../live-admin-billing-ops";
export interface BillingIssue {
 id:string;tenantId:string;tenantName:string;issue:"failed_renewal"|"payment_failed"|"plan_mismatch"|"budget_exceeded"|"credit_request";plan:string;status:"open"|"resolved";
 accessState?:"grace"|"limited"|"suspended";createdAt:string;etag:string;
 /** Legacy demo display only; never a run-credit quantity. */ amount?:number;currency?:string;
}
const tenant="00000000-0000-7000-8000-0000000000a1",other="00000000-0000-7000-8000-0000000000b1";
const demo:BillingIssue[]=[{id:tenant,tenantId:tenant,tenantName:"Acme AI",issue:"payment_failed",plan:"basic",status:"open",accessState:"grace",createdAt:"2026-09-20T00:00:00.000Z",etag:`"billing-${tenant}-1"`},{id:other,tenantId:other,tenantName:"Beta",issue:"failed_renewal",plan:"pro",status:"open",accessState:"limited",createdAt:"2026-09-19T00:00:00.000Z",etag:`"billing-${other}-1"`}];
const demoHistory:StaffBillingOperation[]=[];let demoSequence=0;
export class BillingOpsService {
 async listIssues():Promise<BillingIssue[]>{if(isLiveApi)return(await live.billingIssues()).map(item=>({id:item.tenant_id,tenantId:item.tenant_id,tenantName:item.tenant_name,issue:"payment_failed",plan:item.current_plan??"unknown",status:"open",accessState:item.state,createdAt:item.first_failed_at??item.updated_at,etag:item.etag}));return demo.filter(item=>item.status==="open").map(item=>({...item}));}
 async history(tenant:string):Promise<StaffBillingOperation[]>{return isLiveApi?live.billingHistory(tenant):demoHistory.filter(item=>item.tenant_id===tenant).map(item=>({...item}));}
 resolve(item:BillingIssue,reason:string){return this.apply(item,{action:"resolve",reason});}
 applyCredit(item:BillingIssue,runs:number,reason:string){return this.apply(item,{action:"grant_credits",runs,reason});}
 retryBilling(item:BillingIssue,reason:string){return this.apply(item,{action:"retry",reason});}
 private async apply(item:BillingIssue,input:StaffBillingActionRequest):Promise<StaffBillingOperation>{
  if(isLiveApi)return live.billingAction(item.tenantId,item.etag,input);
  const current=demo.find(row=>row.id===item.id);if(!current)throw new Error("Demo billing issue missing");if(current.etag!==item.etag)throw new Error("Billing issue changed; reload before acting");
  if(!input.reason.trim()||input.reason.trim().length>1000)throw new Error("Enter a billing action reason");
  if(input.action==="grant_credits"&&(!Number.isSafeInteger(input.runs)||input.runs<1||input.runs>1_000_000))throw new Error("Enter a valid run quantity");
  current.etag=`"billing-${current.tenantId}-${Number(current.etag.split("-").at(-1)!.slice(0,-1))+1}"`;
  if(input.action==="resolve")current.status="resolved";
  demoSequence++;
  const result:StaffBillingOperation={id:`bop_00000000-0000-7000-8000-${String(demoSequence).padStart(12,"0")}`,tenant_id:current.tenantId,action:input.action,actor_ref:"stf_demo",reason:input.reason.trim(),created_at:new Date().toISOString(),etag:current.etag,runs:input.action==="grant_credits"?input.runs:null,credits:input.action==="grant_credits"?input.runs*2:null,delivery:input.action==="grant_credits"?"delivered":null,recovery_url:input.action==="retry"?"https://rzp.io/rzp/demo-recovery":null,subscription_ref:"sub_demo",invoice_ref:input.action==="resolve"?"inv_demo_paid":null};
  demoHistory.unshift(result);return result;
 }
}
