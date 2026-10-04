import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type {
  MarketplaceGovernanceActionRequest,
  MarketplaceGovernanceItem,
  MarketplaceGovernanceResourceType,
} from "@alterx/contracts";
import type { Pool, PoolClient } from "pg";

interface ListingRow {
  id: string;
  tenant_id: string | null;
  name: string;
  status: string;
  updated_at: Date;
}

interface ManifestRow extends ListingRow {
  trust_level: string;
}

@Injectable()
export class MarketplaceGovernanceRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool | undefined,
    private readonly closePoolOnDestroy = false,
  ) {}

  async list(): Promise<MarketplaceGovernanceItem[]> {
    const pool = this.requirePool();
    const [listings, manifests] = await Promise.all([
      pool.query<ListingRow>(
        `SELECT id, tenant_id, name, status, updated_at
         FROM listings
         WHERE status IN ('submitted', 'automated_review', 'human_review', 'suspended')
         ORDER BY updated_at DESC, id DESC`,
      ),
      pool.query<ManifestRow>(
        `SELECT id, tenant_id, name, status, trust_level, updated_at
         FROM tool_manifests
         WHERE status IN ('draft', 'blocked')
         ORDER BY updated_at DESC, id DESC`,
      ),
    ]);
    return [
      ...listings.rows.map((row) => listingItem(row)),
      ...manifests.rows.map((row) => manifestItem(row)),
    ].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async act(
    resourceType: MarketplaceGovernanceResourceType,
    id: string,
    input: MarketplaceGovernanceActionRequest,
  ): Promise<MarketplaceGovernanceItem | undefined> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const item = resourceType === "listing"
        ? await this.actOnListing(client, id, input)
        : await this.actOnManifest(client, id, input);
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool?.end();
  }

  private async actOnListing(
    client: PoolClient,
    id: string,
    input: MarketplaceGovernanceActionRequest,
  ): Promise<MarketplaceGovernanceItem | undefined> {
    if (input.action === "set_trust") {
      throw new MarketplaceGovernanceInvalidActionError(
        "Listing resources do not have a trust level",
      );
    }
    const status = {
      approve: "published",
      reject: "private_testing",
      takedown: "removed",
      restore: "draft",
    }[input.action];
    const result = await client.query<ListingRow>(
      `UPDATE listings SET status = $2, updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING id, tenant_id, name, status, updated_at`,
      [id, status],
    );
    return result.rows[0] ? listingItem(result.rows[0]) : undefined;
  }

  private async actOnManifest(
    client: PoolClient,
    id: string,
    input: MarketplaceGovernanceActionRequest,
  ): Promise<MarketplaceGovernanceItem | undefined> {
    await client.query("SELECT id FROM tool_manifests WHERE id=$1 FOR UPDATE", [id]);
    if (input.action === "approve") {
      const reviewed = await client.query(`SELECT 1 FROM tool_manifests m JOIN tool_versions v ON v.manifest_id=m.id
        JOIN tool_scan_reports r ON r.id=v.latest_scan_report_id WHERE m.id=$1 AND v.status='published' AND r.verdict='clean'
        AND jsonb_array_length(r.findings_json)=0 AND EXISTS (SELECT 1 FROM tool_versions first
          JOIN tool_scan_reports reviewed ON reviewed.id=first.reviewed_scan_report_id
          WHERE first.manifest_id=m.id AND first.review_decision='approved' AND first.reviewed_scan_report_id=first.latest_scan_report_id
            AND reviewed.verdict='clean' AND jsonb_array_length(reviewed.findings_json)=0) LIMIT 1`, [id]);
      if (!reviewed.rowCount) throw new MarketplaceGovernanceInvalidActionError("Tool publication requires a clean scan and recorded first-version staff review");
    }
    const status = input.action === "approve"
      ? "published"
      : input.action === "takedown" ? "blocked" : "draft";
    const trust = input.action === "set_trust"
      ? input.trust_level!
      : input.action === "takedown"
        ? "blocked"
        : input.action === "restore" ? "unverified_private" : null;
    const result = await client.query<ManifestRow>(
      `UPDATE tool_manifests SET
         status = CASE WHEN $2 = 'set_trust' THEN status ELSE $3 END,
         trust_level = COALESCE($4, trust_level),
         updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING id, tenant_id, name, status, trust_level, updated_at`,
      [id, input.action, status, trust],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (input.action === "takedown") {
      await client.query(
        `UPDATE tool_versions SET status = 'revoked'
         WHERE manifest_id = $1 AND status <> 'revoked'`,
        [id],
      );
    }
    return manifestItem(row);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new MarketplaceGovernanceUnavailableError();
    return this.pool;
  }
}

function listingItem(row: ListingRow): MarketplaceGovernanceItem {
  return {
    resource_type: "listing",
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    status: row.status,
    trust_level: null,
    updated_at: row.updated_at.toISOString(),
  };
}

function manifestItem(row: ManifestRow): MarketplaceGovernanceItem {
  return {
    resource_type: "tool_manifest",
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    status: row.status,
    trust_level: row.trust_level,
    updated_at: row.updated_at.toISOString(),
  };
}

export class MarketplaceGovernanceUnavailableError extends Error {
  constructor() {
    super("Operations marketplace database binding is not configured");
  }
}

export class MarketplaceGovernanceInvalidActionError extends Error {}
