import {Body,Controller,Get,Headers,Param,Patch,Post,UseFilters} from "@nestjs/common";
import {MarketplaceGovernanceResourceTypeSchema} from "@alterx/contracts";
import {z} from "zod";
import {ActorContext,RequireTenantRole,type ActorContextType} from "../rbac";
import {governanceAuditScope} from "../marketplace-governance/governance-history";
import {AuditEventsClient} from "../engine";
import {MarketplaceGovernanceExceptionFilter} from "../marketplace-governance/marketplace-governance-exception.filter";
import {MarketplaceGovernanceHttpError} from "../marketplace-governance/problem";
import {SellerGovernanceRepository} from "./seller-governance.repository";

@Controller("/api/v1/publisher/reviews")
@UseFilters(MarketplaceGovernanceExceptionFilter)
export class SellerGovernanceController{
  constructor(private readonly reviews:SellerGovernanceRepository,private readonly audit:AuditEventsClient){}
  @Get(":resourceType/:id") @RequireTenantRole("member")
  review(@Param("resourceType") raw:string,@Param("id") id:string,@ActorContext() actor:ActorContextType){
    return this.reviews.review(actor.tenant_id,this.resource(raw,id),id);
  }
  @Patch(":resourceType/:id") @RequireTenantRole("owner")
  edit(@Param("resourceType") raw:string,@Param("id") id:string,@Body() body:unknown,
    @ActorContext() actor:ActorContextType,@Headers("if-match") ifMatch?:string){
    const type=this.resource(raw,id),input=z.object({name:z.string().trim().min(1).max(255).optional(),description:z.string().max(2000).nullable().optional(),
      reason:z.string().trim().min(1).max(1000)}).strict().refine(value=>value.name!==undefined||Object.hasOwn(value,"description"),"Provide a listing change").safeParse(body);
    if(!input.success)throw new MarketplaceGovernanceHttpError(400,"VALIDATION_ERROR","Provide valid changes and a reason of 1 to 1000 characters",`/api/v1/publisher/reviews/${raw}/${id}`);
    return this.reviews.edit(actor.tenant_id,type,id,actor.user_id,input.data,ifMatch,async item=>this.audit.record({
      tenant_id:actor.tenant_id,actor_type:"user",actor_ref:actor.user_id,action:"marketplace.governance.edit",target_type:type,target_ref:id,
      result:"success",reason_code:"seller_correction",context_json:JSON.stringify({scope:governanceAuditScope(item)}),occurred_at:new Date().toISOString(),
    }));
  }
  @Post(":resourceType/:id/actions/resubmit") @RequireTenantRole("owner")
  resubmit(@Param("resourceType") raw:string,@Param("id") id:string,@Body() body:unknown,
    @ActorContext() actor:ActorContextType,@Headers("if-match") ifMatch?:string){
    const type=this.resource(raw,id),input=z.object({reason:z.string().trim().min(1).max(1000)}).strict().safeParse(body);
    if(!input.success)throw new MarketplaceGovernanceHttpError(400,"VALIDATION_ERROR","Provide a reason of 1 to 1000 characters",`/api/v1/publisher/reviews/${raw}/${id}/actions/resubmit`);
    return this.reviews.resubmit(actor.tenant_id,type,id,actor.user_id,input.data.reason,ifMatch,async item=>this.audit.record({
      tenant_id:actor.tenant_id,actor_type:"user",actor_ref:actor.user_id,action:"marketplace.governance.resubmit",target_type:type,target_ref:id,
      result:"success",reason_code:"seller_resubmission",context_json:JSON.stringify({scope:governanceAuditScope(item)}),occurred_at:new Date().toISOString(),
    }));
  }
  private resource(raw:string,id:string){
    const type=MarketplaceGovernanceResourceTypeSchema.safeParse(raw);
    if(!type.success||!(type.data==="listing"?/^lst_[0-9a-f-]{36}$/i:/^tlm_[0-9a-f-]{36}$/i).test(id))
      throw new MarketplaceGovernanceHttpError(400,"VALIDATION_ERROR","Invalid review resource",`/api/v1/publisher/reviews/${raw}/${id}`);
    return type.data;
  }
}
