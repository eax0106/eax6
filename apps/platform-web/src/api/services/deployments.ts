import type {TenantDeployment,TenantDeploymentCollection,DeploymentAdminActionRequest,DeploymentAdminActionResult} from "../types"
import {isLiveApi} from "../http"
import * as live from "../live-admin-deployments"
export class DeploymentsService {
 private nextRevision=1
 private readonly demo=new Map<string,TenantDeployment[]>()
 async list(tenantId:string):Promise<TenantDeploymentCollection>{
  if(isLiveApi)return live.listTenantDeployments(tenantId)
  if(!this.demo.has(tenantId))this.demo.set(tenantId,["active","rolled_back","suspended"].map((status,index)=>({
   id:`dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a${index+1}`,tenant_id:tenantId,
   project_id:`prj_018f4d6e-2b4a-7a3e-8c1a-1234567890b${index===2?2:1}`,project_name:index===2?"Demo API":"Demo website",
   status:status as TenantDeployment["status"],created_at:`2026-10-0${index===0?3:2}T00:00:00.000Z`,updated_at:"2026-10-03T00:00:00.000Z",
   etag:`"dep_018f4d6e-2b4a-7a3e-8c1a-1234567890a${index+1}:rev-1"`,
  })))
  const items=this.demo.get(tenantId)!.map(row=>({...row}));return {tenant_id:tenantId,total:items.length,items}
 }
 async apply(input:DeploymentAdminActionRequest,etag:string):Promise<DeploymentAdminActionResult>{
  if(isLiveApi)return live.applyTenantDeployment(input,etag)
  if(!input.reason.trim()||input.reason.trim().length>1000)throw new Error("Enter a reason between 1 and 1000 characters")
  const rows=this.demo.get(input.tenant_id),row=rows?.find(value=>value.id===input.deployment_id)
  if(!row)throw new Error("Deployment not found")
  if(!etag||row.etag!==etag)throw new Error("Deployment changed; reload before retrying")
  let activeId:string|null=null
  if(input.action==="resume"){
   if(row.status!=="suspended"||rows!.some(value=>value.project_id===row.project_id&&value.status==="active"))throw new Error("Project cannot resume this deployment")
   row.status="active";activeId=row.id
  }else{
   if(row.status!=="active")throw new Error("Deployment is not active")
   if(input.action==="rollback"){
    const previous=rows!.filter(value=>value.project_id===row.project_id&&value.status==="rolled_back"&&value.created_at<row.created_at).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id))[0]
    if(!previous)throw new Error("No previous deployment to restore")
    previous.status="active";previous.etag=`"${previous.id}:rev-${++this.nextRevision}"`;previous.updated_at=new Date().toISOString();activeId=previous.id
    row.status="rolled_back"
   }else row.status="suspended"
  }
  row.etag=`"${row.id}:rev-${++this.nextRevision}"`;row.updated_at=new Date().toISOString()
  return {tenant_id:input.tenant_id,deployment_id:row.id,project_id:row.project_id,action:input.action,status:row.status as DeploymentAdminActionResult["status"],active_deployment_id:activeId,updated_at:row.updated_at,etag:row.etag}
 }
}
