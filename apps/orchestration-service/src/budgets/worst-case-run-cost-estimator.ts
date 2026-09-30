import type { CompiledDag, ModelAlias } from "@alterx/contracts";

import type { RunCostEstimator } from "./run-budget-gate";
import { modelCallsOf } from "./model-calls";

/** Bedrock is every alias's primary provider, under the name the price table uses. */
export const PRIMARY_PRICING_PROVIDER = "aws-bedrock";

export interface PricedModel {
  readonly provider: string;
  readonly modelId: string;
}

/** What the gateway's model policy says about an alias and a tenant. */
export interface ModelPolicyReader {
  /** The alias's own model first, then its fallbacks. */
  modelsFor(alias: ModelAlias): Promise<readonly PricedModel[]>;
  /** The gateway's per-call token cap for this tenant. */
  maxTokensPerCall(tenantId: string): Promise<number>;
}

export interface ModelCallLine {
  readonly models: readonly PricedModel[];
  readonly maxTokens: string;
}

/** The Cost Ledger's pricing of a worst case, and its average of past runs. */
export interface RunEstimatesLedger {
  worstCase(input: { readonly tenantId: string; readonly lines: readonly ModelCallLine[] }): Promise<{
    readonly billableMinor: number;
    readonly unpricedLines: number;
  }>;
  runsAverage(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly runIds: readonly string[];
  }): Promise<{ readonly averageBillableMinor: number | null; readonly runCount: number }>;
}

export interface WorstCaseEstimate {
  readonly billableMinor: number;
  readonly modelCalls: number;
  /** Calls the ledger has no price for; the bound is too low by their share. */
  readonly unpricedCalls: number;
}

/**
 * D4: the most a run could cost, worked out before it starts. Each model call
 * is bounded by the gateway's per-call token cap at the dearest price among
 * the models that could serve it. Retries, recovery and model escalation are
 * not counted; the true-up at the run's end records what it really cost.
 */
export class WorstCaseRunCostEstimator implements RunCostEstimator {
  constructor(
    private readonly policy: ModelPolicyReader,
    private readonly ledger: RunEstimatesLedger,
  ) {}

  async estimate(input: { readonly tenantId: string; readonly compiledDag: CompiledDag }): Promise<WorstCaseEstimate> {
    const calls = modelCallsOf(input.compiledDag);
    if (calls.length === 0) return { billableMinor: 0, modelCalls: 0, unpricedCalls: 0 };
    const tenantId = input.tenantId.startsWith("ten_") ? input.tenantId : `ten_${input.tenantId}`;
    const maxTokens = String(await this.policy.maxTokensPerCall(tenantId));
    const modelsByAlias = new Map<ModelAlias, readonly PricedModel[]>();
    const lines: ModelCallLine[] = [];
    for (const call of calls) {
      let models = modelsByAlias.get(call.alias);
      if (models === undefined) {
        models = await this.policy.modelsFor(call.alias);
        modelsByAlias.set(call.alias, models);
      }
      lines.push({ models, maxTokens });
    }
    const priced = await this.ledger.worstCase({ tenantId, lines });
    return { billableMinor: priced.billableMinor, modelCalls: calls.length, unpricedCalls: priced.unpricedLines };
  }

  async estimateMinor(input: { readonly tenantId: string; readonly workflowId: string; readonly compiledDag: CompiledDag }): Promise<number> {
    return (await this.estimate(input)).billableMinor;
  }
}
