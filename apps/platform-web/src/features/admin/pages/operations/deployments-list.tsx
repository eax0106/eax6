import {useState} from "react"
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query"
import {api} from "@/api/client"
import {queryKeys} from "@/api/query-keys"
import {isLiveApi} from "@/api/http"
import {getStaffSession} from "@/api/staff-auth"
import type {TenantDeployment,DeploymentAdminActionRequest} from "@/api/types"
import {PageHeader} from "@/components/common/page-header"
import {Button} from "@/components/ui/button"
import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell} from "@/components/ui/table"
export function DeploymentsList(){
 const cache=useQueryClient(),[tenant,setTenant]=useState(""),[selected,setSelected]=useState<TenantDeployment|null>(null),[action,setAction]=useState<DeploymentAdminActionRequest["action"]>("suspend"),[reason,setReason]=useState("")
 const session=useQuery({queryKey:["staff","session"],queryFn:getStaffSession,enabled:isLiveApi})
 const allowed=!isLiveApi||!!session.data?.roles.includes("staff_admin")
 const tenants=useQuery({queryKey:queryKeys.admin.tenants.list,queryFn:()=>api.admin.tenants.list(),enabled:allowed})
 const key=[...queryKeys.admin.deployments.list,tenant]
 const deployments=useQuery({queryKey:key,queryFn:()=>api.admin.deployments.list(tenant),enabled:allowed&&!!tenant})
 const mutation=useMutation({mutationFn:()=>{if(!selected)throw new Error("Choose a deployment");return api.admin.deployments.apply({tenant_id:tenant,deployment_id:selected.id,action,reason:reason.trim()},selected.etag)},onSuccess:async()=>{setSelected(null);setReason("");await cache.invalidateQueries({queryKey:key})}})
 const reload=async()=>{
  const fresh=await deployments.refetch()
  if(selected){const current=fresh.data?.items.find(row=>row.id===selected.id);setSelected(current&&current.status===(action==="resume"?"suspended":"active")?current:null)}
 }
 const choose=(row:TenantDeployment,value:DeploymentAdminActionRequest["action"])=>{setSelected(row);setAction(value);setReason("");mutation.reset()}
 return <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
  <PageHeader title="Tenant deployments" description="View recorded tenant deployments and manage their active state."/>
  {!isLiveApi&&<p>Demo records — fictional deployments.</p>}
  {isLiveApi&&session.isPending?<p>Loading staff access…</p>:isLiveApi&&session.isError?<div role="alert">Staff access unavailable. <Button onClick={()=>session.refetch()}>Retry staff access</Button></div>:!allowed?<p>Staff admin role required.</p>:<>
   <label>Tenant <select aria-label="Tenant" value={tenant} disabled={mutation.isPending} onChange={event=>{setTenant(event.target.value);setSelected(null);setReason("");mutation.reset()}}><option value="">Choose a tenant</option>{tenants.data?.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
   {tenants.isPending?<p>Loading tenants…</p>:tenants.isError?<div role="alert">Tenants unavailable. <Button onClick={()=>tenants.refetch()}>Retry tenants</Button></div>:tenants.data?.length===0?<p>No tenants found.</p>:null}
   {!tenant?<p>Choose a tenant to load its deployments.</p>:deployments.isPending?<p>Loading deployments…</p>:deployments.isError?<div role="alert">Deployments unavailable: {deployments.error.message} <Button onClick={()=>reload()}>Reload deployments</Button></div>:deployments.data&&<>
    <p>{deployments.data.items.length} shown of {deployments.data.total} recorded deployments.</p>
    <Button disabled={mutation.isPending||deployments.isFetching} onClick={()=>reload()}>Reload deployments</Button>
    {deployments.data.items.length===0?<p>No deployments found for this tenant.</p>:<Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Deployment</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{deployments.data.items.map(row=><TableRow key={row.id}>
     <TableCell>{row.project_name}</TableCell><TableCell>{row.id}</TableCell><TableCell>{row.status.replace("_"," ")}</TableCell><TableCell>{new Date(row.updated_at).toLocaleString()}</TableCell><TableCell>
      {row.status==="active"&&<><Button disabled={mutation.isPending||!row.etag} onClick={()=>choose(row,"suspend")}>Suspend</Button><Button disabled={mutation.isPending||!row.etag} onClick={()=>choose(row,"rollback")}>Rollback</Button></>}
      {row.status==="suspended"&&<Button disabled={mutation.isPending||!row.etag} onClick={()=>choose(row,"resume")}>Resume</Button>}
     </TableCell></TableRow>)}</TableBody></Table>}
    {selected&&<form onSubmit={event=>{event.preventDefault();mutation.mutate()}} className="space-y-3"><p>{action} {selected.id}</p><label>Reason <textarea aria-label="Deployment action reason" maxLength={1000} value={reason} disabled={mutation.isPending} onChange={event=>setReason(event.target.value)}/></label><Button type="submit" disabled={mutation.isPending||!reason.trim()||reason.trim().length>1000||!selected.etag}>{mutation.isPending?"Saving…":"Apply action"}</Button><Button type="button" disabled={mutation.isPending} onClick={()=>{setSelected(null);mutation.reset()}}>Cancel</Button></form>}
    {mutation.isError&&<div role="alert">{mutation.error.message} Reload deployments before retrying a changed record.</div>}
    {mutation.isSuccess&&<p>Deployment state updated.</p>}
   </>}
  </>}
 </div>
}
