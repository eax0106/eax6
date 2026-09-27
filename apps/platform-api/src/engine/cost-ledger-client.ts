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
  readonly internalCostMinor: string;
  readonly eventCount: number;
}

const costSources = [
  "model_gateway",
  "tool_gateway",
  "sandbox",
  "storage",
  "browser",
] as const;
const estimateConfidences = [
  "tenant_historical",
  "global_historical",
  "no_data",
] as const;

export type CostSource = (typeof costSources)[number];
export type CostMode = "workflow" | "project";

export interface CostSummaryQuery {
  readonly startAt: string;
  readonly endAt: string;
  readonly dimensions: readonly string[];
}

export interface EstimateCostRequest {
  readonly mode: CostMode;
  readonly lineItems: readonly {
    readonly source: CostSource;
    readonly provider: string;
    readonly resource: string;
    readonly expectedQuantity: number;
  }[];
}

export interface EstimateCostResponse {
  readonly currency: "INR";
  readonly lineItems: readonly {
    readonly source: CostSource;
    readonly provider: string;
    readonly resource: string;
    readonly expectedQuantity: number;
    readonly confidence: (typeof estimateConfidences)[number];
    readonly sampleSize: number;
    readonly historicalUnitCostMinor: string | null;
    readonly estimatedBaseCostMinor: string;
    readonly historicalRetryRate: number;
    readonly estimatedRetryCostMinor: string;
    readonly estimatedTotalCostMinor: string;
  }[];
  readonly totalEstimatedInternalCostMinor: string;
  readonly hasUnestimatedLineItems: boolean;
}

interface NodeCostsResponse {
  readonly node_costs: readonly {
    readonly node_execution_id: string;
    readonly internal_cost_minor: string;
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
      internalCostMinor: cost.internal_cost_minor,
      eventCount: cost.event_count,
    }));
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

  async estimate(
    input: EstimateCostRequest,
    context: EngineCallerContext,
  ): Promise<EstimateCostResponse> {
    const instance = "/api/v1/costs/estimate";
    const response = await this.request(
      "POST",
      "/costs/estimate",
      context,
      instance,
      { tenantId: bareId("ten", context.tenantId), ...input },
    );
    return parseEstimate(response, instance);
  }

  private async request(
    method: "GET" | "POST",
    path: "/costs/summary" | "/costs/estimate",
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

function prefixedId(prefix: "ten" | "ws", id: string): string {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
}

function bareId(prefix: "ten" | "ws", id: string): string {
  return id.startsWith(`${prefix}_`) ? id.slice(prefix.length + 1) : id;
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
    typeof value.internal_cost_minor === "string" &&
    /^\d+$/.test(value.internal_cost_minor) &&
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

async function parseEstimate(response: Response, instance: string): Promise<EstimateCostResponse> {
  return parseJson(response, instance, isEstimateResponse) as Promise<EstimateCostResponse>;
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

function isEstimateResponse(value: unknown): value is EstimateCostResponse {
  return (
    isRecord(value) &&
    value.currency === "INR" &&
    Array.isArray(value.lineItems) &&
    value.lineItems.every(isEstimateLineItem) &&
    typeof value.totalEstimatedInternalCostMinor === "string" &&
    /^\d+$/.test(value.totalEstimatedInternalCostMinor) &&
    typeof value.hasUnestimatedLineItems === "boolean"
  );
}

function isEstimateLineItem(
  value: unknown,
): value is EstimateCostResponse["lineItems"][number] {
  return (
    isRecord(value) &&
    isCostSource(value.source) &&
    typeof value.provider === "string" &&
    typeof value.resource === "string" &&
    typeof value.expectedQuantity === "number" &&
    Number.isFinite(value.expectedQuantity) &&
    isEstimateConfidence(value.confidence) &&
    typeof value.sampleSize === "number" &&
    Number.isSafeInteger(value.sampleSize) &&
    (value.historicalUnitCostMinor === null || isMinor(value.historicalUnitCostMinor)) &&
    isMinor(value.estimatedBaseCostMinor) &&
    typeof value.historicalRetryRate === "number" &&
    Number.isFinite(value.historicalRetryRate) &&
    isMinor(value.estimatedRetryCostMinor) &&
    isMinor(value.estimatedTotalCostMinor)
  );
}

function isCostSource(value: unknown): value is CostSource {
  return typeof value === "string" && costSources.includes(value as CostSource);
}

function isEstimateConfidence(
  value: unknown,
): value is EstimateCostResponse["lineItems"][number]["confidence"] {
  return (
    typeof value === "string" &&
    estimateConfidences.includes(
      value as EstimateCostResponse["lineItems"][number]["confidence"],
    )
  );
}

function isMinor(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}
