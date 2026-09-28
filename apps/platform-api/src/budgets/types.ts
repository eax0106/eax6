export type BudgetCurrency = "INR" | "USD";
export type BudgetPeriod = "monthly";
export type BudgetThresholdAction = "notify" | "warn" | "block";

export interface BudgetThreshold {
  readonly percent: number;
  readonly action: BudgetThresholdAction;
}

export interface BudgetRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: BudgetCurrency;
  readonly period: BudgetPeriod;
  readonly thresholds: readonly BudgetThreshold[];
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateBudgetInput {
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: BudgetCurrency;
  readonly period: BudgetPeriod;
  readonly thresholds: readonly BudgetThreshold[];
  readonly enabled: boolean;
}

export type UpdateBudgetInput = Partial<Omit<CreateBudgetInput, "currency" | "period">>;

export interface BudgetView {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: BudgetCurrency;
  readonly period: BudgetPeriod;
  readonly thresholds: readonly BudgetThreshold[];
  readonly enabled: boolean;
  /**
   * Billable spend this period from the cost ledger, in the budget's currency;
   * null when the ledger could not be read or records another currency.
   */
  readonly currentSpendMinor: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BudgetActor {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
}
