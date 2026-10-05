import {useState} from "react";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import type {StaffBillingOperation} from "@alterx/contracts";
import {api} from "@/api/client";
import {isLiveApi} from "@/api/http";
import type {BillingIssue} from "@/api/services/billing-ops";
import {getStaffSession} from "@/api/staff-auth";
import {queryKeys} from "@/api/query-keys";
import {PageHeader} from "@/components/common/page-header";
import {Button} from "@/components/ui/button";
export function BillingOpsQueue(){
 const queryClient=useQueryClient(),session=useQuery({queryKey:["staff","session"],queryFn:getStaffSession,enabled:isLiveApi});
 const allowed=!isLiveApi||session.data?.roles.some(role=>["staff_admin","staff_billing_ops"].includes(role));
 const issues=useQuery({queryKey:queryKeys.admin.billing.issues,queryFn:()=>api.admin.billing.listIssues(),enabled:!!allowed});
 const [selection,setSelection]=useState<{item:BillingIssue;action:"retry"|"resolve"|"grant_credits"}|null>(null),[reason,setReason]=useState(""),[runs,setRuns]=useState("1"),[ack,setAck]=useState<StaffBillingOperation|null>(null);
 const history=useQuery({queryKey:["admin","billing","history",selection?.item.tenantId??ack?.tenant_id],queryFn:()=>api.admin.billing.history((selection?.item.tenantId??ack?.tenant_id)!),enabled:!!allowed&&!!(selection||ack),refetchInterval:query=>query.state.data?.some(row=>row.delivery==="pending")?2000:false});
 const action=useMutation({mutationFn:async()=>{if(!selection)throw new Error("Select a billing issue");if(selection.action==="grant_credits")return api.admin.billing.applyCredit(selection.item,Number(runs),reason);return selection.action==="retry"?api.admin.billing.retryBilling(selection.item,reason):api.admin.billing.resolve(selection.item,reason);},onSuccess:async result=>{setAck(result);setSelection(null);setReason("");await queryClient.invalidateQueries({queryKey:queryKeys.admin.billing.issues});await queryClient.invalidateQueries({queryKey:["admin","billing","history"]});}});
 function choose(item:BillingIssue,kind:"retry"|"resolve"|"grant_credits"){setSelection({item,action:kind});setAck(null);action.reset();setReason("");setRuns("1");}
 const pendingGrant=history.data?.some(row=>row.action==="grant_credits"&&row.delivery==="pending");
 return <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6"><PageHeader title="Billing Operations" description="Recover failed payments and grant verified-run credits with an attributed reason."/>
 {!isLiveApi&&<p>Demo records — fictional billing, recovery links and credits.</p>}
 {isLiveApi&&session.isPending?<p>Loading staff session…</p>:isLiveApi&&session.isError?<div role="alert">Staff session unavailable.</div>:!allowed?<p>Staff admin or billing operations role required.</p>:<>
 {issues.isPending?<p>Loading billing issues…</p>:issues.isError?<div role="alert">Billing issues unavailable: {issues.error.message}</div>:issues.data?.length===0?<p>No billing issues found.</p>:<table><thead><tr><th>Tenant</th><th>Plan</th><th>Access state</th><th>Failure recorded</th><th>Actions</th></tr></thead><tbody>{issues.data?.map(item=><tr key={item.id}><td>{item.tenantName}<small className="block">{item.tenantId}</small></td><td>{item.plan}</td><td>{item.accessState??item.status}</td><td>{new Date(item.createdAt).toLocaleString()}</td><td><Button disabled={action.isPending} onClick={()=>choose(item,"retry")}>Retry payment</Button><Button disabled={action.isPending} onClick={()=>choose(item,"grant_credits")}>Grant run credits</Button><Button disabled={action.isPending} onClick={()=>choose(item,"resolve")}>Resolve</Button></td></tr>)}</tbody></table>}
 <Button disabled={action.isPending} onClick={()=>{void issues.refetch();void history.refetch();}}>Reload billing issues</Button>
 {selection&&<form onSubmit={event=>{event.preventDefault();action.mutate();}}><h2>{selection.action==="grant_credits"?"Grant extra run credits":selection.action==="retry"?"Prepare Razorpay recovery":"Confirm paid recovery"}: {selection.item.tenantName}</h2>
 {selection.action==="retry"&&<p>Returns the provider-hosted recovery link. Payment remains unconfirmed until Razorpay confirms it.</p>}
 {selection.action==="resolve"&&<p>Requires an active provider subscription and a matching paid invoice for this failed period.</p>}
 {selection.action==="grant_credits"&&<label>Verified runs<input aria-label="Verified runs" type="number" min="1" max="1000000" value={runs} onChange={event=>setRuns(event.target.value)} disabled={action.isPending}/></label>}
 <label>Billing action reason<textarea aria-label="Billing action reason" maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} disabled={action.isPending}/></label>
 {action.isError&&<div role="alert">{action.error.message} Review recorded history before repeating a grant; reload billing issues, then reselect its current revision.</div>}
 {pendingGrant&&selection.action==="grant_credits"&&<p>A prior grant is pending delivery. Its recorded operation will retry automatically.</p>}
 <Button type="submit" disabled={action.isPending||!reason.trim()||selection.action==="grant_credits"&&(!Number.isSafeInteger(Number(runs))||Number(runs)<1||Number(runs)>1_000_000||!!pendingGrant||history.isPending||history.isError)}>Apply billing action</Button><Button type="button" disabled={action.isPending} onClick={()=>setSelection(null)}>Cancel</Button></form>}
 {ack&&<div role="status">{ack.action==="retry"?<>Recovery link prepared. Payment remains unconfirmed. <a href={ack.recovery_url!} target="_blank" rel="noopener noreferrer">Open Razorpay recovery</a></>:ack.action==="grant_credits"?<>Accepted {ack.runs} verified runs ({ack.credits} credits). Delivery {history.data?.find(row=>row.id===ack.id)?.delivery??ack.delivery}.</>:<>Paid recovery confirmed; billing issue resolved.</>}</div>}
 {(selection||ack)&&<section><h2>Recorded billing actions</h2>{history.isPending?<p>Loading billing history…</p>:history.isError?<div role="alert">Billing history unavailable: {history.error.message}</div>:history.data?.length===0?<p>No recorded billing actions.</p>:<ul>{history.data?.map(row=><li key={row.id}>{row.action}: {row.reason} — {row.actor_ref}{row.runs!==null?` — ${row.runs} verified runs (${row.credits} credits), ${row.delivery}`:""}</li>)}</ul>}</section>}
 </>}
 </div>;
}
