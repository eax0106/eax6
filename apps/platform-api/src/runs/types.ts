import type { JsonValue } from "@alterx/shared-clients";

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunListQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  status?: RunStatus | undefined;
  mode?: "workflow" | "project" | undefined;
  started_after?: string | undefined;
  started_before?: string | undefined;
}

export interface RetryNodeRequest {
  node_key: string;
}

export type CancelRunRequest = Record<string, never>;

export type EngineResource = Readonly<Record<string, JsonValue>>;

export interface EnginePage<T> {
  data: readonly T[];
  page: {
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  };
}

export interface RunDetail {
  run: EngineResource;
  node_executions: readonly EngineResource[];
  verification_results: readonly EngineResource[];
  recovery_actions: readonly EngineResource[];
  quality_gates: readonly EngineResource[];
  /** Null until the run finishes and the Engine records its outcome. */
  outcome: EngineResource | null;
  /** D24: what the run cost the tenant so far, billed price, in minor units. */
  run_cost_minor: string;
}

/** D4: the figure shown before a run, in paise, billed price only (D24). */
export type EngineRunEstimate = {
  readonly currency: "INR";
  readonly at_most_minor: number;
  readonly usually_minor: number | null;
  readonly sample_runs: number;
  readonly model_calls: number;
  readonly unpriced_calls: number;
};
