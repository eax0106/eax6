import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import type { ToolVersion, ScanReport } from "../registry/types";
import { registryVersionResource, type RegistryVersionRow } from "../registry/registry.repository";
import { MarketplaceGovernanceHttpError } from "./problem";

import type { ToolVersionReviewItem } from "@alterx/shared-clients";

export interface ToolVersionReviewInput { scanReportId: string; decision: "approved" | "rejected"; reason: string }

@Injectable()
export class ToolVersionReviewRepository implements OnModuleDestroy {
  constructor(private readonly pool: Pool | undefined, private readonly closePoolOnDestroy = false) {}

  async list(): Promise<ToolVersionReviewItem[]> {
    const rows = await this.requirePool().query<RegistryVersionRow & { name: string; tenant_id: string; scan_json: Record<string, unknown> }>(`
      SELECT v.*,m.name,m.tenant_id,row_to_json(r) AS scan_json FROM tool_versions v
      JOIN tool_manifests m ON m.id=v.manifest_id JOIN tool_scan_reports r ON r.id=v.latest_scan_report_id
      WHERE v.status='review_pending' AND m.trust_level<>'blocked' AND m.status<>'needs_changes' ORDER BY r.scanned_at,v.id LIMIT 200`);
    return rows.rows.map(row => ({ manifestId:row.manifest_id,tenantId:row.tenant_id,name:row.name,version:registryVersionResource(row),scan:{
      id:String(row.scan_json.id),toolVersionId:row.id,verdict:row.scan_json.verdict as ScanReport["verdict"], findings:row.scan_json.findings_json as ScanReport["findings"],
      scannerVersion:String(row.scan_json.scanner_version),durationMs:Number(row.scan_json.duration_ms),scannedAt:new Date(String(row.scan_json.scanned_at)).toISOString(),
    } }));
  }

  async review(manifestId: string, versionId: string, staffUserId: string, input: ToolVersionReviewInput,
    audit: (tenantId: string) => Promise<unknown>): Promise<ToolVersion> {
    const c = await this.requirePool().connect();
    const instance = `/api/v1/admin/marketplace/governance/tools/${manifestId}/versions/${versionId}/review`;
    const invalid = (status: number, detail: string) => new MarketplaceGovernanceHttpError(status,"TOOL_REVIEW_CONFLICT",detail,instance);
    try {
      await c.query("BEGIN");
      const owners = await c.query<{ tenant_id: string | null; trust_level: string; status: string }>("SELECT tenant_id,trust_level,status FROM tool_manifests WHERE id=$1 FOR UPDATE", [manifestId]);
      const rows = await c.query<RegistryVersionRow>("SELECT * FROM tool_versions WHERE manifest_id=$1 AND id=$2 FOR UPDATE", [manifestId,versionId]);
      const row = rows.rows[0],owner = owners.rows[0];
      if (!row || !owner || !owner.tenant_id || owner.trust_level === "blocked") throw invalid(404,"Tool version was not found");
      if (owner.status === "needs_changes") throw invalid(409,"The seller must resubmit requested changes before version review");
      if (row.latest_scan_report_id !== input.scanReportId) throw invalid(409,"The scan changed; reload before reviewing");
      if (row.reviewed_scan_report_id === input.scanReportId) {
        if (row.review_decision !== input.decision || row.review_reason !== input.reason || row.reviewed_by !== staffUserId) throw invalid(409,"This scan already has a different recorded staff decision");
        await c.query("COMMIT"); return registryVersionResource(row);
      }
      if (row.status !== "review_pending") throw invalid(409,"This version is not awaiting staff review");
      const scan = await c.query<{ verdict: string; findings_json: unknown }>("SELECT verdict,findings_json FROM tool_scan_reports WHERE id=$1 AND tool_version_id=$2", [input.scanReportId,versionId]);
      if (scan.rows[0]?.verdict !== "clean" || !Array.isArray(scan.rows[0]?.findings_json) || scan.rows[0]!.findings_json.length !== 0) throw invalid(409,"Staff approval requires a complete clean scan");
      const status = input.decision === "approved" ? "published" : "scan_failed";
      const updated = await c.query<RegistryVersionRow>(`UPDATE tool_versions SET reviewed_scan_report_id=$2,review_decision=$3,reviewed_by=$4,
        reviewed_at=clock_timestamp(),review_reason=$5,status=$6,published_at=CASE WHEN $6='published' THEN clock_timestamp() ELSE published_at END WHERE id=$1 RETURNING *`,
        [versionId,input.scanReportId,input.decision,staffUserId,input.reason,status]);
      if (status === "published") await c.query("UPDATE tool_manifests SET status='published',updated_at=clock_timestamp() WHERE id=$1", [manifestId]);
      await audit(owner.tenant_id);
      await c.query("COMMIT");
      return registryVersionResource(updated.rows[0]!);
    } catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  }

  async onModuleDestroy() { if (this.closePoolOnDestroy) await this.pool?.end(); }
  private requirePool(): Pool {
    if (!this.pool) throw new MarketplaceGovernanceHttpError(503,"TOOL_REVIEW_UNAVAILABLE","Operations marketplace database binding is not configured","/api/v1/admin/marketplace/governance/tools/review-queue");
    return this.pool;
  }
}
