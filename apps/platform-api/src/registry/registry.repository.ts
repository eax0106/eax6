import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { CreateManifestInput, CreateVersionInput, Revocation, ScanReport, ToolManifest, ToolVersion } from "./types";
import type { PackageScanReport } from "./package-scan";
interface ManifestRow { id: string; tenant_id: string | null; name: string; ecosystem: ToolManifest["ecosystem"]; description: string | null; trust_level: ToolManifest["trustLevel"]; status: ToolManifest["status"]; publisher_id: string | null; created_at: Date; updated_at: Date; }
export interface RegistryVersionRow { id: string; manifest_id: string; version: string; artifact_ref: string; capabilities_json: readonly string[]; permissions_json: readonly string[]; pinned: boolean; status: ToolVersion["status"]; published_at: Date | null; latest_scan_report_id: string | null; reviewed_scan_report_id: string | null; review_decision: "approved" | "rejected" | null; reviewed_by: string | null; reviewed_at: Date | null; review_reason: string | null; }
type VersionRow = RegistryVersionRow;
interface ReportRow { id: string; tool_version_id: string; verdict: ScanReport["verdict"]; findings_json: ScanReport["findings"]; scanner_version: string; duration_ms: number; scanned_at: Date; }
interface RevocationRow { id: string; manifest_id: string; tool_version_id: string; reason: string; revoked_by: string; revoked_at: Date; propagated_at: Date | null; }
@Injectable() export class RegistryRepository implements OnModuleDestroy {
  constructor(private readonly pool: Pool, private readonly closePoolOnDestroy = false) {}
  list(tenantId: string) { return this.withTenant(tenantId, async (c) => (await c.query("SELECT * FROM tool_manifests ORDER BY created_at DESC, id DESC")).rows.map(manifest)); }
  get(tenantId: string, id: string) { return this.withTenant(tenantId, async (c) => { const r = await c.query("SELECT * FROM tool_manifests WHERE id = $1", [id]); return r.rows[0] ? manifest(r.rows[0]) : undefined; }); }
  createManifest(tenantId: string, id: string, input: CreateManifestInput) { return this.withTenant(tenantId, async (c) => manifest((await c.query(`INSERT INTO tool_manifests (id, tenant_id, name, ecosystem, description, trust_level, publisher_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, tenantId, input.name, input.ecosystem, input.description ?? null, input.trust_level, input.publisher_id ?? null])).rows[0])); }
  versions(tenantId: string, manifestId: string) { return this.withTenant(tenantId, async (c) => (await c.query("SELECT * FROM tool_versions WHERE manifest_id = $1 ORDER BY published_at DESC NULLS LAST, version DESC", [manifestId])).rows.map(version)); }
  getVersion(tenantId: string, manifestId: string, id: string) { return this.withTenant(tenantId, async (c) => { const r = await c.query("SELECT * FROM tool_versions WHERE manifest_id = $1 AND id = $2", [manifestId, id]); return r.rows[0] ? version(r.rows[0]) : undefined; }); }
  createVersion(tenantId: string, id: string, manifestId: string, input: CreateVersionInput) {
    return this.withTenant(tenantId, async c => {
      const owner = await c.query("SELECT id FROM tool_manifests WHERE id=$1 AND tenant_id=$2 AND trust_level<>'blocked' FOR UPDATE",[manifestId,tenantId]);
      if (!owner.rowCount) throw new RegistryScanStateError(404,"Tool manifest was not found");
      const result = await c.query(`INSERT INTO tool_versions (id,manifest_id,version,artifact_ref,capabilities_json,permissions_json,pinned)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING *`,[id,manifestId,input.version,input.artifact_ref,JSON.stringify(input.capabilities),JSON.stringify(input.permissions),input.pinned??false]);
      await c.query("UPDATE tool_manifests SET updated_at=clock_timestamp() WHERE id=$1",[manifestId]);
      return version(result.rows[0]);
    });
  }
  latestReport(tenantId: string, versionId: string) { return this.withTenant(tenantId, async (c) => { const r = await c.query("SELECT r.* FROM tool_scan_reports r JOIN tool_versions v ON v.latest_scan_report_id=r.id WHERE v.id=$1", [versionId]); return r.rows[0] ? report(r.rows[0]) : undefined; }); }

  beginScan(tenantId: string, manifestId: string, versionId: string): Promise<ToolVersion> {
    return this.withTenant(tenantId, async c => {
      const owner = await c.query("SELECT id FROM tool_manifests WHERE tenant_id=$1 AND id=$2 AND trust_level<>'blocked' FOR UPDATE", [tenantId,manifestId]);
      if (!owner.rowCount) throw new RegistryScanStateError(404,"Tool manifest was not found");
      const rows = await c.query<VersionRow>("SELECT * FROM tool_versions WHERE manifest_id=$1 AND id=$2 FOR UPDATE", [manifestId,versionId]);
      const row = rows.rows[0];
      if (!row) throw new RegistryScanStateError(404,"Tool version was not found");
      if (!["draft","scan_failed","scan_unavailable","review_pending"].includes(row.status)) throw new RegistryScanStateError(409,"Tool version cannot start another scan in its current state");
      const result = await c.query<VersionRow>("UPDATE tool_versions SET status='scanning' WHERE id=$1 RETURNING *", [versionId]);
      await c.query("UPDATE tool_manifests SET updated_at=clock_timestamp() WHERE id=$1",[manifestId]);
      return version(result.rows[0]!);
    });
  }

  completeScan(tenantId: string, manifestId: string, versionId: string, reportId: string, scan: PackageScanReport): Promise<ToolVersion> {
    return this.withTenant(tenantId, async c => {
      const owner = await c.query("SELECT id,trust_level,status FROM tool_manifests WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId,manifestId]);
      const rows = await c.query<VersionRow>("SELECT * FROM tool_versions WHERE manifest_id=$1 AND id=$2 FOR UPDATE", [manifestId,versionId]);
      const row = rows.rows[0];
      if (!owner.rowCount || !row) throw new RegistryScanStateError(404,"Tool version was not found");
      if (row.status !== "scanning" && row.status !== "revoked") throw new RegistryScanStateError(409,"Scan no longer owns this version");
      await c.query(`INSERT INTO tool_scan_reports (id,tenant_id,tool_version_id,verdict,findings_json,scanner_version,duration_ms,scanned_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [reportId,tenantId,versionId,scan.verdict,JSON.stringify(scan.findings),scan.scannerVersion,scan.durationMs,scan.scannedAt]);
      const first = await c.query(`SELECT 1 FROM tool_versions v JOIN tool_scan_reports r ON r.id=v.reviewed_scan_report_id
        WHERE v.manifest_id=$1 AND v.review_decision='approved' AND v.latest_scan_report_id=v.reviewed_scan_report_id
          AND r.verdict='clean' AND jsonb_array_length(r.findings_json)=0 LIMIT 1`, [manifestId]);
      const clean = scan.verdict === "clean" && scan.findings.length === 0;
      const status = row.status === "revoked" || owner.rows[0]!.trust_level === "blocked" ? "revoked"
        : clean ? (first.rowCount && owner.rows[0]!.status !== "needs_changes" ? "published" : "review_pending") : scan.verdict === "unavailable" ? "scan_unavailable" : "scan_failed";
      const updated = await c.query<VersionRow>(`UPDATE tool_versions SET latest_scan_report_id=$2,status=$3,
        published_at=CASE WHEN $3='published' THEN clock_timestamp() ELSE published_at END WHERE id=$1 RETURNING *`, [versionId,reportId,status]);
      if (status === "published") await c.query("UPDATE tool_manifests SET status='published',updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [manifestId,tenantId]);
      if (status !== "published") await c.query("UPDATE tool_manifests SET updated_at=clock_timestamp() WHERE id=$1",[manifestId]);
      return version(updated.rows[0]!);
    });
  }
  revoke(tenantId: string, id: string, manifestId: string, versionId: string, reason: string, revokedBy: string) { return this.withTenant(tenantId, async (c) => { await c.query("SELECT id FROM tool_manifests WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [manifestId,tenantId]); const prior = await c.query("SELECT * FROM tool_revocations WHERE tool_version_id = $1", [versionId]); if (prior.rows[0]) return revocation(prior.rows[0]); await c.query("UPDATE tool_versions SET status = 'revoked' WHERE id = $1", [versionId]); await c.query(`UPDATE tool_manifests SET status = CASE WHEN status='needs_changes' THEN 'needs_changes' WHEN EXISTS (SELECT 1 FROM tool_versions WHERE manifest_id = $1 AND status = 'published') THEN 'published' ELSE 'draft' END, updated_at = clock_timestamp() WHERE tenant_id = $2 AND id = $1`, [manifestId, tenantId]); return revocation((await c.query(`INSERT INTO tool_revocations (id, tenant_id, manifest_id, tool_version_id, reason, revoked_by, propagated_at) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()) RETURNING *`, [id, tenantId, manifestId, versionId, reason, revokedBy])).rows[0]); }); }
  async onModuleDestroy() { if (this.closePoolOnDestroy) await this.pool.end(); }
  private async withTenant<T>(tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> { const c = await this.pool.connect(); try { await c.query("BEGIN"); await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]); const value = await action(c); await c.query("COMMIT"); return value; } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); } }
}
function manifest(r: ManifestRow): ToolManifest { return { id:r.id, tenantId:r.tenant_id, name:r.name, ecosystem:r.ecosystem, description:r.description, trustLevel:r.trust_level, status:r.status, publisherId:r.publisher_id, createdAt:r.created_at.toISOString(), updatedAt:r.updated_at.toISOString() }; }
export function registryVersionResource(r: VersionRow): ToolVersion { return { id:r.id, manifestId:r.manifest_id, version:r.version, artifactRef:r.artifact_ref, capabilities:r.capabilities_json, permissions:r.permissions_json, pinned:r.pinned, status:r.status, publishedAt:r.published_at?.toISOString() ?? null, scanReportId:r.latest_scan_report_id ?? null, review:r.review_decision ? {scanReportId:r.reviewed_scan_report_id!,decision:r.review_decision,reviewedBy:r.reviewed_by!,reviewedAt:r.reviewed_at!.toISOString(),reason:r.review_reason!} : null }; }
const version = registryVersionResource;
function report(r: ReportRow): ScanReport { return { id:r.id, toolVersionId:r.tool_version_id, verdict:r.verdict, findings:r.findings_json, scannerVersion:r.scanner_version, durationMs:r.duration_ms, scannedAt:r.scanned_at.toISOString() }; }
function revocation(r: RevocationRow): Revocation { return { id:r.id, manifestId:r.manifest_id, toolVersionId:r.tool_version_id, reason:r.reason, revokedBy:r.revoked_by, revokedAt:r.revoked_at.toISOString(), propagatedAt:r.propagated_at?.toISOString() ?? null }; }

export class RegistryScanStateError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
