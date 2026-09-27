import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { AdminIncident, CreateIncidentRequest } from "@alterx/contracts";
import type { Pool } from "pg";

interface IncidentRow {
  id: string;
  title: string;
  summary: string;
  severity: AdminIncident["severity"];
  impacted_services: string[];
  status: AdminIncident["status"];
  publication_state: AdminIncident["publication_state"];
  created_by: string;
  created_at: Date;
  publication_requested_by: string | null;
  publication_requested_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  provider_incident_ref: string | null;
  published_at: Date | null;
}

const columns = `id, title, summary, severity, impacted_services, status,
  publication_state, created_by, created_at, publication_requested_by,
  publication_requested_at, approved_by, approved_at, provider_incident_ref,
  published_at`;

@Injectable()
export class IncidentRepository implements OnModuleDestroy {
  constructor(private readonly pool: Pool, private readonly closePoolOnDestroy = false) {}

  async create(id: string, staffUserId: string, input: CreateIncidentRequest): Promise<AdminIncident> {
    const result = await this.pool.query<IncidentRow>(
      `INSERT INTO admin_incidents
       (id, title, summary, severity, impacted_services, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${columns}`,
      [id, input.title, input.summary, input.severity, input.impacted_services, staffUserId],
    );
    return mapRow(result.rows[0]!);
  }

  async list(): Promise<AdminIncident[]> {
    const result = await this.pool.query<IncidentRow>(
      `SELECT ${columns} FROM admin_incidents ORDER BY created_at DESC, id DESC`,
    );
    return result.rows.map(mapRow);
  }

  async find(id: string): Promise<AdminIncident | undefined> {
    const result = await this.pool.query<IncidentRow>(
      `SELECT ${columns} FROM admin_incidents WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async requestPublication(
    id: string,
    staffUserId: string,
    reason: string,
  ): Promise<AdminIncident | undefined> {
    const result = await this.pool.query<IncidentRow>(
      `UPDATE admin_incidents
       SET status = 'investigating', publication_state = 'pending_approval',
           publication_requested_by = $2, publication_requested_at = clock_timestamp(),
           publication_request_reason = $3, approved_by = NULL, approved_at = NULL,
           approval_reason = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND publication_state IN ('not_requested', 'rejected')
       RETURNING ${columns}`,
      [id, staffUserId, reason],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async approve(
    id: string,
    staffUserId: string,
    reason: string,
  ): Promise<AdminIncident | undefined> {
    const result = await this.pool.query<IncidentRow>(
      `UPDATE admin_incidents
       SET publication_state = 'approved', approved_by = $2,
           approved_at = clock_timestamp(), approval_reason = $3,
           updated_at = clock_timestamp()
       WHERE id = $1 AND publication_state = 'pending_approval'
         AND publication_requested_by <> $2 AND created_by <> $2
       RETURNING ${columns}`,
      [id, staffUserId, reason],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /** Moves status only if it is still `from`, so concurrent staff edits cannot overwrite each other. */
  async setStatus(
    id: string,
    from: AdminIncident["status"],
    to: AdminIncident["status"],
  ): Promise<AdminIncident | undefined> {
    const result = await this.pool.query<IncidentRow>(
      `UPDATE admin_incidents SET status = $3, updated_at = clock_timestamp()
       WHERE id = $1 AND status = $2
       RETURNING ${columns}`,
      [id, from, to],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async claimPublishing(id: string): Promise<AdminIncident | undefined> {
    const result = await this.pool.query<IncidentRow>(
      `UPDATE admin_incidents
       SET publication_state = 'publishing', updated_at = clock_timestamp()
       WHERE id = $1 AND publication_state = 'approved'
       RETURNING ${columns}`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async completePublication(
    id: string,
    providerIncidentRef: string,
    publishedAt: string,
  ): Promise<AdminIncident> {
    const result = await this.pool.query<IncidentRow>(
      `UPDATE admin_incidents
       SET publication_state = 'published', provider_incident_ref = $2,
           published_at = $3::timestamptz, updated_at = clock_timestamp()
       WHERE id = $1 AND publication_state = 'publishing'
       RETURNING ${columns}`,
      [id, providerIncidentRef, publishedAt],
    );
    return mapRow(result.rows[0]!);
  }

  async releasePublishing(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE admin_incidents SET publication_state = 'approved', updated_at = clock_timestamp()
       WHERE id = $1 AND publication_state = 'publishing'`,
      [id],
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }
}

function mapRow(row: IncidentRow): AdminIncident {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    impacted_services: row.impacted_services,
    status: row.status,
    publication_state: row.publication_state,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    publication_requested_by: row.publication_requested_by,
    publication_requested_at: row.publication_requested_at?.toISOString() ?? null,
    approved_by: row.approved_by,
    approved_at: row.approved_at?.toISOString() ?? null,
    provider_incident_ref: row.provider_incident_ref,
    published_at: row.published_at?.toISOString() ?? null,
  };
}
