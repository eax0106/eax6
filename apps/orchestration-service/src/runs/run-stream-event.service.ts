import { randomUUID } from "node:crypto";

import { Logger } from "@nestjs/common";

import {
  RunIdSchema,
  ProjectIdSchema,
  SseEnvelopeSchema,
  TenantIdSchema,
  type SseEnvelope,
} from "@alterx/contracts";
import type { OrchestrationTenantStore } from "./node-execution-ledger.service";

function bareTenant(tenantId: string): string {
  return TenantIdSchema.parse(tenantId).slice(4);
}

function eventId(): string {
  const id = randomUUID();
  return `evt_${id.slice(0, 14)}7${id.slice(15)}`;
}

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

/**
 * Durable SSE replay journal. A per-run transaction advisory lock makes seq
 * allocation monotonic even when Executor wave nodes emit concurrently.
 */
export class RunStreamEventService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async append(
    tenantIdInput: string,
    runId: string,
    event: Omit<SseEnvelope, "seq" | "run_id" | "ts">,
  ): Promise<SseEnvelope> {
    if (!RunIdSchema.safeParse(runId).success) throw new Error("invalid run id");
    const tenantId = bareTenant(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      return this.appendWithinTransaction(tx, tenantId, runId, event);
    });
  }

  /** Keeps the state change and its stream event in the caller's transaction. */
  async appendWithinTransaction(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    runId: string,
    event: Omit<SseEnvelope, "seq" | "run_id" | "ts">,
  ): Promise<SseEnvelope> {
    if (!RunIdSchema.safeParse(runId).success) throw new Error("invalid run id");
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [runId]);
    return appendLocked(tx, tenantId, runId, event);
  }

  /** Emits the run's initial live status once, before its first node event. */
  async ensureRunRunning(tenantIdInput: string, runId: string): Promise<void> {
    if (!RunIdSchema.safeParse(runId).success) throw new Error("invalid run id");
    const tenantId = bareTenant(tenantIdInput);
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [runId]);
      const existing = await tx.query(
        "SELECT 1 FROM run_stream_events WHERE tenant_id = $1 AND run_id = $2 AND event = 'run.status' LIMIT 1",
        [tenantId, runId],
      );
      if (existing.rowCount === 0) {
        await appendLocked(tx, tenantId, runId, {
          event: "run.status",
          data: { status: "running" },
        });
      }
    });
  }

  async listAfter(tenantIdInput: string, runId: string, after = 0): Promise<StreamPage> {
    if (!RunIdSchema.safeParse(runId).success || !Number.isInteger(after) || after < 0) {
      throw new Error("invalid stream cursor");
    }
    const tenantId = bareTenant(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown> & { readonly seq: number; readonly event: string; readonly payload: unknown; readonly occurred_at: string }>(
        `SELECT seq, event, payload,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
         FROM run_stream_events WHERE tenant_id = $1 AND run_id = $2 AND seq > $3
         ORDER BY seq ASC LIMIT 256`, [tenantId, runId, after]);
      return streamPage(runId, after, result.rows);
    });
  }

  async listTerminalAfter(
    tenantIdInput: string,
    runId: string,
    after = 0,
  ): Promise<StreamPage> {
    return this.listAfterWhere(tenantIdInput, runId, after, "AND event = 'terminal.frame'");
  }

  async runIsVisible(tenantIdInput: string, runId: string): Promise<boolean> {
    if (!RunIdSchema.safeParse(runId).success) return false;
    const tenantId = bareTenant(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query(
        "SELECT id FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      return result.rowCount === 1;
    });
  }

  async projectRunIsVisible(
    tenantIdInput: string,
    projectId: string,
    runId: string,
  ): Promise<boolean> {
    if (
      !RunIdSchema.safeParse(runId).success ||
      !ProjectIdSchema.safeParse(projectId).success
    ) {
      return false;
    }
    const tenantId = bareTenant(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query(
        "SELECT id FROM runs WHERE tenant_id = $1 AND id = $2 AND project_id = $3",
        [tenantId, runId, projectId],
      );
      return result.rowCount === 1;
    });
  }

  private async listAfterWhere(
    tenantIdInput: string,
    runId: string,
    after: number,
    eventFilter: string,
  ): Promise<StreamPage> {
    if (!RunIdSchema.safeParse(runId).success || !Number.isInteger(after) || after < 0) {
      throw new Error("invalid stream cursor");
    }
    const tenantId = bareTenant(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown> & { readonly seq: number; readonly event: string; readonly payload: unknown; readonly occurred_at: string }>(
        `SELECT seq, event, payload,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
         FROM run_stream_events WHERE tenant_id = $1 AND run_id = $2 AND seq > $3 ${eventFilter}
         ORDER BY seq ASC LIMIT 256`, [tenantId, runId, after]);
      return streamPage(runId, after, result.rows);
    });
  }
}

/**
 * One page of a run's stored events. `readThrough` is the last sequence
 * number read, including any row that failed the event contract: such a
 * row is skipped with a warning instead of ending the stream, and the
 * cursor still moves past it so it is not read again on every poll.
 */
export interface StreamPage {
  readonly events: readonly SseEnvelope[];
  readonly readThrough: number;
}

const streamLogger = new Logger("RunStreamEventService");

function streamPage(
  runId: string,
  after: number,
  rows: readonly { readonly seq: number; readonly event: string; readonly payload: unknown; readonly occurred_at: string }[],
): StreamPage {
  const events: SseEnvelope[] = [];
  let readThrough = after;
  for (const row of rows) {
    readThrough = Number(row.seq);
    const parsed = SseEnvelopeSchema.safeParse({
      seq: row.seq, event: row.event, run_id: runId, ts: row.occurred_at, data: row.payload,
    });
    if (parsed.success) {
      events.push(parsed.data);
    } else {
      streamLogger.warn(`Skipped stored ${row.event} event ${row.seq} of ${runId}: it does not match the event contract`);
    }
  }
  return { events, readThrough };
}

async function appendLocked(
  tx: OrchestrationTransactionLike,
  tenantId: string,
  runId: string,
  event: Omit<SseEnvelope, "seq" | "run_id" | "ts">,
): Promise<SseEnvelope> {
  const next = await tx.query<{ readonly seq: number }>(
    "SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq FROM run_stream_events WHERE tenant_id = $1 AND run_id = $2",
    [tenantId, runId],
  );
  const envelope = SseEnvelopeSchema.parse({
    ...event,
    seq: next.rows[0]?.seq ?? 1,
    run_id: runId,
    ts: new Date().toISOString(),
  });
  await tx.query(
    `INSERT INTO run_stream_events (id, tenant_id, run_id, seq, event, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    [
      eventId(),
      tenantId,
      runId,
      envelope.seq,
      envelope.event,
      JSON.stringify(envelope.data),
      envelope.ts,
    ],
  );
  return envelope;
}
