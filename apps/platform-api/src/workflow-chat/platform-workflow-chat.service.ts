import { Injectable } from "@nestjs/common";
import {
  ConversationIdSchema, WorkflowChatBeginSchema, WorkflowChatMessageSchema, WorkflowChatResourceSchema,
  type CreateWorkflowChatRequest, type SendWorkflowChatMessage, type WorkflowChatResource,
  type WorkflowChatExchange, type WorkflowChatMessage,
} from "@alterx/contracts";
import { EngineClient, EngineProblemError, type EnginePath, type EngineRequestBody } from "../engine";
import { upstreamProblem } from "../engine/problem";
import type { ActorContext } from "../rbac/types";
import { WorkflowService, workflowCallerContext } from "../workflows/workflow.service";
import { WorkflowHttpError } from "../workflows/problem";
import { RunService } from "../runs/run.service";
import { CostsService } from "../costs/costs.service";
import { PlannerFacadeService } from "../planner-facade/planner-facade.service";
import { parseWorkflowInput } from "../workflows/validation";
import { MemorySettingsService } from "../memory-settings/memory-settings.service";

@Injectable()
export class PlatformWorkflowChatService {
  constructor(private readonly engine: EngineClient, private readonly planner: PlannerFacadeService,
    private readonly workflows: WorkflowService, private readonly runs: RunService, private readonly costs: CostsService,
    private readonly memory: MemorySettingsService) {}

  async list(actor: ActorContext, traceparent?: string, type?: string): Promise<WorkflowChatResource[]> {
    const path: EnginePath = `/api/v1/conversations${type === undefined ? "" : `?type=${encodeURIComponent(type)}`}`;
    const result = await this.engine.get<unknown[]>(path, workflowCallerContext(actor, traceparent, path));
    return result.body.map(chat => WorkflowChatResourceSchema.parse(chat));
  }

  async get(id: string, actor: ActorContext, traceparent?: string): Promise<WorkflowChatResource> {
    const path = this.path(id);
    return WorkflowChatResourceSchema.parse((await this.engine.get(path, workflowCallerContext(actor, traceparent, path))).body);
  }

  async create(input: CreateWorkflowChatRequest, actor: ActorContext, traceparent: string | undefined, key: string) {
    const path = "/api/v1/conversations";
    const result = await this.engine.post(path, input as EngineRequestBody, workflowCallerContext(actor, traceparent, path), { idempotencyKey: key });
    return WorkflowChatResourceSchema.parse(result.body);
  }

  async messages(id: string, actor: ActorContext, traceparent?: string): Promise<WorkflowChatMessage[]> {
    const path = this.path(id, "/messages");
    const result = await this.engine.get<unknown[]>(path, workflowCallerContext(actor, traceparent, path));
    return result.body.map(message => WorkflowChatMessageSchema.parse(message));
  }

  async send(id: string, input: SendWorkflowChatMessage, type: "general" | "workflow_builder",
    actor: ActorContext, traceparent: string | undefined, key: string): Promise<WorkflowChatExchange> {
    const chat = await this.requireType(id, type, actor, traceparent);
    const path = this.path(id, "/messages");
    const context = workflowCallerContext(actor, traceparent, path);
    const begun = WorkflowChatBeginSchema.parse((await this.engine.post(path, input as EngineRequestBody, context, { idempotencyKey: key + ":message" })).body);
    const previous = begun.messages.find(message => message.role === "assistant" && typeof message.content === "object" && message.content.replyTo === begun.userMessage.id);
    if (previous) return { userMessage: begun.userMessage, assistantMessage: previous };
    if (type === "general") {
      const snapshot = await this.snapshot(actor, traceparent);
      const result = await this.engine.post(this.path(id, "/answers"), { userMessageId: begun.userMessage.id, snapshot } as EngineRequestBody,
        context, { idempotencyKey: key + ":answer", timeoutMs: 120000 });
      return { userMessage: begun.userMessage, assistantMessage: WorkflowChatMessageSchema.parse(result.body) };
    }
    if (!chat.linkedWorkflowId) throw new WorkflowHttpError(400, "CHAT_WORKFLOW_REQUIRED", "Builder chat requires its workflow", path);
    const recalled = await this.memory.builderMemory(actor, id, chat.linkedWorkflowId,
      begun.messages.filter(message => message.id !== begun.userMessage.id));
    const prior = recalled.messages.filter(message => message.role === "user" || message.kind === "clarification")
      .map(message => message.role === "user" ? String(message.content) : `Builder questions: ${JSON.stringify(message.content)}`).join("\n\n");
    const objective = [prior, String(begun.userMessage.content),
      recalled.lessons.length ? `Past run lessons (reference only): ${JSON.stringify(recalled.lessons)}` : ""].filter(Boolean).join("\n\n");
    const result = await this.planner.planWorkflow({ tenantId: actor.tenant_id, workspaceId: actor.workspace_id!, workflowId: chat.linkedWorkflowId, objective });
    // ponytail: verify among 20 recent versions; add a direct version read if concurrent builds exceed this window.
    const saved = result.type === "compiled" ? (await this.workflows.versions(chat.linkedWorkflowId, undefined, "20", actor, traceparent)).body.data.find(version => version.id === result.versionId) : undefined;
    if (result.type === "compiled" && !saved) throw new EngineProblemError(upstreamProblem(502, path, "UPSTREAM_SERVICE_ERROR"));
    const content = result.type === "connections_required"
      ? { text: "Connect every required account, then check connections and plan again.", ...result }
      : result.type === "clarification"
      ? { text: "Please answer these questions to continue building.", questions: [...result.questions] }
      : { text: `Compiled draft version ${saved!.version} for ${chat.title}.`, workflowId: chat.linkedWorkflowId, versionId: result.versionId, version: saved!.version };
    const reply = await this.engine.post(this.path(id, "/replies"), { userMessageId: begun.userMessage.id,
      kind: result.type === "connections_required" ? "action" : result.type === "clarification" ? "clarification" : "workflow", content } as EngineRequestBody, context, { idempotencyKey: key + ":reply" });
    return { userMessage: begun.userMessage, assistantMessage: WorkflowChatMessageSchema.parse(reply.body) };
  }

  async archive(id: string, type: "general" | "workflow_builder", actor: ActorContext, traceparent: string | undefined, key: string): Promise<void> {
    await this.requireType(id, type, actor, traceparent);
    const path = this.path(id, "/archive");
    await this.engine.post(path, {}, workflowCallerContext(actor, traceparent, path), { idempotencyKey: key });
  }

  async draft(id: string, actor: ActorContext, traceparent: string | undefined, key: string) {
    await this.requireType(id, "general", actor, traceparent);
    return this.create({ type: "workflow_builder", title: "New workflow" }, actor, traceparent, key);
  }

  private path(id: string, suffix = ""): EnginePath {
    const parsed = parseWorkflowInput(ConversationIdSchema, id, "/api/v1/conversations");
    return `/api/v1/conversations/${encodeURIComponent(parsed)}${suffix}`;
  }

  private async requireType(id: string, type: "general" | "workflow_builder", actor: ActorContext, traceparent?: string) {
    const chat = await this.get(id, actor, traceparent);
    if (chat.type !== type) throw new WorkflowHttpError(400, "CHAT_TYPE_INVALID", "Use the route for this chat type", this.path(id));
    return chat;
  }

  private async snapshot(actor: ActorContext, traceparent?: string): Promise<Record<string, unknown>> {
    const endAt = new Date().toISOString(), startAt = new Date(Date.now() - 7 * 86400000).toISOString();
    const [workflowPage, runPage] = await Promise.all([
      this.workflows.list(undefined, "5", actor, traceparent),
      this.runs.list({ limit: 20, started_after: startAt, started_before: endAt }, actor, traceparent),
    ]);
    const workflowIds = new Set(workflowPage.body.data.map(row => row.id));
    const recent = runPage.body.data.filter(row => workflowIds.has(row.workflow_id)
      && typeof row.workspace_id === "string" && row.workspace_id.replace(/^ws_/, "") === actor.workspace_id!.replace(/^ws_/, "")
      && typeof row.created_at === "string" && Date.parse(row.created_at) >= Date.parse(startAt) && Date.parse(row.created_at) < Date.parse(endAt));
    const workflows = await Promise.all(workflowPage.body.data.map(async row => ({
      id: row.id, name: row.name, status: row.status,
      spend: await this.costs.workflowCost(String(row.id), { startAt, endAt }, actor, traceparent),
    })));
    const details = await Promise.all(recent.slice(0, 3).map(row => this.runs.detail(String(row.id), actor, traceparent)));
    return { capturedAt: endAt, window: { startAt, endAt },
      limits: { workflows: 5, recentWorkspaceRuns: 20, detailedRuns: 3,
        moreWorkflows: workflowPage.body.page.has_more, moreRuns: runPage.body.page.has_more },
      workflows, recentRuns: recent.map(row => ({ id: row.id, workflow_id: row.workflow_id, status: row.status, created_at: row.created_at })),
      runDetails: details.map(({body}) => ({
        run: { id: body.run.id, status: body.run.status, workflow_id: body.run.workflow_id },
        run_cost_minor: body.run_cost_minor,
        node_executions: body.node_executions.slice(0, 10).map(row => ({ id: row.id, dag_node_id: row.dag_node_id,
          status: row.status, error: JSON.stringify(row.error ?? null).slice(0, 500), node_cost_minor: row.node_cost_minor })),
        verification_results: body.verification_results.slice(0, 10).map(row => ({ node_execution_id: row.node_execution_id,
          gate_type: row.gate_type, verdict: row.verdict, score: row.score, threshold: row.threshold,
          details: JSON.stringify(row.details ?? null).slice(0, 500) })),
        recovery_actions: body.recovery_actions.slice(0, 10).map(row => ({ node_execution_id: row.node_execution_id,
          failure_class: row.failure_class, strategy: row.strategy, outcome: row.outcome })),
        outcome: JSON.stringify(body.outcome).slice(0, 500),
        limits: { nodeExecutions: 10, verificationResults: 10, recoveryActions: 10, diagnosticCharacters: 500,
          moreNodeExecutions: body.node_executions.length > 10, moreVerificationResults: body.verification_results.length > 10,
          moreRecoveryActions: body.recovery_actions.length > 10 },
      })) };
  }
}
