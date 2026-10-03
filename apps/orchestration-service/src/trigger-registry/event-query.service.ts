import { EventIdSchema, TenantIdSchema } from "@alterx/contracts";

export interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: OrchestrationTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export interface EventQueryPage {
  readonly data: readonly Record<string, unknown>[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
    readonly limit: number;
  };
}

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

export class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId} was not found`);
    this.name = "EventNotFoundError";
  }
}

// events has no workflow_id or run_id column of its own -- workflow_id only
// exists on the triggers row a dispatched event's trigger_id points at, and
// run_id only exists in reverse, on whichever runs row (if any) carries
// this event as its triggering_event_id (set in the same transaction that
// inserts a dispatched event -- trigger-event-dispatch.service.ts). Both
// are LEFT JOINs: an event with no trigger_id, or one that never resulted
// in a run, correctly yields NULL for these rather than a join failure --
// matches the frontend's own workflowId?/runId? being optional.
const fromClause =
  "FROM events e " +
  "LEFT JOIN triggers t ON t.tenant_id = e.tenant_id AND t.id = e.trigger_id AND t.workspace_id = e.workspace_id " +
  "LEFT JOIN LATERAL (SELECT id FROM runs WHERE tenant_id = e.tenant_id AND triggering_event_id = e.event_id " +
  "AND workspace_id = e.workspace_id AND replayed_from IS NULL ORDER BY created_at, id LIMIT 1) r ON true";
const fields =
  "e.event_id, e.event_type, e.tenant_id, e.workspace_id, e.source, e.source_account_id, " +
  "e.trigger_id, e.trigger_version, e.occurred_at::text, e.received_at::text, e.signature_status, " +
  "t.workflow_id, r.id AS run_id";

// The events table (0004_create_events.sql) has no dispatch-outcome column
// -- only signature_status (verified/unverified/failed) and a nullable
// trigger_id/trigger_version pair. There is no way to distinguish "checked
// for a trigger and found none" from "not yet processed" (both leave
// trigger_id NULL, and nothing records a match attempt as its own state),
// so only 3 of the frontend's 5 EventStatus values are derivable here:
// failed (signature_status = 'failed'), triggered (trigger_id IS NOT NULL),
// and received (neither of those -- the honest "no outcome recorded"
// state). "matched" and "ignored" would require a real product decision
// and a schema change (e.g. a dispatch_status/match_status column) that is
// out of scope for this fix -- see the PR description.
type DerivableStatus = "received" | "triggered" | "failed";

// "failed" needs a bound parameter (the caller pushes "failed" onto values
// before calling this); "triggered"/"received" are static conditions with
// no parameter of their own.
function statusFilterClause(status: DerivableStatus, failedParamIndex: number): string {
  if (status === "failed") return `e.signature_status = $${failedParamIndex}`;
  if (status === "triggered") return `e.signature_status <> 'failed' AND e.trigger_id IS NOT NULL`;
  return `e.signature_status <> 'failed' AND e.trigger_id IS NULL`;
}

function parseStatus(value: string): DerivableStatus {
  if (value === "received" || value === "triggered" || value === "failed") return value;
  throw new EventValidationError(
    `status must be one of received, triggered, failed -- "${value}" is not derivable from the events table (see EventQueryService's own comment)`,
  );
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new EventValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function requireEventId(eventId: string): void {
  if (!EventIdSchema.safeParse(eventId).success) {
    throw new EventValidationError("eventId must be an evt_ prefixed UUIDv7");
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new EventValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

export interface EventListQuery {
  readonly workspaceId?: string;
  readonly source?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Real, read-only view over the events table -- the table itself has
 * existed and been written to since 0004_create_events.sql, but nothing
 * has ever queried it back out until now. */
export class EventQueryService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async list(tenantIdInput: string, query: EventListQuery = {}): Promise<EventQueryPage> {
    const tenantId = bareTenantUuid(tenantIdInput);
    const limit = normalizeLimit(query.limit);
    const status = query.status === undefined ? undefined : parseStatus(query.status);
    if (query.cursor !== undefined && !EventIdSchema.safeParse(query.cursor).success) {
      throw new EventValidationError("cursor is invalid");
    }

    return this.store.withTenant(tenantId, async (tx) => {
      let cursorReceivedAt: string | undefined;
      if (query.cursor !== undefined) {
        const cursor = await tx.query<{ readonly received_at: string }>(
          "SELECT received_at::text FROM events WHERE tenant_id = $1 AND event_id = $2 AND ($3::uuid IS NULL OR workspace_id = $3)",
          [tenantId, query.cursor, query.workspaceId ?? null],
        );
        cursorReceivedAt = cursor.rows[0]?.received_at;
        if (cursorReceivedAt === undefined) {
          throw new EventValidationError("cursor does not belong to this tenant's events");
        }
      }

      const conditions = ["e.tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (query.workspaceId !== undefined) {
        values.push(query.workspaceId);
        conditions.push(`e.workspace_id = $${values.length}`);
      }
      if (query.source !== undefined) {
        values.push(query.source);
        conditions.push(`e.source = $${values.length}`);
      }
      if (status === "failed") values.push("failed");
      if (status !== undefined) conditions.push(statusFilterClause(status, values.length));
      if (cursorReceivedAt !== undefined) {
        values.push(cursorReceivedAt, query.cursor);
        conditions.push(`(e.received_at, e.event_id) > ($${values.length - 1}::timestamptz, $${values.length})`);
      }
      values.push(limit + 1);

      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${fields} ${fromClause}
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.received_at ASC, e.event_id ASC LIMIT $${values.length}`,
        values,
      );
      const rows = [...result.rows];
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        page: {
          next_cursor: hasMore ? (data.at(-1)?.["event_id"] as string | undefined) ?? null : null,
          has_more: hasMore,
          limit,
        },
      };
    });
  }

  async get(tenantIdInput: string, eventId: string): Promise<Record<string, unknown>> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireEventId(eventId);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${fields}, e.payload AS payload_inline, e.payload_reference ${fromClause} WHERE e.tenant_id = $1 AND e.event_id = $2`,
        [tenantId, eventId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new EventNotFoundError(eventId);
      return row;
    });
  }
}
