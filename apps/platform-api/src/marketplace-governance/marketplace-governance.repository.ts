import {Injectable,type OnModuleDestroy} from "@nestjs/common";
import type {MarketplaceGovernanceActionRequest,MarketplaceGovernanceItem,MarketplaceGovernanceResourceType} from "@alterx/contracts";
import type {Pool,PoolClient} from "pg";
import {appendGovernanceEvent,governanceEtag,governanceNotes,requireGovernanceMatch,type GovernanceWrite} from "./governance-history";
import {governanceQueueRows} from "./queue-query";
import {collectMarketplaceRisk} from "./risk-collector";

interface ResourceRow {id:string;tenant_id:string|null;name:string;description?:string|null;status:string;updated_at:Date;governance_revision:string;trust_level?:string|null;price_minor?:string}
@Injectable()
export class MarketplaceGovernanceRepository implements OnModuleDestroy {
  constructor(private readonly pool:Pool|undefined,private readonly closePoolOnDestroy=false){}
  async list():Promise<MarketplaceGovernanceItem[]> {
    const pool=this.requirePool();
    const rows=await governanceQueueRows(pool);
    const items=rows.rows.map(row=>resourceItem(row.resource_type,row));
    await collectMarketplaceRisk(pool,items);
    await Promise.all(items.map(async item=>{item.review_notes=await governanceNotes(pool,item.resource_type,item.id,5);}));
    return items.sort((a,b)=>(b.risk?.score??0)-(a.risk?.score??0)||a.updated_at.localeCompare(b.updated_at)||a.id.localeCompare(b.id));
  }
  async act(resourceType:MarketplaceGovernanceResourceType,id:string,input:MarketplaceGovernanceActionRequest,
    write:GovernanceWrite):Promise<MarketplaceGovernanceItem|undefined>{
    const c=await this.requirePool().connect();
    const instance=`/api/v1/admin/marketplace/governance/${resourceType}/${id}/actions/apply`;
    try{
      await c.query("BEGIN");
      // Table names are constants selected from the validated resource type.
      const table=resourceType==="listing"?"listings":"tool_manifests";
      const rows=await c.query<ResourceRow>(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);
      const old=rows.rows[0];
      if(!old){await c.query("COMMIT");return undefined;}
      requireGovernanceMatch(id,old.governance_revision,write.ifMatch,instance);
      if(!old.tenant_id)throw new MarketplaceGovernanceInvalidActionError("An erased seller resource cannot receive a new review decision");
      const status=await this.nextStatus(c,resourceType,old,input);
      const trust=input.action==="set_trust"?input.trust_level:input.action==="takedown"?"blocked":input.action==="restore"?"unverified_private":null;
      const updated=resourceType==="listing"
        ?await c.query<ResourceRow>(`UPDATE listings SET status=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id,status])
        :await c.query<ResourceRow>(`UPDATE tool_manifests SET status=$2,trust_level=COALESCE($3,trust_level),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id,status,trust]);
      const row=updated.rows[0]!;
      if(resourceType==="tool_manifest"&&input.action==="takedown")await c.query("UPDATE tool_versions SET status='revoked' WHERE manifest_id=$1 AND status<>'revoked'",[id]);
      if(resourceType==="listing"&&input.action==="approve")await c.query("UPDATE listing_versions SET published_at=COALESCE(published_at,clock_timestamp()) WHERE listing_id=$1 AND version=$2",[id,(old as ResourceRow & {latest_version:string}).latest_version]);
      const item=resourceItem(resourceType,row);
      await appendGovernanceEvent(c,resourceType,item,old.status,row.governance_revision,"staff",write.actorRef,input.action,input.reason);
      item.review_notes=await governanceNotes(c,resourceType,id);
      await write.audit(item);
      await c.query("COMMIT");return item;
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  }
  private async nextStatus(c:PoolClient,type:MarketplaceGovernanceResourceType,row:ResourceRow,input:MarketplaceGovernanceActionRequest):Promise<string>{
    const invalid=(message:string):never=>{throw new MarketplaceGovernanceInvalidActionError(message);};
    if(input.action==="set_trust"){
      if(type==="listing")return invalid("Listing resources do not have a trust level");
      return row.status;
    }
    if(input.action==="needs_changes"||input.action==="reject"||input.action==="approve"){
      const reviewable=type==="listing"?["submitted","automated_review","human_review"]:["draft"];
      if(!reviewable.includes(row.status))return invalid("This resource is not awaiting a review decision; the seller must resubmit changes");
    }
    if(input.action==="needs_changes")return "needs_changes";
    if(input.action==="reject")return type==="listing"?"private_testing":"draft";
    if(input.action==="takedown")return type==="listing"?"removed":"blocked";
    if(input.action==="restore"){
      if(!(type==="listing"?["removed","suspended"]:["blocked"]).includes(row.status))return invalid("Only a withdrawn resource can be restored to draft");
      return "draft";
    }
    if(type==="listing"){
      if(row.price_minor!=="0")return invalid("Only free listings can be published in v1");
      const version=await c.query("SELECT 1 FROM listing_versions v JOIN listings l ON l.id=v.listing_id WHERE l.id=$1 AND v.version=l.latest_version",[row.id]);
      if(!version.rowCount)return invalid("A current listing version is required before publishing");
    }else{
      const reviewed=await c.query(`SELECT 1 FROM tool_versions v JOIN tool_scan_reports r ON r.id=v.latest_scan_report_id
        WHERE v.manifest_id=$1 AND v.status='published' AND r.verdict='clean' AND jsonb_array_length(r.findings_json)=0
        AND EXISTS(SELECT 1 FROM tool_versions first JOIN tool_scan_reports reviewed ON reviewed.id=first.reviewed_scan_report_id
          WHERE first.manifest_id=v.manifest_id AND first.review_decision='approved' AND first.reviewed_scan_report_id=first.latest_scan_report_id
          AND reviewed.verdict='clean' AND jsonb_array_length(reviewed.findings_json)=0) LIMIT 1`,[row.id]);
      if(!reviewed.rowCount)return invalid("Tool publication requires a clean scan and recorded first-version staff review");
    }
    return "published";
  }
  async onModuleDestroy():Promise<void>{if(this.closePoolOnDestroy)await this.pool?.end();}
  private requirePool():Pool{if(!this.pool)throw new MarketplaceGovernanceUnavailableError();return this.pool;}
}
export function resourceItem(type:MarketplaceGovernanceResourceType,row:ResourceRow):MarketplaceGovernanceItem{
  return {resource_type:type,id:row.id,tenant_id:row.tenant_id,name:row.name,description:row.description,status:row.status,trust_level:row.trust_level??null,
    updated_at:row.updated_at.toISOString(),etag:governanceEtag(row.id,row.governance_revision)};
}
export class MarketplaceGovernanceUnavailableError extends Error{constructor(){super("Operations marketplace database binding is not configured");}}
export class MarketplaceGovernanceInvalidActionError extends Error{}
