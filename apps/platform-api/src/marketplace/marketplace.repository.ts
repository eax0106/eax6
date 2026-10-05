import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { MarketplaceHttpError } from "./problem";
import type {
  CreateListingInput,
  CreateListingVersionInput,
  CreateReviewInput,
  InstallRecord,
  LicenseType,
  ListingCompatibility,
  ListingQuery,
  ListingRecord,
  ListingStatus,
  ListingType,
  ListingVersionRecord,
  ReviewRecord,
  UpdateListingInput,
} from "./types";

export interface ListingCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListingPage {
  readonly data: readonly ListingRecord[];
  readonly hasMore: boolean;
}

interface ListingRow {
  id: string;
  tenant_id: string | null;
  type: ListingType;
  name: string;
  description: string | null;
  latest_version: string | null;
  license_type: LicenseType;
  price_minor: string;
  currency: "INR";
  status: ListingStatus;
  created_at: Date;
  updated_at: Date;
}

interface ListingVersionRow {
  id: string;
  listing_id: string;
  version: string;
  payload_ref: string;
  compatibility_json: ListingCompatibility;
  published_at: Date | null;
}

interface InstallRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  listing_id: string;
  listing_version_id: string;
  installed_payload_ref: string;
  license_type: LicenseType;
  idempotency_key: string;
  installed_at: Date;
}

interface ReviewRow {
  id: string;
  tenant_id: string;
  listing_id: string;
  install_id: string;
  rating: number;
  comment: string | null;
  created_at: Date;
}

@Injectable()
export class MarketplaceRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  listListings(
    tenantId: string,
    query: ListingQuery,
    cursor?: ListingCursor,
  ): Promise<ListingPage> {
    return this.withTenant(tenantId, async (client) => {
      const conditions = [query.owner === "me" ? "true" : "price_minor = 0"];
      const values: unknown[] = [];
      const add = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      if (query.owner === "me") conditions.push(`tenant_id = ${add(tenantId)}`);
      if (query.type) conditions.push(`type = ${add(query.type)}`);
      if (query.status) conditions.push(`status = ${add(query.status)}`);
      if (cursor) {
        const createdAt = add(cursor.createdAt);
        const id = add(cursor.id);
        conditions.push(`(created_at, id) < (${createdAt}::timestamptz, ${id})`);
      }
      values.push(query.limit + 1);
      const result = await client.query<ListingRow>(
        `SELECT * FROM listings
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > query.limit;
      return {
        data: result.rows.slice(0, query.limit).map(mapListing),
        hasMore,
      };
    });
  }

  findListing(tenantId: string, id: string): Promise<ListingRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingRow>(
        "SELECT * FROM listings WHERE id = $1",
        [id],
      );
      return result.rows[0] ? mapListing(result.rows[0]) : undefined;
    });
  }

  createListing(
    tenantId: string,
    id: string,
    input: CreateListingInput,
  ): Promise<ListingRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingRow>(
        `INSERT INTO listings
           (id, tenant_id, type, name, description, license_type, price_minor, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
         RETURNING *`,
        [
          id,
          tenantId,
          input.type,
          input.name,
          input.description ?? null,
          input.license_type,
          input.price_minor ?? "0",
        ],
      );
      return mapListing(result.rows[0]!);
    });
  }

  updateListing(
    tenantId: string,
    id: string,
    input: UpdateListingInput,
  ): Promise<ListingRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingRow>(
        `UPDATE listings
         SET name = COALESCE($3, name),
             description = CASE WHEN $4 THEN $5 ELSE description END,
             license_type = COALESCE($6, license_type),
             status = COALESCE($7, status),
             price_minor = COALESCE($8, price_minor),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
           AND ($8::bigint IS NULL OR status IN ('draft', 'private_testing', 'needs_changes'))
         RETURNING *`,
        [
          tenantId,
          id,
          input.name ?? null,
          Object.hasOwn(input, "description"),
          input.description ?? null,
          input.license_type ?? null,
          input.status ?? null,
          input.price_minor ?? null,
        ],
      );
      return result.rows[0] ? mapListing(result.rows[0]) : undefined;
    });
  }

  publishListing(tenantId: string, id: string): Promise<ListingRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingRow>(
        `UPDATE listings SET status = 'published', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND latest_version IS NOT NULL AND price_minor = 0
           AND EXISTS (SELECT 1 FROM listing_versions
                       WHERE listing_id = $2 AND version = listings.latest_version)
         RETURNING *`,
        [tenantId, id],
      );
      const listing = result.rows[0];
      if (!listing) return undefined;
      const version = await client.query(
        `UPDATE listing_versions
         SET published_at = COALESCE(published_at, clock_timestamp())
         WHERE listing_id = $1 AND version = $2
         RETURNING id`,
        [id, listing.latest_version],
      );
      if (version.rowCount !== 1) throw new Error("Published listing version is unavailable");
      return mapListing(listing);
    });
  }

  listVersions(tenantId: string, listingId: string): Promise<ListingVersionRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingVersionRow>(
        `SELECT v.* FROM listing_versions v
         JOIN listings l ON l.id = v.listing_id
         WHERE v.listing_id = $1
           AND (v.published_at IS NOT NULL OR l.tenant_id = $2)
         ORDER BY v.published_at DESC NULLS LAST, v.version DESC, v.id DESC`,
        [listingId, tenantId],
      );
      return result.rows.map(mapVersion);
    });
  }

  findVersion(
    tenantId: string,
    listingId: string,
    versionId: string,
  ): Promise<ListingVersionRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingVersionRow>(
        `SELECT * FROM listing_versions
         WHERE listing_id = $1 AND id = $2`,
        [listingId, versionId],
      );
      return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
    });
  }

  createVersion(
    tenantId: string,
    id: string,
    listingId: string,
    input: CreateListingVersionInput,
  ): Promise<ListingVersionRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingVersionRow>(
        `INSERT INTO listing_versions
           (id, listing_id, version, payload_ref, compatibility_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [
          id,
          listingId,
          input.version,
          input.payload_ref,
          JSON.stringify(input.compatibility),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Listing version insert denied");
      await client.query(
        `UPDATE listings SET latest_version = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, listingId, input.version],
      );
      return mapVersion(row);
    });
  }

  findLatestVersion(
    tenantId: string,
    listingId: string,
  ): Promise<ListingVersionRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ListingVersionRow>(
        `SELECT v.* FROM listing_versions v
         JOIN listings l ON l.id = v.listing_id
         WHERE v.listing_id = $1 AND v.version = l.latest_version`,
        [listingId],
      );
      return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
    });
  }

  findInstallByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<InstallRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<InstallRow>(
        "SELECT * FROM installs WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, idempotencyKey],
      );
      return result.rows[0] ? mapInstall(result.rows[0]) : undefined;
    });
  }

  createInstall(
    tenantId: string,
    id: string,
    workspaceId: string,
    listingId: string,
    listingVersionId: string,
    installedPayloadRef: string,
    licenseType: LicenseType,
    idempotencyKey: string,
  ): Promise<InstallRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<InstallRow>(
        `INSERT INTO installs
           (id, tenant_id, workspace_id, listing_id, listing_version_id, installed_payload_ref, license_type, idempotency_key)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8 FROM listings WHERE id = $4 AND price_minor = 0
         RETURNING *`,
        [id, tenantId, workspaceId, listingId, listingVersionId, installedPayloadRef, licenseType, idempotencyKey],
      );
      if (!result.rows[0]) throw new MarketplaceHttpError(409, "MARKETPLACE_FREE_ONLY", "Only free listings can be installed in v1.", `/api/v1/marketplace/listings/${listingId}/actions/install`);
      return mapInstall(result.rows[0]);
    });
  }

  findInstallForListing(
    tenantId: string,
    listingId: string,
  ): Promise<InstallRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<InstallRow>(
        `SELECT * FROM installs
         WHERE tenant_id = $1 AND listing_id = $2
         ORDER BY installed_at DESC, id DESC
         LIMIT 1`,
        [tenantId, listingId],
      );
      return result.rows[0] ? mapInstall(result.rows[0]) : null;
    });
  }

  // ENGINE-FIX-B8-2: was unbounded (no LIMIT) -- grows without bound over a
  // tenant's lifetime. The "my-assets" route this backs returns a bare
  // array with no pagination UI on the caller side, so (as with
  // publisher.repository.ts's listPayouts, same finding) a generous cap is
  // a real safety net, not a functional pagination story.
  listAssets(tenantId: string): Promise<InstallRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<InstallRow>(
        "SELECT * FROM installs WHERE tenant_id = $1 ORDER BY installed_at DESC, id DESC LIMIT 1000",
        [tenantId],
      );
      return result.rows.map(mapInstall);
    });
  }

  createReview(
    tenantId: string,
    id: string,
    listingId: string,
    installId: string,
    input: CreateReviewInput,
  ): Promise<ReviewRecord> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ReviewRow>(
        `INSERT INTO reviews (id, tenant_id, listing_id, install_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, tenantId, listingId, installId, input.rating, input.comment ?? null],
      );
      return mapReview(result.rows[0]!);
    });
  }

  listReviews(tenantId: string, listingId: string): Promise<ReviewRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ReviewRow>(
        `SELECT * FROM reviews WHERE listing_id = $1
         ORDER BY created_at DESC, id DESC`,
        [listingId],
      );
      return result.rows.map(mapReview);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapListing(row: ListingRow): ListingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    name: row.name,
    description: row.description,
    latestVersion: row.latest_version,
    licenseType: row.license_type,
    priceMinor: row.price_minor,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: ListingVersionRow): ListingVersionRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    version: row.version,
    payloadRef: row.payload_ref,
    compatibility: row.compatibility_json,
    publishedAt: row.published_at,
  };
}

function mapInstall(row: InstallRow): InstallRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    listingId: row.listing_id,
    listingVersionId: row.listing_version_id,
    installedPayloadRef: row.installed_payload_ref,
    licenseType: row.license_type,
    idempotencyKey: row.idempotency_key,
    installedAt: row.installed_at,
  };
}

function mapReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    listingId: row.listing_id,
    installId: row.install_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
  };
}
