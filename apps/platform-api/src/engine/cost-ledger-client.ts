import { Inject, Injectable } from "@nestjs/common";

import {
  ENGINE_AUTH_PROVIDER,
  type EngineAuthProvider,
} from "./auth";
import type { EngineConfig } from "./config";
import { ENGINE_CONFIG } from "./engine-client";
import { EngineProblemError, upstreamProblem } from "./problem";
import type { EngineCallerContext } from "./types";

export interface NodeCost {
  readonly nodeExecutionId: string;
  /** What the tenant is billed for the step (D24); the internal cost never leaves this client. */
  readonly billableMinor: string;
  readonly eventCount: number;
}

export interface CostSummaryQuery {
  readonly startAt: string;
  readonly endAt: string;
  readonly dimensions: readonly string[];
}

interface NodeCostsResponse {
  readonly node_costs: readonly {
    readonly node_execution_id: string;
    readonly billable_minor: string;
    readonly event_count: number;
  }[];
}

@Injectable()
export class CostLedgerClient {
  constructor(
    @Inject(ENGINE_CONFIG) private readonly config: EngineConfig,
    @Inject(ENGINE_AUTH_PROVIDER)
    private readonly authProvider: EngineAuthProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getNodeCosts(
    runId: string,
    context: EngineCallerContext,
  ): Promise<readonly NodeCost[]> {
    let authorization;
    try {
      authorization = await this.authProvider.authorize(context);
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, `/api/v1/runs/${runId}`, "UPSTREAM_SERVICE_ERROR"),
      );
    }

    const query = new URLSearchParams({
      tenantId: prefixedId("ten", context.tenantId),
      workspaceId: prefixedId("ws", context.workspaceId),
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.config.costLedgerBaseUrl.replace(/\/+$/, "")}/costs/by-run/${encodeURIComponent(runId)}?${query}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authorization.m2mAccessToken}`,
            "X-Alter-Actor-Token": authorization.actorToken,
            traceparent: context.traceparent,
            Accept: "application/json, application/problem+json",
          },
        },
      );
    } catch {
      throw new EngineProblemError(
        upstreamProblem(502, `/api/v1/runs/${runId}`, "UPSTREAM_SERVICE_ERROR"),
      );
    }
    if (!response.ok) {
      throw new EngineProblemError(
        upstreamProblem(
          response.status >= 500 ? response.status : 502,
          `/api/v1/runs/${runId}`,
          "UPSTREAM_SERVICE_ERROR",
        ),
      );
    }

    const parsed = await parseNodeCosts(response, runId);
    return parsed.node_costs.map((cost) => ({
      nodeExecutionId: cost.node_execution_id,
      billableMinor: cost.billable_minor,
      eventCount: cost.event_count,
    }));
  }

  /**
   * D24: the billed cost of each run, each billed on its own total. Runs are
   * asked for 200 at a time; a run with no cost events is billed zero.
   */
  async getRunTotals(
    runIds: readonly string[],
    context: EngineCallerContext,
    instance: string,
  ): Promise<ReadonlyMap<string, string>> {
    const totals = new Map<string, string>();
    for (let start = 0; start < runIds.length; start += RUN_TOTALS_BATCH) {
      const response = await this.request(
        "POST",
        "/costs/run-totals",
        context,
        instance,
        {
          tenantId: prefixedId("ten", context.tenantId),
          workspaceId: prefixedId("ws", context.workspaceId),
          runIds: runIds.slice(start, start + RUN_TOTALS_BATCH),
        },
      );
      const body = (await parseJson(response, instance, isRunTotals)) as {
        readonly runs: readonly { readonly run_id: string; readonly billable_minor: string }[];
      };
      for (const run of body.runs) totals.set(run.run_id, run.billable_minor);
    }
    return totals;
  }

  async getSummary(
    input: CostSummaryQuery,
    context: EngineCallerContext,
  ): Promise<string> {
    const instance = "/api/v1/costs/summary";
    const response = await this.request(
      "GET",
      "/costs/summary",
      context,
      instance,
      undefined,
      input,
    );
    return (await parseRollups(response, instance)).rollups_json;
  }

  private async request(
    method: "GET" | "POST",
    path: "/costs/summary" | "/costs/run-totals",
    context: EngineCallerContext,
    instance: string,
    body?: object,
    summary?: CostSummaryQuery,
  ): Promise<Response> {
    let authorization;
    try {
      authorization = await this.authProvider.authorize(context);
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }

    const query = new URLSearchParams({
      tenantId: prefixedId("ten", context.tenantId),
      workspaceId: prefixedId("ws", context.workspaceId),
    });
    if (summary) {
      query.set("startAt", summary.startAt);
      query.set("endAt", summary.endAt);
      for (const dimension of summary.dimensions) query.append("dimensions", dimension);
    }
    try {
      const response = await this.fetchImpl(
        `${this.config.costLedgerBaseUrl.replace(/\/+$/, "")}${path}${query.size > 0 ? `?${query}` : ""}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${authorization.m2mAccessToken}`,
            "X-Alter-Actor-Token": authorization.actorToken,
            traceparent: context.traceparent,
            Accept: "application/json, application/problem+json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      if (!response.ok) {
        throw new EngineProblemError(
          upstreamProblem(
            response.status >= 500 ? response.status : 502,
            instance,
            "UPSTREAM_SERVICE_ERROR",
          ),
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof EngineProblemError) throw error;
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }
  }
}

const RUN_TOTALS_BATCH = 200;

function isRunTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.runs) &&
    value.runs.every(
      (run: unknown) =>
        isRecord(run) &&
        typeof run.run_id === "string" &&
        /^run_[0-9a-f-]{36}$/i.test(run.run_id) &&
        isMinor(run.billable_minor),
    )
  );
}

function prefixedId(prefix: "ten" | "ws", id: string): string {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
}

async function parseNodeCosts(response: Response, runId: string): Promise<NodeCostsResponse> {
  try {
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      !Array.isArray(body.node_costs) ||
      !body.node_costs.every(isNodeCost)
    ) {
      throw new Error("invalid node cost response");
    }
    return body as unknown as NodeCostsResponse;
  } catch {
    throw new EngineProblemError(
      upstreamProblem(502, `/api/v1/runs/${runId}`, "UPSTREAM_SERVICE_ERROR"),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeCost(value: unknown): value is NodeCostsResponse["node_costs"][number] {
  return (
    isRecord(value) &&
    typeof value.node_execution_id === "string" &&
    /^node_[0-9a-f-]{36}$/i.test(value.node_execution_id) &&
    isMinor(value.billable_minor) &&
    typeof value.event_count === "number" &&
    Number.isSafeInteger(value.event_count) &&
    value.event_count > 0
  );
}

async function parseRollups(
  response: Response,
  instance: string,
): Promise<{ readonly rollups_json: string }> {
  return parseJson(response, instance, (body) =>
    isRecord(body) && typeof body.rollups_json === "string",
  ) as Promise<{ readonly rollups_json: string }>;
}

async function parseJson(
  response: Response,
  instance: string,
  isValid: (value: unknown) => boolean,
): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    if (!isValid(body)) throw new Error("invalid response");
    return body;
  } catch {
    throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
  }
}

function isMinor(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}
