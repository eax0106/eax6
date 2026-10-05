import {DeploymentAdminActionRequestSchema,DeploymentAdminActionResultSchema,PlatformTenantIdSchema,TenantDeploymentCollectionSchema,type DeploymentAdminActionRequest} from "@alterx/contracts"
import {apiGet,apiPost} from "./http"
export async function listTenantDeployments(tenantId:string){
 const tenant=PlatformTenantIdSchema.parse(tenantId)
 const result=TenantDeploymentCollectionSchema.parse(await apiGet<unknown>(`/api/v1/admin/deployments?${new URLSearchParams({tenant_id:tenant})}`))
 if(result.tenant_id!==tenant)throw new Error("Deployment response scope mismatch")
 return result
}
export async function applyTenantDeployment(input:DeploymentAdminActionRequest,etag:string){
 const request=DeploymentAdminActionRequestSchema.parse(input)
 if(!etag)throw new Error("Reload deployments before changing their state")
 const result=DeploymentAdminActionResultSchema.parse(await apiPost<unknown>(`/api/v1/admin/deployments/${encodeURIComponent(request.deployment_id)}/actions/apply`,request,{ifMatch:etag}))
 if(result.tenant_id!==request.tenant_id||result.deployment_id!==request.deployment_id||result.action!==request.action||!result.etag)throw new Error("Deployment action response mismatch")
 return result
}
