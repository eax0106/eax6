import { Inject, Injectable } from "@nestjs/common";

import { COST_STORE_PROVIDER, type CostStoreProvider } from "../database/cost-store.token";
import type { MarginApplier } from "../node-costs/run-total.service";

export const RUN_ESTIMATE_MARGIN = Symbol("RUN_ESTIMATE_MARGIN");
/** INR per US dollar, as a decimal string: money maths here never touches floating point. */
export const RUN_ESTIMATE_USD_TO_INR = Symbol("RUN_ESTIMATE_USD_TO_INR");

export class RunEstimateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEstimateValidationError";
  }
}

export interface WorstCaseLine {
  /** Every model that could serve the call: the alias's own model and its fallbacks. The dearest one is priced. */
  readonly models: readonly { readonly provider: string; readonly modelId: string }[];
  /** The gateway's per-call token cap for the alias, as digits. */
  readonly maxTokens: string;
}

export interface WorstCase {
  readonly internalMinor: string;
  /** What the tenant would be billed: the margin applied once to the total. */
  readonly billableMinor: string;
  /** Lines with no price on record. They add nothing, so the bound is too low by their share. */
  readonly unpricedLines: string;
}

export interface RunsAverage {
  /** Average billed cost of the runs that have cost data, rounded up; null when none has. */
  readonly averageBillableMinor: string | null;
  readonly runCount: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RUNS = 50;
const MAX_LINES = 500;

/**
 * D4 (design log section 9): what a run could cost at most, and what runs of
 * the same workflow usually cost. Unit prices multiply unrounded; the total
 * rounds once, up, and the margin is applied once to that total.
 */
@Injectable()
export class RunEstimatesService {
  constructor(
    @Inject(COST_STORE_PROVIDER) private readonly store: CostStoreProvider,
    @Inject(RUN_ESTIMATE_MARGIN) private readonly applyMargin: MarginApplier,
    @Inject(RUN_ESTIMATE_USD_TO_INR) private readonly usdToInr: string,
  ) {}

  async worstCase(input: { readonly tenantId: unknown; readonly lines: unknown }): Promise<WorstCase> {
    requirePrefixedUuid(input.tenantId, "ten", "tenantId");
    const lines = parseLines(input.lines);
    let unpricedLines = 0n;
    // Prices are global, not a tenant's, so the provisioner reads them as the estimator always has.
    const total = await this.store.withProvisioner(async (tx) => {
      const costs: string[] = [];
      for (const line of lines) {
        const providers = line.models.map((model) => model.provider);
        const modelIds = line.models.map((model) => model.modelId);
        const priced = await tx.query<{ price: string | null }>(
          `SELECT MAX(unit_cost_minor * CASE WHEN currency = 'USD' THEN $3::numeric ELSE 1 END)::text AS price
             FROM model_pricing p
            WHERE resource IN ('input_tokens', 'output_tokens')
              AND EXISTS (
                SELECT 1 FROM unnest($1::text[], $2::text[]) AS m(provider, model_id)
                 WHERE m.provider = p.provider AND (m.model_id = p.model_id OR p.model_id = '')
              )`,
          [providers, modelIds, this.usdToInr],
        );
        const price = priced.rows[0]?.price ?? null;
        if (price === null) {
          unpricedLines += 1n;
          continue;
        }
        const cost = await tx.query<{ cost: string }>("SELECT ($1::numeric * $2::numeric)::text AS cost", [price, line.maxTokens]);
        costs.push(cost.rows[0]!.cost);
      }
      const summed = await tx.query<{ total: string }>(
        "SELECT COALESCE(ceil(sum(c)), 0)::text AS total FROM unnest($1::numeric[]) AS c",
        [costs],
      );
      return summed.rows[0]!.total;
    });
    return { internalMinor: total, billableMinor: this.applyMargin(total), unpricedLines: unpricedLines.toString() };
  }

  async runsAverage(input: {
    readonly tenantId: unknown;
    readonly workspaceId: unknown;
    readonly runIds: unknown;
  }): Promise<RunsAverage> {
    const tenantId = requirePrefixedUuid(input.tenantId, "ten", "tenantId");
    const workspaceId = requirePrefixedUuid(input.workspaceId, "ws", "workspaceId");
    if (!Array.isArray(input.runIds) || input.runIds.length === 0 || input.runIds.length > MAX_RUNS) {
      throw new RunEstimateValidationError(`runIds must list from 1 to ${MAX_RUNS} runs`);
    }
    const runIds = input.runIds.map((id) => requirePrefixedUuid(id, "run", "runIds"));
    const perRun = await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ internal_cost_minor: string }>(
        `SELECT SUM(internal_cost_minor)::text AS internal_cost_minor
           FROM cost_events
          WHERE tenant_id = $1 AND workspace_id = $2 AND run_id = ANY($3::uuid[])
          GROUP BY run_id`,
        [tenantId, workspaceId, runIds],
      );
      return result.rows;
    });
    if (perRun.length === 0) return { averageBillableMinor: null, runCount: "0" };
    // Each run is billed on its own total, then the bills are averaged.
    const billed = perRun.map((row) => BigInt(this.applyMargin(row.internal_cost_minor)));
    const sum = billed.reduce((left, right) => left + right, 0n);
    const count = BigInt(billed.length);
    return { averageBillableMinor: ((sum + count - 1n) / count).toString(), runCount: billed.length.toString() };
  }
}

function parseLines(value: unknown): readonly WorstCaseLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINES) {
    throw new RunEstimateValidationError(`lines must list from 1 to ${MAX_LINES} model calls`);
  }
  return value.map((raw: unknown): WorstCaseLine => {
    const line = raw as { readonly models?: unknown; readonly maxTokens?: unknown } | null;
    if (line === null || typeof line !== "object" || !Array.isArray(line.models) || line.models.length === 0) {
      throw new RunEstimateValidationError("each line needs the models that could serve it");
    }
    if (typeof line.maxTokens !== "string" || !/^[1-9][0-9]{0,12}$/.test(line.maxTokens)) {
      throw new RunEstimateValidationError("maxTokens must be a whole number of tokens, sent as digits");
    }
    const models = line.models.map((model: unknown) => {
      const entry = model as { readonly provider?: unknown; readonly modelId?: unknown } | null;
      if (entry === null || typeof entry !== "object" || typeof entry.provider !== "string" || entry.provider.length === 0 || typeof entry.modelId !== "string") {
        throw new RunEstimateValidationError("each model needs a provider and a model id");
      }
      return { provider: entry.provider, modelId: entry.modelId };
    });
    return { models, maxTokens: line.maxTokens };
  });
}

function requirePrefixedUuid(value: unknown, prefix: string, field: string): string {
  const expected = `${prefix}_`;
  if (typeof value !== "string" || value.length === 0) throw new RunEstimateValidationError(`${field} is required`);
  if (!value.startsWith(expected)) throw new RunEstimateValidationError(`${field} must have prefix ${expected}`);
  const bare = value.slice(expected.length);
  if (!UUID_PATTERN.test(bare)) throw new RunEstimateValidationError(`${field} must be a ${prefix}_ prefixed UUID`);
  return bare;
}
