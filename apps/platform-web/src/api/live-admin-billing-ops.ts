import {BillingOperationsTenantSchema,StaffBillingIssuesSchema,StaffBillingActionRequestSchema,StaffBillingOperationSchema,StaffBillingHistorySchema,type StaffBillingActionRequest,type StaffBillingOperation} from "@alterx/contracts";
import {apiGet,apiPost} from "./http";
export async function billingIssues(){return StaffBillingIssuesSchema.parse(await apiGet<unknown>("/api/v1/admin/billing/issues"));}
export async function billingHistory(tenant:string){BillingOperationsTenantSchema.parse(tenant);const result=StaffBillingHistorySchema.parse(await apiGet<unknown>(`/api/v1/admin/billing/issues/${encodeURIComponent(tenant)}/history`));if(result.some(row=>row.tenant_id!==tenant))throw new Error("Billing history belongs to another tenant");return result;}
export async function billingAction(tenant:string,etag:string,input:StaffBillingActionRequest):Promise<StaffBillingOperation>{
 BillingOperationsTenantSchema.parse(tenant);const request=StaffBillingActionRequestSchema.parse(input);
 const route=request.action==="grant_credits"?"grant-credits":request.action;
 const body=request.action==="grant_credits"?{runs:request.runs,reason:request.reason}:{reason:request.reason};
 const result=StaffBillingOperationSchema.parse(await apiPost<unknown>(`/api/v1/admin/billing/issues/${encodeURIComponent(tenant)}/actions/${route}`,body,{ifMatch:etag}));
 if(result.tenant_id!==tenant||result.action!==request.action||result.reason!==request.reason||request.action==="grant_credits"&&result.runs!==request.runs)throw new Error("Billing acknowledgement belongs to another subject or action");
 return result;
}
