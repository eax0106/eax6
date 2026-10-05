import type {Pool} from "pg";
import {SIDE_EFFECT_TOOL_NAMES,TOOL_NAMES,type MarketplaceGovernanceResourceType} from "@alterx/contracts";
import {RISK_WEIGHTS} from "./risk";
interface QueueRow {resource_type:MarketplaceGovernanceResourceType;id:string;tenant_id:string|null;name:string;status:string;
  trust_level:string|null;updated_at:Date;governance_revision:string}

/** Rank the full review population before bounding its response. Read-only; shares advisory weights with reasons. */
export function governanceQueueRows(pool:Pool){
  return pool.query<QueueRow>(`WITH resources AS (
    SELECT 'listing'::text AS resource_type,id,tenant_id,name,status,NULL::text AS trust_level,created_at,updated_at,governance_revision FROM listings
    UNION ALL SELECT 'tool_manifest'::text,id,tenant_id,name,status,trust_level,created_at,updated_at,governance_revision FROM tool_manifests
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY regexp_replace(tenant_id,'^ten_','') ORDER BY created_at,id) AS seller_order FROM resources
  ), eligible AS (
    SELECT * FROM ranked WHERE (resource_type='listing' AND status IN ('submitted','automated_review','human_review','needs_changes','suspended'))
      OR (resource_type='tool_manifest' AND status IN ('draft','needs_changes','blocked'))
  ), declarations AS (
    SELECT manifest_id,
      bool_and(CASE WHEN jsonb_typeof(capabilities_json)='array' THEN NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(capabilities_json) value WHERE jsonb_typeof(value)<>'string' OR (value #>> '{}')<>ALL($9::text[])
      ) ELSE false END) AS known_actions,
      bool_or(CASE WHEN jsonb_typeof(capabilities_json)='array' THEN EXISTS(
        SELECT 1 FROM jsonb_array_elements_text(capabilities_json) value WHERE value=ANY($8::text[])
      ) ELSE false END) AS outside_actions,
      bool_and(CASE WHEN jsonb_typeof(permissions_json)='array' THEN NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(permissions_json) value WHERE jsonb_typeof(value)<>'string'
      ) ELSE false END) AS known_scopes,
      bool_or(CASE WHEN jsonb_typeof(permissions_json)='array' THEN jsonb_array_length(permissions_json)>0 ELSE false END) AS account_scopes
    FROM tool_versions WHERE status<>'revoked' GROUP BY manifest_id
  ), takedowns AS (
    SELECT tenant_id,count(*) AS count FROM marketplace_governance_events WHERE actor_type='staff' AND action='takedown' GROUP BY tenant_id
  ) SELECT e.resource_type,e.id,e.tenant_id,e.name,e.status,e.trust_level,e.updated_at,e.governance_revision,
    LEAST(100,CASE current_scan.verdict WHEN 'blocked' THEN $1::int WHEN 'findings' THEN $2::int ELSE 0 END
      +CASE WHEN e.tenant_id IS NOT NULL AND e.seller_order=1 THEN $3::int ELSE 0 END
      +CASE WHEN d.known_actions AND d.outside_actions THEN $4::int ELSE 0 END
      +CASE WHEN d.known_scopes AND d.account_scopes THEN $5::int ELSE 0 END
      +LEAST($6::int,COALESCE(t.count,0)*$7::int)) AS advisory_score
    FROM eligible e LEFT JOIN declarations d ON d.manifest_id=e.id
    LEFT JOIN takedowns t ON t.tenant_id=regexp_replace(e.tenant_id,'^ten_','')
    LEFT JOIN LATERAL (
      SELECT r.verdict FROM tool_versions v JOIN tool_scan_reports r ON r.id=v.latest_scan_report_id AND r.tool_version_id=v.id
      WHERE v.manifest_id=e.id AND v.status<>'revoked' ORDER BY r.scanned_at DESC,v.id DESC LIMIT 1
    ) current_scan ON true
    ORDER BY advisory_score DESC,e.updated_at ASC,e.id ASC LIMIT 200`,
    [RISK_WEIGHTS.blocked,RISK_WEIGHTS.findings,RISK_WEIGHTS.first,RISK_WEIGHTS.outside,RISK_WEIGHTS.scopes,RISK_WEIGHTS.maxTakedowns,RISK_WEIGHTS.takedown,SIDE_EFFECT_TOOL_NAMES,TOOL_NAMES]);
}
