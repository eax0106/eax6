import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { JsonValue } from "@alterx/shared-clients";
import {
  EngineClient,
  type EngineCallerContext,
  type EngineRequestBody,
  type EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { WorkflowHttpError } from "./problem";
import type {
  CreateWorkflowInput,
  EmptyWorkflowActionInput,
  NodeTypeList,
  ReplaceTemplateVariablesInput,
  SaveCanvasInput,
  SetTemplateVariableValueInput,
  SimulateWorkflowInput,
  StartCanaryInput,
  WorkflowVersionActionInput,
  WorkflowActionResult,
  WorkflowList,
  WorkflowResource,
  WorkflowVersionList,
} from "./types";
import {
  parseTraceparent,
  parseVersionQuery,
  parseWorkflowId,
} from "./validation";

@Injectable()
export class WorkflowService {
  constructor(private readonly engine: EngineClient) {}

  create(
    input: CreateWorkflowInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowResource>> {
    return this.engine.post(
      "/api/v1/workflows",
      jsonBody(input),
      callerContext(actor, traceparent, "/api/v1/workflows"),
      { idempotencyKey },
    );
  }

  nodeTypes(
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<NodeTypeList>> {
    const instance = "/api/v1/node-types";
    return this.engine.get(instance, callerContext(actor, traceparent, instance));
  }

  list(
    cursor: string | undefined,
    limit: string | undefined,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<WorkflowList>> {
    const instance = "/api/v1/workflows";
    const query = parseVersionQuery(cursor, limit, instance);
    return this.engine.get(
      `/api/v1/workflows${query}`,
      callerContext(actor, traceparent, instance),
    );
  }

  get(
    workflowId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<WorkflowResource>> {
    const instance = `/api/v1/workflows/${workflowId}`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.get(
      `/api/v1/workflows/${encodeURIComponent(id)}`,
      callerContext(actor, traceparent, instance),
    );
  }

  saveCanvas(
    workflowId: string,
    input: SaveCanvasInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
    ifMatch: string,
  ): Promise<EngineResponse<WorkflowResource>> {
    const instance = `/api/v1/workflows/${workflowId}`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.patch(
      `/api/v1/workflows/${encodeURIComponent(id)}`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey, ifMatch },
    );
  }

  versions(
    workflowId: string,
    cursor: string | undefined,
    limit: string | undefined,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<WorkflowVersionList>> {
    const instance = `/api/v1/workflows/${workflowId}/versions`;
    const id = parseWorkflowId(workflowId, instance);
    const query = parseVersionQuery(cursor, limit, instance);
    return this.engine.get(
      `/api/v1/workflows/${encodeURIComponent(id)}/versions${query}`,
      callerContext(actor, traceparent, instance),
    );
  }

  action(
    workflowId: string,
    action:
      | "validate"
      | "compile"
      | "simulate"
      | "activate"
      | "pause"
      | "resume",
    input:
      | EmptyWorkflowActionInput
      | SimulateWorkflowInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    const instance = `/api/v1/workflows/${workflowId}/actions/${action}`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.post(
      `/api/v1/workflows/${encodeURIComponent(id)}/actions/${action}`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  /**
   * The first step of a deployment: a compiled version has to be tested
   * before it can be promoted or sent out as a canary. The engine has had
   * this action since the lifecycle was written and nothing exposed it, so
   * a freshly compiled version could not be deployed through this API at
   * all -- promote and canary each refuse anything that is not "tested".
   */
  testVersion(
    workflowId: string,
    input: WorkflowVersionActionInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    return this.versionAction(workflowId, "test-version", input, actor, traceparent, idempotencyKey);
  }

  promoteVersion(
    workflowId: string,
    input: WorkflowVersionActionInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    return this.versionAction(workflowId, "promote-version", input, actor, traceparent, idempotencyKey);
  }

  startCanary(
    workflowId: string,
    input: StartCanaryInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    return this.versionAction(workflowId, "start-canary", input, actor, traceparent, idempotencyKey);
  }

  rollback(
    workflowId: string,
    input: WorkflowVersionActionInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    return this.versionAction(workflowId, "rollback", input, actor, traceparent, idempotencyKey);
  }

  templateVariables(
    workflowId: string,
    actor: ActorContext,
    traceparent: string | undefined,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.get(
      `/api/v1/workflows/${encodeURIComponent(id)}/template-variables`,
      callerContext(actor, traceparent, instance),
    );
  }

  replaceTemplateVariables(
    workflowId: string,
    input: ReplaceTemplateVariablesInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.put(
      `/api/v1/workflows/${encodeURIComponent(id)}/template-variables`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  setTemplateVariableValue(
    workflowId: string,
    name: string,
    input: SetTemplateVariableValueInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    const instance = `/api/v1/workflows/${workflowId}/template-variables/${name}/value`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.put(
      `/api/v1/workflows/${encodeURIComponent(id)}/template-variables/${encodeURIComponent(name)}/value`,
      jsonBody(input),
      callerContext(actor, traceparent, instance),
      { idempotencyKey },
    );
  }

  private versionAction(
    workflowId: string,
    action: "test-version" | "promote-version" | "start-canary" | "rollback",
    input: WorkflowVersionActionInput | StartCanaryInput,
    actor: ActorContext,
    traceparent: string | undefined,
    idempotencyKey: string,
  ): Promise<EngineResponse<WorkflowActionResult>> {
    const instance = `/api/v1/workflows/${workflowId}/actions/${action}`;
    const id = parseWorkflowId(workflowId, instance);
    return this.engine.post(
      `/api/v1/workflows/${encodeURIComponent(id)}/actions/${action}`,
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
    throw new WorkflowHttpError(
      403,
      "WORKFLOW_WORKSPACE_REQUIRED",
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
