import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { KycDocumentRef } from "@alterx/shared-clients";
import type { Pool } from "pg";

export interface PendingVerification {
  readonly id: string;
  readonly tenant_id: string;
  readonly publisher_id: string;
  readonly documents: readonly KycDocumentRef[];
  readonly submitted_at: string;
}

interface PendingRow {
  id: string;
  tenant_id: string;
  publisher_id: string;
  documents_json: readonly KycDocumentRef[];
  submitted_at: Date;
}

export class AdminPublisherUnavailableError extends Error {
  constructor() {
    super("Publisher verification review requires OPERATIONS_MARKETPLACE_DATABASE_URL");
  }
}

/**
 * Staff plane, cross-tenant by design (task B2.4): the queue of seller
 * verifications awaiting review, read through the Operations pool
 * (OPERATIONS_MARKETPLACE_DATABASE_URL, the platform_operations role), because
 * kyc_submissions is tenant-RLS. Deciding one goes through the tenant-scoped
 * PublisherRepository with that submission's tenant.
 */
@Injectable()
export class AdminPublisherRepository implements OnModuleDestroy {
  constructor(
    private readonly pool: Pool | undefined,
    private readonly closePoolOnDestroy = false,
  ) {}

  async listPending(): Promise<PendingVerification[]> {
    if (!this.pool) throw new AdminPublisherUnavailableError();
    const result = await this.pool.query<PendingRow>(
      `SELECT id, tenant_id, publisher_id, documents_json, submitted_at
         FROM kyc_submissions
        WHERE status = 'pending_review'
        ORDER BY submitted_at ASC, id ASC
        LIMIT 500`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      publisher_id: row.publisher_id,
      documents: row.documents_json,
      submitted_at: row.submitted_at.toISOString(),
    }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy && this.pool) await this.pool.end();
  }
}
