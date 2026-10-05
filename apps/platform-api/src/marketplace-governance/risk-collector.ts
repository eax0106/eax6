import type {Pool} from "pg";
import {hasExternalSideEffect,TOOL_NAMES,type MarketplaceGovernanceItem} from "@alterx/contracts";
import {marketplaceRisk,type MarketplaceRiskSignals} from "./risk";

interface HistorySignal {id:string;first_listing:boolean;takedowns:string}
interface ToolSignal {manifest_id:string;capabilities_json:unknown;permissions_json:unknown;latest_scan_report_id:string|null;
  verdict:NonNullable<MarketplaceRiskSignals["scanner"]>["verdict"];
  scanned_at:Date|null;status:string}
function declaredStrings(value:unknown):string[]|null{
  return Array.isArray(value)&&value.every(entry=>typeof entry==="string")?value:null;
}
/** Read stored signals only; do not invoke scanners, fetch packages, or write decisions. */
export async function collectMarketplaceRisk(pool:Pool,items:MarketplaceGovernanceItem[]):Promise<void>{
  if(!items.length)return;
  const ids=items.map(item=>item.id);
  const [history,versions]=await Promise.all([
    pool.query<HistorySignal>(`WITH resources AS (
        SELECT id,tenant_id,created_at FROM listings UNION ALL SELECT id,tenant_id,created_at FROM tool_manifests
      ) SELECT x.id,NOT EXISTS(SELECT 1 FROM resources prior WHERE regexp_replace(prior.tenant_id,'^ten_','')=regexp_replace(x.tenant_id,'^ten_','')
        AND (prior.created_at,prior.id)<(x.created_at,x.id)) AS first_listing,
        (SELECT count(*) FROM marketplace_governance_events e WHERE e.tenant_id=regexp_replace(x.tenant_id,'^ten_','') AND e.actor_type='staff'
          AND e.action='takedown')::text AS takedowns
      FROM resources x WHERE x.id=ANY($1::text[])`,[ids]),
    pool.query<ToolSignal>(`SELECT v.manifest_id,v.capabilities_json,v.permissions_json,v.latest_scan_report_id,v.status,r.verdict,r.scanned_at
      FROM tool_versions v LEFT JOIN tool_scan_reports r ON r.id=v.latest_scan_report_id AND r.tool_version_id=v.id
      WHERE v.manifest_id=ANY($1::text[]) AND v.status<>'revoked' ORDER BY r.scanned_at DESC NULLS LAST,v.id DESC`,[ids]),
  ]);
  const byId=new Map(history.rows.map(row=>[row.id,row]));
  const byManifest=new Map<string,ToolSignal[]>();
  for(const version of versions.rows){const rows=byManifest.get(version.manifest_id)??[];rows.push(version);byManifest.set(version.manifest_id,rows);}
  for(const item of items){
    const recorded=byId.get(item.id);
    const rows=byManifest.get(item.id)??[];
    const latest=rows.find(row=>row.latest_scan_report_id&&row.verdict);
    const capabilities=rows.map(row=>declaredStrings(row.capabilities_json));
    const permissions=rows.map(row=>declaredStrings(row.permissions_json));
    const knownActions=item.resource_type==="tool_manifest"&&rows.length>0&&capabilities.every(value=>value!==null&&value.every(name=>(TOOL_NAMES as readonly string[]).includes(name)));
    const risk=marketplaceRisk({
      scanner:latest?{reportId:latest.latest_scan_report_id!,verdict:latest.verdict}:null,
      firstListing:item.tenant_id && recorded ? recorded.first_listing : null,
      outsideActions:knownActions?capabilities.flatMap(value=>value!).filter(hasExternalSideEffect):null,
      accountScopes:item.resource_type==="tool_manifest"&&rows.length>0&&permissions.every(value=>value!==null)?permissions.flatMap(value=>value!):null,
      priorTakedowns:item.tenant_id && recorded ? Number(recorded.takedowns) : null,
    });
    if(rows.some(row=>!row.latest_scan_report_id||row.status==="scanning")){
      risk.reasons.push({signal:"scanner",points:0,detail:"An active version has no completed current scan",evidence:[],observed:false});
      risk.incomplete=true;
    }
    item.risk={...risk,reasons:risk.reasons.map(reason=>({...reason,evidence:[...reason.evidence]}))};
  }
}
