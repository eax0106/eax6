import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { KycDocumentRef, KycSubmission } from "@alterx/shared-clients";
import type { Pool, PoolClient } from "pg";
import type { EarningsSummary, PayoutRecord, PublisherRecord, PublisherVerificationStatus } from "./types";
import { PublisherHttpError } from "./publisher.problem";

interface PublisherRow { id: string; tenant_id: string; verification_status: PublisherVerificationStatus; created_at: Date }
interface KycRow { id: string; tenant_id: string; documents_json: readonly KycDocumentRef[]; status: KycSubmission["status"]; rejection_reason: string | null; submitted_at: Date; reviewed_at: Date | null }
interface PayoutRow { id: string; order_id: string; total_minor: string; seller_share_minor: string; platform_share_minor: string; status: PayoutRecord["status"]; created_at: Date }

@Injectable()
export class PublisherRepository implements OnModuleDestroy {
  constructor(private readonly pool: Pool, private readonly closePoolOnDestroy = false) {}

  getPublisher(tenantId: string): Promise<PublisherRecord | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<PublisherRow>("SELECT * FROM publishers WHERE tenant_id = $1", [tenantId]);
      return result.rows[0] ? publisher(result.rows[0]) : undefined;
    });
  }

  createSubmission(tenantId: string, publisherId: string, submissionId: string, documents: readonly KycDocumentRef[]): Promise<KycSubmission> {
    return this.withTenant(tenantId, async (client) => {
      const publisherRow = await client.query<PublisherRow>(
        `INSERT INTO publishers (id, tenant_id, verification_status) VALUES ($1, $2, 'unverified')
         ON CONFLICT (tenant_id) DO UPDATE SET verification_status = publishers.verification_status RETURNING *`, [publisherId, tenantId],
      );
      const publisherIdValue = publisherRow.rows[0]!.id;
      await client.query(`UPDATE publishers SET verification_status = 'pending_review' WHERE id = $1`, [publisherIdValue]);
      const result = await client.query<KycRow>(
        `INSERT INTO kyc_submissions (id, tenant_id, publisher_id, documents_json, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending_review') RETURNING *`,
        [submissionId, tenantId, publisherIdValue, JSON.stringify(documents)],
      );
      return submission(result.rows[0]!);
    });
  }

  latestSubmission(tenantId: string): Promise<KycSubmission | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<KycRow>("SELECT * FROM kyc_submissions WHERE tenant_id = $1 ORDER BY submitted_at DESC, id DESC LIMIT 1", [tenantId]);
      return result.rows[0] ? submission(result.rows[0]) : null;
    });
  }

  reviewSubmission(tenantId: string, submissionId: string, reviewerId: string, status: "approved" | "rejected", reason: string | null): Promise<KycSubmission | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<KycRow>(
        `UPDATE kyc_submissions SET status = $3, rejection_reason = $4, reviewed_by = $5, reviewed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending_review' RETURNING *`, [tenantId, submissionId, status, reason, reviewerId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      await client.query("UPDATE publishers SET verification_status = $2 WHERE tenant_id = $1", [tenantId, status === "approved" ? "verified" : "rejected"]);
      return submission(row);
    });
  }

  submitFreeListing(tenantId: string, listingId: string): Promise<string> {
    return this.withTenant(tenantId, async client => {
      const instance = `/api/v1/publisher/listings/${listingId}/actions/submit`;
      const { rows } = await client.query<{ status: string; price_minor: string }>(
        "SELECT status, price_minor FROM listings WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, listingId]);
      const listing = rows[0];
      if (!listing) throw new PublisherHttpError(404, "PUBLISHER_LISTING_NOT_FOUND", "Publisher listing was not found.", instance);
      if (listing.price_minor !== "0") throw new PublisherHttpError(409, "PUBLISHER_FREE_ONLY", "Only free listings can be submitted in v1.", instance);
      if (!["draft", "private_testing"].includes(listing.status)) throw new PublisherHttpError(409, "PUBLISHER_INVALID_PIPELINE_TRANSITION", `Cannot transition listing from ${listing.status} to submitted.`, instance);
      await client.query("UPDATE listings SET status = 'submitted', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2", [tenantId, listingId]);
      return "submitted";
    });
  }

  transitionListing(tenantId: string, listingId: string, status: string): Promise<string | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ status: string }>(
        "UPDATE listings SET status = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 RETURNING status", [tenantId, listingId, status],
      );
      return result.rows[0]?.status;
    });
  }

  listingStatus(tenantId: string, listingId: string): Promise<string | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ status: string }>("SELECT status FROM listings WHERE tenant_id = $1 AND id = $2", [tenantId, listingId]);
      return result.rows[0]?.status;
    });
  }

  // ENGINE-FIX-B8-2: was unbounded (no LIMIT) -- grows without bound over a
  // tenant's lifetime. platform-web's payouts page reads this as a bare
  // array with no pagination UI, so a cursor-paginated envelope would break
  // that caller for no benefit a real seller payout history needs; a
  // generous cap is a real safety net (no seller realistically has more
  // payouts than this), not a functional pagination story.
  listPayouts(tenantId: string): Promise<PayoutRecord[]> {
    return this.withTenant(tenantId, async (client) => (await client.query<PayoutRow>("SELECT * FROM payouts WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1000", [tenantId])).rows.map(payout));
  }

  earnings(tenantId: string): Promise<EarningsSummary> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ available_minor: string; pending_minor: string; paid_minor: string }>(
        `SELECT COALESCE(SUM(seller_share_minor) FILTER (WHERE status = 'created'), 0)::text AS available_minor,
                COALESCE(SUM(seller_share_minor) FILTER (WHERE status = 'pending'), 0)::text AS pending_minor,
                COALESCE(SUM(seller_share_minor) FILTER (WHERE status = 'processed'), 0)::text AS paid_minor
         FROM payouts WHERE tenant_id = $1`, [tenantId],
      );
      const row = result.rows[0]!;
      return { availableMinor: row.available_minor, pendingMinor: row.pending_minor, paidMinor: row.paid_minor, currency: "INR" };
    });
  }

  async onModuleDestroy(): Promise<void> { if (this.closePoolOnDestroy) await this.pool.end(); }

  private async withTenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}

function publisher(row: PublisherRow): PublisherRecord { return { id: row.id, tenantId: row.tenant_id, verificationStatus: row.verification_status, createdAt: row.created_at }; }
function submission(row: KycRow): KycSubmission { return { id: row.id, tenantId: row.tenant_id, documents: row.documents_json, status: row.status, rejectionReason: row.rejection_reason, submittedAt: row.submitted_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null }; }
function payout(row: PayoutRow): PayoutRecord { return { id: row.id, orderId: row.order_id, totalMinor: row.total_minor, sellerShareMinor: row.seller_share_minor, platformShareMinor: row.platform_share_minor, status: row.status, createdAt: row.created_at }; }
