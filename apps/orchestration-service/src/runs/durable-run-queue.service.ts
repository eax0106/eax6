import { randomUUID } from "node:crypto";

import { CompiledDagSchema, type CompiledDag } from "@alterx/contracts";
import type {
  OrchestrationTenantStore,
  OrchestrationTransactionLike,
} from "./run-launcher.service";

const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

export interface DurableRunQueueEntry {
  readonly runId: string;
  readonly priority: number;
  readonly compiledDag: CompiledDag;
  readonly alreadyRunning: boolean;
  readonly leaseToken: string;
  readonly attempt: number;
}

interface QueueRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly priority: number;
  readonly compiled_dag: unknown;
  readonly already_running: boolean;
  readonly lease_token: string;
  readonly attempts: number;
}

export class DurableRunQueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableRunQueueValidationError";
  }
}

function requireDuration(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new DurableRunQueueValidationError(
      `${name} must be an integer from 1 to ${maximum}`,
    );
  }
}

function requirePriority(priority: number): void {
  if (!Number.isInteger(priority) || priority < -1_000 || priority > 1_000) {
    throw new DurableRunQueueValidationError(
      "priority must be an integer from -1000 to 1000",
    );
  }
}

function parseClaim(row: QueueRow): DurableRunQueueEntry {
  const parsedDag = CompiledDagSchema.safeParse(row.compiled_dag);
  if (!parsedDag.success) {
    throw new DurableRunQueueValidationError(
      `queued run ${row.run_id} has an invalid compiled DAG`,
    );
  }
  return {
    runId: row.run_id,
    priority: row.priority,
    compiledDag: parsedDag.data,
    alreadyRunning: row.already_running,
    leaseToken: row.lease_token,
    attempt: row.attempts,
  };
}

/**
 * Postgres-backed run dispatch queue. Queue state lives with the run data:
 * leasing is one `FOR UPDATE SKIP LOCKED` statement, so process death cannot
 * lose work and an expired lease is claimable by a later dispatcher. This
 * class deliberately has no timer or in-memory polling loop; callers invoke
 * `claimNext` at durable work boundaries.
 */
export class DurableRunQueue {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async enqueue(
    tenantId: string,
    input: {
      readonly runId: string;
      readonly compiledDag: CompiledDag;
      readonly priority?: number;
      readonly alreadyRunning?: boolean;
    },
    transaction?: OrchestrationTransactionLike,
  ): Promise<void> {
    const priority = input.priority ?? 0;
    requirePriority(priority);
    const queueId = randomUUID();
    const insert = async (tx: OrchestrationTransactionLike) => {
      await tx.query(
        `INSERT INTO run_dispatch_queue
           (id, tenant_id, run_id, priority, compiled_dag, already_running)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id, run_id) DO NOTHING`,
        [
          queueId,
          tenantId,
          input.runId,
          priority,
          JSON.stringify(input.compiledDag),
          input.alreadyRunning ?? false,
        ],
      );
    };
    if (transaction) await insert(transaction);
    else await this.store.withTenant(tenantId, insert);
  }

  async claimNext(
    tenantId: string,
    leaseMs = DEFAULT_LEASE_MS,
  ): Promise<DurableRunQueueEntry | undefined> {
    requireDuration("leaseMs", leaseMs, MAX_LEASE_MS);
    const leaseToken = randomUUID();
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<QueueRow>(
        `WITH candidate AS (
           SELECT id
           FROM run_dispatch_queue
           WHERE tenant_id = $1
             AND available_at <= clock_timestamp()
             AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
           ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE run_dispatch_queue AS queue
         SET lease_token = $2,
             lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             attempts = queue.attempts + 1,
             updated_at = clock_timestamp()
         FROM candidate
         WHERE queue.id = candidate.id
         RETURNING queue.run_id, queue.priority, queue.compiled_dag,
                   queue.already_running, queue.lease_token, queue.attempts`,
        [tenantId, leaseToken, leaseMs],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : parseClaim(row);
    });
  }

  async acknowledge(
    tenantId: string,
    runId: string,
    leaseToken: string,
  ): Promise<boolean> {
    return this.updateLease(tenantId, runId, leaseToken, async (tx) => {
      return tx.query(
        `DELETE FROM run_dispatch_queue
         WHERE tenant_id = $1 AND run_id = $2 AND lease_token = $3`,
        [tenantId, runId, leaseToken],
      );
    });
  }

  async retryLater(
    tenantId: string,
    runId: string,
    leaseToken: string,
    delayMs: number,
  ): Promise<boolean> {
    requireDuration("delayMs", delayMs, MAX_RETRY_DELAY_MS);
    return this.updateLease(tenantId, runId, leaseToken, async (tx) => {
      return tx.query(
        `UPDATE run_dispatch_queue
         SET lease_token = NULL,
             lease_expires_at = NULL,
             available_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND run_id = $2 AND lease_token = $3`,
        [tenantId, runId, leaseToken, delayMs],
      );
    });
  }

  async discard(tenantId: string, runId: string): Promise<void> {
    await this.store.withTenant(tenantId, async (tx) => {
      await tx.query(
        "DELETE FROM run_dispatch_queue WHERE tenant_id = $1 AND run_id = $2",
        [tenantId, runId],
      );
    });
  }

  private async updateLease(
    tenantId: string,
    runId: string,
    leaseToken: string,
    operation: (
      tx: OrchestrationTransactionLike,
    ) => Promise<{ readonly rowCount: number }>,
  ): Promise<boolean> {
    const result = await this.store.withTenant(tenantId, operation);
    return result.rowCount === 1;
  }
}
