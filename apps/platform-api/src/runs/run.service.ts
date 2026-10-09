import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  CostLedgerClient,
  EngineClient,
  EngineProblemError,
  type EngineCallerContext,
  type EnginePath,
  type EngineResponse,
  type EngineRequestBody,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { RunHttpError } from "./problem";
import type {
  EnginePage,
  EngineResource,
  RunDetail,
  EngineRunEstimate,
} from "./types";
import {
  parseArtifactId,
  parseCancelRunRequest,
  parseCreateRunRequest,
  parseRetryNodeRequest,
  parseRunId,
  parseArtifactListQuery,
  parseRunEstimateQuery,
  parseRunListQuery,
  parseTraceparent,
  serializeQuery,
} from "./validation";

const maximumAggregatePages = 100;

@Injectable()
export class RunService {
  constructor(
    private readonly engine: EngineClient,
    private readonly costLedger: CostLedgerClient,
  ) {}

  list(
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EnginePage<EngineResource>>> {
    const instance = "/api/v1/runs";
    const query = parseRunListQuery(input, instance);
    return this.engine.get(
      `/api/v1/runs${serializeQuery(query)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  /** D4: what a run of the workflow would cost, shown before it starts. */
  estimate(
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EngineRunEstimate>> {
    const instance = "/api/v1/runs/estimate";
    const query = parseRunEstimateQuery(input, instance);
    return this.engine.get<EngineRunEstimate>(
      `/api/v1/runs/estimate${serializeQuery(query)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  create(
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = "/api/v1/runs";
    const request = parseCreateRunRequest(input, instance);
    return this.engine.post(
      "/api/v1/runs",
      request as unknown as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  cancel(
    runId: string,
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/runs/${runId}/actions/cancel`;
    const id = parseRunId(runId, instance);
    const request = parseCancelRunRequest(input, instance);
    return this.engine.post(
      `/api/v1/runs/${encodeURIComponent(id)}/actions/cancel`,
      request as unknown as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  retryNode(
    runId: string,
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/runs/${runId}/actions/retry-node`;
    const id = parseRunId(runId, instance);
    const request = parseRetryNodeRequest(input, instance);
    return this.engine.post(
      `/api/v1/runs/${encodeURIComponent(id)}/actions/retry-node`,
      request as unknown as EngineRequestBody,
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  async detail(
    runId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<RunDetail>> {
    const instance = `/api/v1/runs/${runId}`;
    const id = parseRunId(runId, instance);
    const context = callerContext(actor, traceparent, instance);
    const encodedId = encodeURIComponent(id);
    const [run, executions, verification, recovery, qualityGates, outcome, nodeCosts, runTotals] =
      await Promise.all([
        this.engine.get<EngineResource>(`/api/v1/runs/${encodedId}`, context),
        this.allPages(
          `/api/v1/runs/${encodedId}/node-executions`,
          context,
          instance,
        ),
        this.allPages(
          `/api/v1/runs/${encodedId}/verification-results`,
          context,
          instance,
        ),
        this.allPages(
          `/api/v1/runs/${encodedId}/recovery-actions`,
          context,
          instance,
        ),
        this.allPages(
          `/api/v1/runs/${encodedId}/quality-gates`,
          context,
          instance,
        ),
        this.outcomeIfRecorded(encodedId, context),
        this.costLedger.getNodeCosts(id, context),
        this.costLedger.getRunTotals([id], context, instance),
      ]);

    // D24: the tenant sees what each step and the run cost it, billed price only.
    const costsByNode = new Map(
      nodeCosts.map((cost) => [cost.nodeExecutionId, cost.billableMinor]),
    );

    return {
      ...run,
      body: {
        run: run.body,
        node_executions: executions.map((execution) => {
          const nodeExecutionId =
            typeof execution.id === "string"
              ? execution.id
              : typeof execution.node_execution_id === "string"
                ? execution.node_execution_id
                : undefined;
          return {
            ...execution,
            node_cost_minor:
              nodeExecutionId === undefined
                ? "0"
                : (costsByNode.get(nodeExecutionId) ?? "0"),
          };
        }),
        verification_results: verification,
        recovery_actions: recovery,
        quality_gates: qualityGates,
        outcome,
        run_cost_minor: runTotals.get(id) ?? "0",
      },
    };
  }

  // The Engine records a run's outcome only when the run finishes and answers
  // 404 until then. That is "no outcome yet", not "no such run": a running
  // run must still have a detail page. A missing run still 404s through the
  // run read itself.
  private async outcomeIfRecorded(
    encodedId: string,
    context: EngineCallerContext,
  ): Promise<EngineResource | null> {
    try {
      return (
        await this.engine.get<EngineResource>(
          `/api/v1/runs/${encodedId}/outcome`,
          context,
        )
      ).body;
    } catch (error) {
      if (error instanceof EngineProblemError && error.problem.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // Dedicated single-resource reads of the same two sub-resources detail()
  // already aggregates above -- separate routes so a caller (e.g. a
  // recovery-history panel or a per-node verification popover) doesn't have
  // to fetch the whole run detail (executions, outcome, node costs) just to
  // read these. Reuses allPages() rather than exposing cursor/limit to the
  // frontend: these collections are small (a handful of gate checks/
  // recovery attempts per run, not thousands), so aggregating server-side
  // mirrors what detail() already does for the exact same two resources
  // instead of adding a third pagination shape to this file.
  verificationResults(
    runId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<readonly EngineResource[]> {
    const instance = `/api/v1/runs/${runId}/verification-results`;
    const id = parseRunId(runId, instance);
    const context = callerContext(actor, traceparent, instance);
    return this.allPages(
      `/api/v1/runs/${encodeURIComponent(id)}/verification-results`,
      context,
      instance,
    );
  }

  recoveryActions(
    runId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<readonly EngineResource[]> {
    const instance = `/api/v1/runs/${runId}/recovery-actions`;
    const id = parseRunId(runId, instance);
    const context = callerContext(actor, traceparent, instance);
    return this.allPages(
      `/api/v1/runs/${encodeURIComponent(id)}/recovery-actions`,
      context,
      instance,
    );
  }

  artifacts(
    input: unknown,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EnginePage<EngineResource>>> {
    const instance = "/api/v1/artifacts";
    const query = parseArtifactListQuery(input, instance);
    return this.engine.get(
      `/api/v1/artifacts${serializeQuery(query)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  artifact(
    artifactId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/artifacts/${artifactId}`;
    const id = parseArtifactId(artifactId, instance);
    return this.engine.get(
      `/api/v1/artifacts/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  artifactDownload(
    artifactId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<EngineResource>> {
    const instance = `/api/v1/artifacts/${artifactId}/download`;
    const id = parseArtifactId(artifactId, instance);
    return this.engine.get(
      `/api/v1/artifacts/${encodeURIComponent(id)}/download`,
      callerContext(actor, traceparent, instance),
    );
  }

  private async allPages(
    path: EnginePath,
    context: EngineCallerContext,
    instance: string,
  ): Promise<readonly EngineResource[]> {
    const records: EngineResource[] = [];
    let cursor: string | undefined;
    for (
      let pageNumber = 0;
      pageNumber < maximumAggregatePages;
      pageNumber += 1
    ) {
      const query = serializeQuery({ cursor, limit: 200 });
      const response = await this.engine.get<EnginePage<EngineResource>>(
        `${path}${query}`,
        context,
      );
      records.push(...response.body.data);
      if (!response.body.page.has_more) return records;
      if (!response.body.page.next_cursor) {
        throw invalidEngineResponse(instance);
      }
      cursor = response.body.page.next_cursor;
    }
    throw invalidEngineResponse(instance);
  }
}

function invalidEngineResponse(instance: string): RunHttpError {
  return new RunHttpError(
    502,
    "INVALID_ENGINE_RUN_RESPONSE",
    "Engine returned an invalid run response",
    instance,
  );
}

function callerContext(
  actor: ActorContext,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new RunHttpError(
      403,
      "RUN_WORKSPACE_REQUIRED",
      "Workspace context required",
      instance,
    );
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: parseTraceparent(traceparent, instance) ?? newTraceparent(),
  };
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
