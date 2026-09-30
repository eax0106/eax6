/** D3: budget kinds the engine enforces at run start. */
export type RelayedBudgetKind = "run_cap" | "workflow" | "workspace";
export type BudgetPeriod = "daily" | "monthly";
/** hard: runs do not start past the cap. warn: alerts only, runs still start. */
export type RelayedBudgetMode = "hard" | "warn";

export interface CreateBudgetInput {
  readonly kind: RelayedBudgetKind;
  readonly workflow_id?: string | undefined;
  readonly period?: BudgetPeriod | undefined;
  readonly amount_minor: number;
  readonly mode: RelayedBudgetMode;
}

export interface UpdateBudgetInput {
  readonly amount_minor?: number | undefined;
  readonly mode?: RelayedBudgetMode | undefined;
  readonly enabled?: boolean | undefined;
}

/** The engine's budget, relayed unchanged (D3: the engine owns budgets). */
export interface BudgetView {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_id: string | null;
  readonly kind: RelayedBudgetKind;
  readonly period: BudgetPeriod | null;
  readonly currency: "INR";
  readonly amount_minor: number;
  readonly mode: RelayedBudgetMode;
  readonly enabled: boolean;
  /** This period's spend; null for a per-run cap. */
  readonly spent_minor: number | null;
  readonly reserved_minor: number | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}
