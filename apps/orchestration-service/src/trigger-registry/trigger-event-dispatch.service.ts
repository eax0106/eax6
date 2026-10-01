import { isWorkspaceHeld } from "../workspace-holds/workspace-holds.service";
import { randomUUID } from "node:crypto";

import {
  CompiledDagSchema,
  TenantIdSchema,
  TriggerIdSchema,
  WorkspaceIdSchema,
  type RunsCreateRunRequest,
  type RunsCreateRunResponse,
} from "@alterx/contracts";
import type { RunDispatchHandler } from "@alterx/adapters";
import type { OrchestrationTenantStore } from "../runs/run-launcher.service";
import type { RunBudgetGate } from "../budgets/run-budget-gate";
import { RunLauncherService, type RunRow } from "../runs/run-launcher.service";

export class TriggerEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerEventValidationError";
  }
}

export class TriggerEventNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerEventNotFoundError";
  }
}

interface DispatchLookupRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly status: string;
  readonly workflow_id: string;
  readonly active_version: number | null;
  readonly wfv_id: string | null;
  readonly compiled_dag: unknown;
}

/**
 * INGR-7: the orchestration side of the dispatch pipeline. The
 * background-workers canonical-events consumer calls this over gRPC
 * (RunDispatchService.CreateRun); this service turns the carried
 * TriggerDispatchDetail into a durable `events` row plus a `runs` row
 * bound to the trigger's ACTIVE version.
 *
 * SEMANTICS:
 *  - The `events` row records the carried trigger_version -- a truthful
 *    record of what fired, even if the trigger has since moved to a newer
 *    version (the FK only requires the version row to exist).
 *  - The `runs` row resolves the trigger's active version at dispatch
 *    time; the run always targets current truth.
 *  - Terminal no-ops -- trigger missing or disabled, no active version,
 *    active version not bound to a workflow version, or an idempotency_key
 *    already handled -- return { run_id: "", event_inserted: false } with
 *    no error, so the consumer drops the message instead of redelivering.
 *  - Duplicate idempotency after a partially-committed attempt leaves the
 *    first events row authoritative; the run linked to it is not
 *    re-created.
 */
export class TriggerEventDispatchService implements RunDispatchHandler {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly launcher: RunLauncherService,
    private readonly budgetGate?: RunBudgetGate,
  ) {}

  async createRun(request: RunsCreateRunRequest): Promise<RunsCreateRunResponse> {
    const tenantIdInput = parsePrefixed(request.tenant_id, TenantIdSchema, "tenant_id");
    const workspaceIdInput = parsePrefixed(
      request.workspace_id,
      WorkspaceIdSchema,
      "workspace_id",
    );
    const triggerId = parsePrefixed(request.trigger_id, TriggerIdSchema, "trigger_id");
    if (!Number.isInteger(request.trigger_version) || request.trigger_version < 1) {
      throw new TriggerEventValidationError(
        "trigger_version must be a positive integer",
      );
    }
    requireNonEmpty("event_type", request.event_type);
    requireNonEmpty("schema_version", request.schema_version);
    requireNonEmpty("source", request.source);
    requireNonEmpty("idempotency_key", request.idempotency_key);

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(request.payload_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new TriggerEventValidationError(
        "payload_json must be a JSON object",
      );
    }

    const tenantId = tenantIdInput.slice("ten_".length);

    const dispatch = await this.store.withTenant(tenantId, async (tx) => {
      const lookup = await tx.query<DispatchLookupRow>(
        `SELECT t.workspace_id, t.status, t.workflow_id,
                tv.version AS active_version, tv.workflow_version_id AS wfv_id,
                wv.compiled_dag
         FROM triggers t
         LEFT JOIN trigger_versions tv
           ON tv.tenant_id = t.tenant_id AND tv.trigger_id = t.id
          AND tv.status = 'active'
         LEFT JOIN workflow_versions wv
           ON wv.tenant_id = t.tenant_id AND wv.id = tv.workflow_version_id
         WHERE t.tenant_id = $1 AND t.id = $2
         ORDER BY tv.version DESC LIMIT 1`,
        [tenantId, triggerId],
      );
      const row = lookup.rows[0];
      if (row === undefined) {
        return { kind: "noop" as const, reason: "missing" as const };
      }
      if (row.status !== "enabled") {
        return { kind: "noop" as const, reason: "not-enabled" as const };
      }
      if (row.active_version === null || row.wfv_id === null) {
        return { kind: "noop" as const, reason: "no-active-version" as const };
      }
      if (row.workspace_id !== workspaceIdInput.slice("ws_".length)) {
        throw new TriggerEventValidationError(
          "trigger does not belong to the carried workspace",
        );
      }
      // D2: a workspace pending deletion starts no run until it is restored.
      if (await isWorkspaceHeld(tx, tenantId, row.workspace_id)) {
        return { kind: "noop" as const, reason: "workspace-held" as const };
      }

      const parsedDag = CompiledDagSchema.safeParse(row.compiled_dag);
      if (!parsedDag.success) {
        throw new TriggerEventValidationError(
          "trigger's active workflow version has an invalid compiled DAG",
        );
      }

      const eventId = `evt_${mintV7Id()}`;
      const inserted = await tx.query<{ readonly event_id: string }>(
        `INSERT INTO events
           (event_id, event_type, schema_version, tenant_id, workspace_id, source,
            idempotency_key, occurred_at, trigger_id, trigger_version, payload,
            signature_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), $8, $9, $10::jsonb,
                 'verified')
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING event_id`,
        [
          eventId,
          request.event_type,
          request.schema_version,
          tenantId,
          row.workspace_id,
          request.source,
          request.idempotency_key,
          triggerId,
          request.trigger_version,
          JSON.stringify(payload),
        ],
      );
      if (inserted.rowCount !== 1) {
        return { kind: "noop" as const, reason: "duplicate" as const };
      }

      const runRow = await this.insertRunRow(
        tx,
        tenantId,
        row,
        eventId,
      );
      // D3: over budget refuses the run, and the event rolls back with it so a
      // redelivery can start it once the budget allows.
      await this.budgetGate?.reserve(tx, {
        tenantId,
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        runId: runRow.id,
        compiledDag: parsedDag.data,
      });
      return {
        kind: "dispatch" as const,
        eventId,
        runRow,
        compiledDag: parsedDag.data,
      };
    });

    if (dispatch.kind !== "dispatch") {
      return { run_id: "", event_inserted: false };
    }

    await this.launcher.startAndTransition(
      tenantId,
      dispatch.runRow,
      dispatch.compiledDag,
    );

    return {
      run_id: dispatch.runRow.id,
      event_inserted: true,
    };
  }

  private async insertRunRow(
    tx: {
      query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        statement: string,
        values?: readonly unknown[],
      ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
    },
    tenantId: string,
    row: DispatchLookupRow,
    eventId: string,
  ): Promise<RunRow> {
    const runId = `run_${mintV7Id()}`;
    const inserted = await tx.query<RunRow>(
      `INSERT INTO runs
         (id, tenant_id, workspace_id, parent_kind, workflow_id,
          workflow_version_id, status, triggering_event_id)
       VALUES ($1, $2, $3, 'workflow', $4, $5, 'pending', $6)
       RETURNING id, workflow_id, project_id, workflow_version_id,
                 provisioning_session_id, provisioning_cycle_id,
                 provisioning_template_id, provisioning_closed_at::text,
                 parent_kind, status, started_at::text, ended_at::text,
                 created_at::text, triggering_event_id`,
      [runId, tenantId, row.workspace_id, row.workflow_id, row.wfv_id, eventId],
    );
    if (inserted.rowCount !== 1) {
      throw new TriggerEventNotFoundError(
        `run row for event ${eventId} could not be created`,
      );
    }
    return inserted.rows[0]!;
  }
}

function parsePrefixed(
  value: string,
  schema: { readonly safeParse: (input: unknown) => { readonly success: boolean } },
  field: string,
): string {
  if (!schema.safeParse(value).success) {
    throw new TriggerEventValidationError(`invalid ${field}`);
  }
  return value;
}

// Takes unknown, not string: proto3 has no way to distinguish an unset
// string field from an empty one, and the gRPC loader delivers an omitted
// field as undefined rather than as "". Calling .trim() on it raised a
// TypeError before this function could raise its own validation error, so
// every caller who omitted a field was told the request failed internally
// instead of which field was missing.
function requireNonEmpty(field: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TriggerEventValidationError(`${field} is required`);
  }
}

/** UUIDv7-forced suffix, matching the run/event id conventions elsewhere. */
function mintV7Id(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}