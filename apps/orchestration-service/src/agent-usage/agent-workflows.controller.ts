import { randomUUID } from "node:crypto";
import { Controller, Get, HttpException, Param, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";

import { AgentWorkflowsService, AgentWorkflowsValidationError } from "./agent-workflows.service";

/**
 * Which workflows an agent has worked in lately, across the tenant's
 * workspaces (section 17): the platform's jobs use it to tell those
 * workflows' owners about the agent's drift. It crosses workspaces, so it
 * answers the system principal only.
 */
@Controller("api/v1/agents")
export class AgentWorkflowsController {
  constructor(private readonly agents: AgentWorkflowsService) {}

  @Get(":agentId/workflows")
  async list(@Req() request: SessionGatewayRequest, @Param("agentId") agentId: string) {
    const actor = request.actorContext;
    if (actor === undefined) {
      throw new HttpException(problem(request.url, 500, "AGENT_WORKFLOWS_INTERNAL", "Missing authenticated tenant context"), 500);
    }
    if (actor.actor_type !== "system") {
      throw new HttpException(problem(request.url, 403, "AGENT_WORKFLOWS_SYSTEM_ONLY", "This feed is for the platform's background jobs"), 403);
    }
    try {
      const rows = await this.agents.recentWorkflows(actor.tenant_id, agentId);
      return { data: rows.map((row) => ({ workflow_id: row.workflow_id, workspace_id: `ws_${row.workspace_id}`, name: row.name })) };
    } catch (error: unknown) {
      if (error instanceof AgentWorkflowsValidationError) {
        throw new HttpException(problem(request.url, 400, "AGENT_WORKFLOWS_VALIDATION_FAILED", error.message), 400);
      }
      throw new HttpException(problem(request.url, 500, "AGENT_WORKFLOWS_INTERNAL", "Workflows could not be listed"), 500);
    }
  }
}

function problem(instance: string | undefined, status: 400 | 403 | 500, errorCode: string, detail: string): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Internal Server Error",
    status,
    detail,
    instance: instance?.startsWith("/") ? instance : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: status === 500,
    field_errors: [],
    documentation_key: "agents.workflows",
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}` as `${typeof prefix}_${string}`;
}
