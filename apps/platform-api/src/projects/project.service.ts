import { randomBytes } from "node:crypto";
import type { JsonValue } from "@alterx/shared-clients";
import {
  EngineClient,
  type EngineCallerContext,
  type EngineRequestBody,
  type EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { ProjectHttpError } from "./problem";
import type {
  ClarificationAnswerInput,
  CreateProjectInput,
  EmptyProjectActionInput,
  ProjectActionResult,
  ProjectBuild,
  ProjectClarificationList,
  ProjectList,
  ProjectPlan,
  ProjectRecord,
  ProjectResource,
  RejectPlanInput,
  RequestPlanChangesInput,
} from "./types";
import {
  parseClarificationId,
  parseProjectId,
  parseProjectListQuery,
  parseTraceparent,
} from "./validation";

export type PlanReviewAction = "approve" | "reject" | "request-changes";

export class ProjectService {
  constructor(private readonly engine: EngineClient) {}

  create(
    input: CreateProjectInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<ProjectResource>> {
    const instance = "/api/v1/projects";
    // Creating a project runs the planner before the engine answers, so this
    // call waits on two model calls rather than a database write.
    return this.engine.post(
      instance,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey, timeoutMs: this.engine.planningTimeoutMs },
    );
  }

  list(
    cursor: string | undefined,
    limit: string | undefined,
    actor: ActorContext,
    traceparent: string | undefined,
    nameQuery?: string,
  ): Promise<EngineResponse<ProjectList>> {
    const instance = "/api/v1/projects";
    const query = parseProjectListQuery(cursor, limit, instance, nameQuery);
    return this.engine.get(
      `/api/v1/projects${query}`,
      callerContext(actor, traceparent, instance),
    );
  }

  get(
    projectId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<ProjectRecord>> {
    const instance = `/api/v1/projects/${projectId}`;
    const id = parseProjectId(projectId, instance);
    return this.engine.get(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  clarifications(
    projectId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<ProjectClarificationList>> {
    const instance = `/api/v1/projects/${projectId}/clarifications`;
    const id = parseProjectId(projectId, instance);
    return this.engine.get(
      `/api/v1/projects/${encodeURIComponent(id)}/clarifications?status=pending`,
      callerContext(actor, traceparent, instance),
    );
  }

  answerClarification(
    projectId: string,
    clarificationId: string,
    input: ClarificationAnswerInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<ProjectActionResult>> {
    const instance =
      `/api/v1/projects/${projectId}/clarifications/${clarificationId}/answer`;
    const id = parseProjectId(projectId, instance);
    const clarification = parseClarificationId(clarificationId, instance);
    // Answering resumes the planner, which writes the next part of the plan
    // before this returns -- the same wait as creating the project.
    return this.engine.post(
      `/api/v1/projects/${encodeURIComponent(id)}/clarifications/${encodeURIComponent(clarification)}/answer`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey, timeoutMs: this.engine.planningTimeoutMs },
    );
  }

  plan(
    projectId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<ProjectPlan>> {
    const instance = `/api/v1/projects/${projectId}/plan`;
    const id = parseProjectId(projectId, instance);
    return this.engine.get(
      `/api/v1/projects/${encodeURIComponent(id)}/plan`,
      callerContext(actor, traceparent, instance),
    );
  }

  reviewPlan(
    projectId: string,
    action: PlanReviewAction,
    input:
      | EmptyProjectActionInput
      | RejectPlanInput
      | RequestPlanChangesInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<ProjectActionResult>> {
    const instance =
      `/api/v1/projects/${projectId}/plan/actions/${action}`;
    const id = parseProjectId(projectId, instance);
    return this.engine.post(
      `/api/v1/projects/${encodeURIComponent(id)}/plan/actions/${action}`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  startBuild(
    projectId: string,
    input: EmptyProjectActionInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<ProjectBuild>> {
    const instance = `/api/v1/projects/${projectId}/builds`;
    const id = parseProjectId(projectId, instance);
    return this.engine.post(
      `/api/v1/projects/${encodeURIComponent(id)}/builds`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }
}

function callerContext(
  actor: ActorContext,
  traceparent: string | undefined,
  instance: string,
): EngineCallerContext {
  if (!actor.workspace_id) {
    throw new ProjectHttpError(
      403,
      "PROJECT_WORKSPACE_REQUIRED",
      "Workspace actor context required",
      instance,
    );
  }
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id,
    sessionId: actor.session_id,
    authTime: actor.auth_time ?? Math.floor(Date.now() / 1_000),
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent: parseTraceparent(traceparent, instance) ?? newTraceparent(),
  };
}

function jsonBody(value: unknown): EngineRequestBody {
  return value as JsonValue;
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
