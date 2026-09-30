/**
 * D24: what a tenant sees of cost is what it pays -- the billed price, Alter's
 * margin included. Alter's internal cost, retry and recovery cost and margin
 * never appear in a tenant response; the full breakdown is staff-only
 * (`StaffCostSummary`).
 */
export interface CostSummary {
  readonly startAt: string;
  readonly endAt: string;
  readonly currency: "INR" | "USD";
  readonly dimensions: readonly string[];
  readonly groups: readonly CostSummaryGroup[];
  readonly totals: CostSummaryTotals;
}

export interface CostSummaryGroup {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly billableMinor: string;
  readonly eventCount: number;
}

export interface CostSummaryTotals {
  readonly billableMinor: string;
}

/** What one workflow's runs cost the tenant over a window (D24). */
export interface WorkflowCost {
  readonly workflowId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly currency: "INR";
  readonly billableMinor: string;
  readonly runCount: number;
}

/** Staff only: the ledger's full breakdown for one tenant workspace. */
export interface StaffCostSummary {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly currency: "INR" | "USD";
  readonly dimensions: readonly string[];
  readonly groups: readonly StaffCostSummaryGroup[];
  readonly totals: {
    readonly internalCostMinor: string;
    readonly billableMinor: string;
    readonly marginMinor: string;
  };
}

export interface StaffCostSummaryGroup {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly internalCostMinor: string;
  readonly retryCostMinor: string;
  readonly recoveryCostMinor: string;
  readonly billableMinor: string;
  readonly marginMinor: string;
  readonly eventCount: number;
}
