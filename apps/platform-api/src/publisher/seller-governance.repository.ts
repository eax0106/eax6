import {Injectable} from "@nestjs/common";
import type {MarketplaceGovernanceItem,MarketplaceGovernanceResourceType} from "@alterx/contracts";
import type {Pool,PoolClient} from "pg";
import {appendGovernanceEvent,governanceNotes,requireGovernanceMatch} from "../marketplace-governance/governance-history";
import {resourceItem} from "../marketplace-governance/marketplace-governance.repository";
import {MarketplaceGovernanceHttpError} from "../marketplace-governance/problem";

@Injectable()
export class SellerGovernanceRepository {
  constructor(private readonly pool:Pool){}
  review(tenantId:string,type:MarketplaceGovernanceResourceType,id:string):Promise<MarketplaceGovernanceItem>{
    return this.withTenant(tenantId,async c=>{
      const item=resourceItem(type,await this.ownedResource(c,tenantId,type,id,false));
      item.review_notes=await governanceNotes(c,type,id);return item;
    });
  }
  edit(tenantId:string,type:MarketplaceGovernanceResourceType,id:string,userId:string,
    input:{name?:string|undefined;description?:string|null|undefined;reason:string},ifMatch:string|undefined,audit:(item:MarketplaceGovernanceItem)=>Promise<unknown>):Promise<MarketplaceGovernanceItem>{
    return this.withTenant(tenantId,async c=>{
      const old=await this.ownedResource(c,tenantId,type,id,true),instance=`/api/v1/publisher/reviews/${type}/${id}`;
      requireGovernanceMatch(id,old.governance_revision,ifMatch,instance);
      if(old.status!=="needs_changes")throw new MarketplaceGovernanceHttpError(409,"MARKETPLACE_EDIT_CONFLICT","This review resource is not awaiting seller changes",instance);
      const table=type==="listing"?"listings":"tool_manifests";
      const rows=await c.query(`UPDATE ${table} SET name=COALESCE($2,name),description=CASE WHEN $3 THEN $4 ELSE description END,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [id,input.name??null,Object.hasOwn(input,"description"),input.description??null]);
      const row=rows.rows[0],item=resourceItem(type,row);
      await appendGovernanceEvent(c,type,item,old.status,row.governance_revision,"seller",userId,"edit",input.reason);
      item.review_notes=await governanceNotes(c,type,id);await audit(item);return item;
    });
  }
  resubmit(tenantId:string,type:MarketplaceGovernanceResourceType,id:string,userId:string,reason:string,ifMatch:string|undefined,
    audit:(item:MarketplaceGovernanceItem)=>Promise<unknown>):Promise<MarketplaceGovernanceItem>{
    return this.withTenant(tenantId,async c=>{
      const old=await this.ownedResource(c,tenantId,type,id,true);
      const instance=`/api/v1/publisher/reviews/${type}/${id}/actions/resubmit`;
      requireGovernanceMatch(id,old.governance_revision,ifMatch,instance);
      if(old.status!=="needs_changes")throw new MarketplaceGovernanceHttpError(409,"MARKETPLACE_RESUBMIT_CONFLICT","Only a resource with requested changes can be resubmitted",instance);
      if(type==="listing"&&old.price_minor!=="0")throw new MarketplaceGovernanceHttpError(409,"MARKETPLACE_FREE_ONLY","Only free listings can be resubmitted in v1",instance);
      if(type==="tool_manifest"&&old.trust_level==="blocked")throw new MarketplaceGovernanceHttpError(409,"MARKETPLACE_RESUBMIT_CONFLICT","A blocked tool requires staff restoration",instance);
      const table=type==="listing"?"listings":"tool_manifests",status=type==="listing"?"submitted":"draft";
      const rows=await c.query(`UPDATE ${table} SET status=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id,status]);
      const row=rows.rows[0],item=resourceItem(type,row);
      await appendGovernanceEvent(c,type,item,old.status,row.governance_revision,"seller",userId,"resubmit",reason);
      item.review_notes=await governanceNotes(c,type,id);
      await audit(item);return item;
    });
  }
  private async ownedResource(c:PoolClient,tenantId:string,type:MarketplaceGovernanceResourceType,id:string,lock:boolean){
    const table=type==="listing"?"listings":"tool_manifests";
    const rows=await c.query(`SELECT * FROM ${table} WHERE id=$1 AND tenant_id=$2${lock?" FOR UPDATE":""}`,[id,tenantId]);
    if(!rows.rows[0])throw new MarketplaceGovernanceHttpError(404,"MARKETPLACE_REVIEW_NOT_FOUND","Seller review resource was not found",`/api/v1/publisher/reviews/${type}/${id}`);
    return rows.rows[0];
  }
  private async withTenant<T>(tenantId:string,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
    const c=await this.pool.connect();try{await c.query("BEGIN");await c.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenantId]);const value=await fn(c);await c.query("COMMIT");return value;}
    catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  }
}
