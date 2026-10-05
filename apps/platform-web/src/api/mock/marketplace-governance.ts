import type {MarketplaceGovernanceItem} from "@alterx/contracts"

/** Explicit demo records, shared by reviewer and seller screens. Never used by live adapters. */
export const demoGovernance = new Map<string, MarketplaceGovernanceItem>([
  ["lst_demo_changes", {resource_type:"listing", id:"lst_demo_changes", tenant_id:null, name:"Demo CRM mapping", description:"Demo review listing", status:"needs_changes", trust_level:null,
    updated_at:"2026-10-05T00:00:00.000Z", etag:'"demo-1"',
    risk:{score:15,incomplete:true,reasons:[
      {signal:"first_listing",points:15,detail:"Seller's first demo listing",evidence:[],observed:true},
      {signal:"scanner",points:0,detail:"No recorded scanner verdict",evidence:[],observed:false},
      {signal:"outside_actions",points:0,detail:"Outside actions are not recorded",evidence:[],observed:false},
      {signal:"account_scopes",points:0,detail:"Account scopes are not recorded",evidence:[],observed:false},
      {signal:"prior_takedowns",points:0,detail:"0 recorded prior takedowns",evidence:[],observed:true},
    ]},review_notes:[{id:"mge_demo_review",actor_type:"staff",actor_ref:"stf_demo",action:"needs_changes",previous_status:"human_review",next_status:"needs_changes",
      reason:"Explain the CRM field mapping before resubmitting",occurred_at:"2026-10-05T00:00:00.000Z"}]}],
])
let revision=1
export function demoGovernanceWrite(id:string,etag:string|undefined,action:"edit"|"resubmit"|"approve"|"reject"|"needs_changes"|"takedown",reason:string,name?:string,description?:string):MarketplaceGovernanceItem{
  const old=demoGovernance.get(id)
  if(!old)throw new Error("Review resource was not found")
  if(!etag||etag!==old.etag)throw new Error("The resource changed; reload before deciding")
  if(!reason.trim()||reason.trim().length>1000)throw new Error("Reason must contain 1 to 1000 characters")
  if((action==="edit"||action==="resubmit")&&old.status!=="needs_changes")throw new Error("This listing is not awaiting seller changes")
  if(action==="approve"&&old.status==="needs_changes")throw new Error("The seller must resubmit before approval")
  const status=action==="resubmit"?"submitted":action==="needs_changes"?"needs_changes":action==="approve"?"published":action==="reject"?"private_testing":action==="takedown"?"removed":old.status
  const updated:MarketplaceGovernanceItem={...old,name:name??old.name,description:description??old.description,status,etag:`"demo-${++revision}"`,updated_at:new Date().toISOString(),review_notes:[{
    id:`mge_demo_${revision}`,actor_type:action==="edit"||action==="resubmit"?"seller":"staff",actor_ref:action==="edit"||action==="resubmit"?"usr_demo":"stf_demo",
    action,previous_status:old.status,next_status:status,reason:reason.trim(),occurred_at:new Date().toISOString(),
  },...old.review_notes??[]]}
  demoGovernance.set(id,updated)
  return structuredClone(updated)
}
