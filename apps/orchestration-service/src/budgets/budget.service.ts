import { randomBytes } from "node:crypto";

import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";

import type {
  OrchestrationTenantStore,
  OrchestrationTransactionLike,
} from "../runs/run-observability.service";

export type BudgetKind = "run_cap" | "workflow" | "workspace";
export type BudgetPeriod = "daily" | "monthly";
export type BudgetMode = "hard" | "warn";

export type BudgetRow = {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_id: string | null;
  readonly kind: BudgetKind;
  readonly period: BudgetPeriod | null;
  readonly amount_minor: string;
  readonly mode: BudgetMode;
  readonly enabled: boolean;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export interface CreateBudgetInput {
  readonly workspaceId: string;
  readonly workflowId?: string;
  readonly kind: BudgetKind;
  readonly period?: BudgetPeriod;
  readonly amountMinor: number;
  readonly mode?: BudgetMode;
  readonly createdBy: string;
}

export interface BudgetPatch {
  readonly amountMinor?: number;
  readonly mode?: BudgetMode;
  readonly enabled?: boolean;
}

export interface Reservation {
  readonly budgetId: string;
  readonly kind: BudgetKind;
  readonly mode: BudgetMode;
  /** True when a warn-only budget was passed although the run goes over it. */
  readonly overCap: boolean;
}

export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

export class BudgetNotFoundError extends Error {
  constructor(id: string) {
    super(`Budget ${id} was not found`);
    this.name = "BudgetNotFoundError";
  }
}

export class BudgetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetConflictError";
  }
}

/** A hard budget would be exceeded: the run does not start. */
export class BudgetExceededError extends Error {
  constructor(
    readonly budgetId: string,
    readonly kind: BudgetKind,
    readonly capMinor: string,
    readonly usedMinor: string,
    readonly neededMinor: string,
  ) {
    super(`Budget ${budgetId} (${kind}) would be exceeded: needs ${neededMinor}, ${usedMinor} of ${capMinor} used`);
    this.name = "BudgetExceededError";
  }
}

const BUDGET_COLUMNS = `id, workspace_id::text, workflow_id, kind, period, amount_minor::text,
  mode, enabled, created_by, created_at::text, updated_at::text`;

/**
 * Engine-owned budgets (D3). Reservation is atomic: a run reserves its
 * worst-case cost against every budget that applies, inside the transaction
 * that creates the run. The conditional UPDATE takes the usage row's lock, so
 * two runs starting together cannot both pass a cap (the second re-checks the
 * row the first changed).
 *
 * Periods are calendar days and months in India time, the customers' clock.
 */
export class BudgetService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async create(tenantIdInput: string, input: CreateBudgetInput): Promise<BudgetRow> {
    const tenantId = bareTenant(tenantIdInput);
    const workspaceId = bareWorkspace(input.workspaceId);
    requireAmount(input.amountMinor);
    if (input.kind === "run_cap" && input.period !== undefined) {
      throw new BudgetValidationError("a per-run cap has no period");
    }
    if (input.kind === "workflow" && (input.workflowId === undefined || input.period === undefined)) {
      throw new BudgetValidationError("a workflow budget needs a workflow and a period");
    }
    if (input.kind === "run_cap" && input.workflowId === undefined) {
      throw new BudgetValidationError("a per-run cap belongs to a workflow");
    }
    if (input.kind === "workspace" && (input.workflowId !== undefined || (input.period ?? "monthly") !== "monthly")) {
      throw new BudgetValidationError("a workspace budget is monthly and has no workflow");
    }
    const period = input.kind === "workspace" ? "monthly" : (input.period ?? null);
    return this.store.withTenant(tenantId, async (tx) => {
      try {
        const result = await tx.query<BudgetRow>(
          `INSERT INTO budgets (id, tenant_id, workspace_id, workflow_id, kind, period, amount_minor, mode, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${BUDGET_COLUMNS}`,
          [newBudgetId(), tenantId, workspaceId, input.workflowId ?? null, input.kind, period, input.amountMinor, input.mode ?? "hard", input.createdBy],
        );
        return result.rows[0]!;
      } catch (error: unknown) {
        throw mapWriteError(error);
      }
    });
  }

  list(tenantIdInput: string, workspaceIdInput: string): Promise<readonly BudgetRow[]> {
    const tenantId = bareTenant(tenantIdInput);
    const workspaceId = bareWorkspace(workspaceIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY created_at, id`,
        [tenantId, workspaceId],
      );
      return result.rows;
    });
  }

  update(tenantIdInput: string, workspaceIdInput: string, id: string, patch: BudgetPatch): Promise<BudgetRow> {
    const tenantId = bareTenant(tenantIdInput);
    const workspaceId = bareWorkspace(workspaceIdInput);
    if (patch.amountMinor !== undefined) requireAmount(patch.amountMinor);
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<BudgetRow>(
        `UPDATE budgets
            SET amount_minor = COALESCE($4::bigint, amount_minor),
                mode = COALESCE($5, mode),
                enabled = COALESCE($6::boolean, enabled),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3
          RETURNING ${BUDGET_COLUMNS}`,
        [tenantId, workspaceId, id, patch.amountMinor ?? null, patch.mode ?? null, patch.enabled ?? null],
      );
      if (result.rowCount === 0) throw new BudgetNotFoundError(id);
      return result.rows[0]!;
    });
  }

  delete(tenantIdInput: string, workspaceIdInput: string, id: string): Promise<void> {
    const tenantId = bareTenant(tenantIdInput);
    const workspaceId = bareWorkspace(workspaceIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      await tx.query("DELETE FROM budgets WHERE tenant_id = $1 AND workspace_id = $2 AND id = $3", [tenantId, workspaceId, id]);
    });
  }

  /**
   * Reserve `amountMinor` (the run's worst case) against every enabled budget
   * of the workspace and workflow. Call inside the transaction that creates
   * the run, so a refusal rolls the run back with it.
   */
  async reserve(
    tx: OrchestrationTransactionLike,
    input: { tenantId: string; workspaceId: string; workflowId: string; runId: string; amountMinor: number },
  ): Promise<readonly Reservation[]> {
    requireAmount(input.amountMinor);
    const budgets = await tx.query<{ id: string; kind: BudgetKind; period: BudgetPeriod | null; mode: BudgetMode; amount_minor: string }>(
      `SELECT id, kind, period, mode, amount_minor::text
         FROM budgets
        WHERE tenant_id = $1 AND workspace_id = $2 AND enabled
          AND (kind = 'workspace' OR workflow_id = $3)
        ORDER BY id`,
      [input.tenantId, input.workspaceId, input.workflowId],
    );
    const reservations: Reservation[] = [];
    for (const budget of budgets.rows) {
      if (budget.kind === "run_cap") {
        const over = BigInt(input.amountMinor) > BigInt(budget.amount_minor);
        if (over && budget.mode === "hard") {
          throw new BudgetExceededError(budget.id, budget.kind, budget.amount_minor, "0", String(input.amountMinor));
        }
        reservations.push({ budgetId: budget.id, kind: budget.kind, mode: budget.mode, overCap: over });
        continue;
      }
      const periodKey = await this.periodKey(tx, budget.period!);
      await tx.query(
        `INSERT INTO budget_usage (tenant_id, budget_id, period_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [input.tenantId, budget.id, periodKey],
      );
      const updated = await tx.query<{ over: boolean }>(
        `UPDATE budget_usage u
            SET reserved_minor = u.reserved_minor + $4::bigint
           FROM budgets b
          WHERE u.tenant_id = $1 AND u.budget_id = $2 AND u.period_key = $3
            AND b.tenant_id = u.tenant_id AND b.id = u.budget_id
            AND (b.mode = 'warn' OR u.spent_minor + u.reserved_minor + $4::bigint <= b.amount_minor)
        RETURNING (u.spent_minor + u.reserved_minor > b.amount_minor) AS over`,
        [input.tenantId, budget.id, periodKey, input.amountMinor],
      );
      if (updated.rowCount === 0) {
        const usage = await tx.query<{ used: string }>(
          "SELECT (spent_minor + reserved_minor)::text AS used FROM budget_usage WHERE tenant_id = $1 AND budget_id = $2 AND period_key = $3",
          [input.tenantId, budget.id, periodKey],
        );
        throw new BudgetExceededError(budget.id, budget.kind, budget.amount_minor, usage.rows[0]?.used ?? "0", String(input.amountMinor));
      }
      await tx.query(
        `INSERT INTO budget_reservations (tenant_id, run_id, budget_id, period_key, reserved_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.tenantId, input.runId, budget.id, periodKey, input.amountMinor],
      );
      reservations.push({ budgetId: budget.id, kind: budget.kind, mode: budget.mode, overCap: updated.rows[0]!.over });
    }
    return reservations;
  }

  /**
   * The run has ended: release what it reserved and record what it really
   * cost. Once per run and budget; a second call changes nothing.
   */
  settle(tenantIdInput: string, runId: string, actualMinor: number): Promise<number> {
    const tenantId = bareTenant(tenantIdInput);
    if (!Number.isSafeInteger(actualMinor) || actualMinor < 0) {
      throw new BudgetValidationError("actual cost must be a whole number of paise, zero or more");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const claimed = await tx.query<{ budget_id: string; period_key: string; reserved_minor: string }>(
        `UPDATE budget_reservations
            SET state = 'settled', settled_minor = $3
          WHERE tenant_id = $1 AND run_id = $2 AND state = 'reserved'
          RETURNING budget_id, period_key, reserved_minor::text`,
        [tenantId, runId, actualMinor],
      );
      for (const row of claimed.rows) {
        await tx.query(
          `UPDATE budget_usage
              SET reserved_minor = GREATEST(reserved_minor - $4::bigint, 0),
                  spent_minor = spent_minor + $5::bigint
            WHERE tenant_id = $1 AND budget_id = $2 AND period_key = $3`,
          [tenantId, row.budget_id, row.period_key, row.reserved_minor, actualMinor],
        );
      }
      return claimed.rowCount;
    });
  }

  private async periodKey(tx: OrchestrationTransactionLike, period: BudgetPeriod): Promise<string> {
    const format = period === "daily" ? "YYYY-MM-DD" : "YYYY-MM";
    const result = await tx.query<{ key: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Kolkata', '${format}') AS key`,
    );
    return result.rows[0]!.key;
  }
}

function requireAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BudgetValidationError("amount must be a positive whole number of paise");
  }
}

function bareTenant(value: string): string {
  const parsed = TenantIdSchema.safeParse(value);
  if (!parsed.success) throw new BudgetValidationError("tenant must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function bareWorkspace(value: string): string {
  const parsed = WorkspaceIdSchema.safeParse(value.startsWith("ws_") ? value : `ws_${value}`);
  if (!parsed.success) throw new BudgetValidationError("workspace must be a ws_ prefixed UUIDv7");
  return parsed.data.slice("ws_".length);
}

function newBudgetId(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x70;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `bud_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapWriteError(error: unknown): Error {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const constraint = typeof error === "object" && error !== null ? String(Reflect.get(error, "constraint") ?? "") : "";
  if (code === "23505" && constraint === "budgets_one_per_scope") {
    return new BudgetConflictError("a budget of this kind already exists for this scope");
  }
  if (code === "23503") return new BudgetValidationError("the workflow does not exist");
  return error instanceof Error ? error : new Error(String(error));
}
