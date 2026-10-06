import { Inject, Injectable } from "@nestjs/common";
import {
  InstantiateWorkflowTemplateRequestSchema, InstantiateWorkflowTemplateResultSchema, WorkflowTemplateIdSchema, WorkflowTemplateSummarySchema,
  type InstantiateWorkflowTemplateResult, type WorkflowTemplateSummary,
} from "@alterx/contracts";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { EngineClient, type EnginePath, type EngineRequestBody } from "../engine";
import type { ActorContext } from "../rbac/types";
import { workflowCallerContext } from "../workflows/workflow.service";
import { WorkflowHttpError } from "../workflows/problem";
import { parseWorkflowInput } from "../workflows/validation";

export const WORKFLOW_TEMPLATES_AUDIT_CLIENT = Symbol("WORKFLOW_TEMPLATES_AUDIT_CLIENT");

/**
 * D18 starter templates, relayed to the engine with the member's own
 * identity: the engine reads the Capability Registry, creates the draft
 * workflow and chat in the member's workspace, and compiles the template.
 */
@Injectable()
export class PlatformWorkflowTemplatesService {
  constructor(private readonly engine: EngineClient, @Inject(WORKFLOW_TEMPLATES_AUDIT_CLIENT) private readonly audit: AuditEventHandler) {}

  async list(actor: ActorContext, traceparent?: string): Promise<WorkflowTemplateSummary[]> {
    const path: EnginePath = "/api/v1/workflow-templates";
    const result = await this.engine.get<unknown[]>(path, workflowCallerContext(actor, traceparent, path));
    return WorkflowTemplateSummarySchema.array().parse(result.body);
  }

  async instantiate(templateId: string, body: unknown, actor: ActorContext, traceparent: string | undefined, key: string): Promise<InstantiateWorkflowTemplateResult> {
    const binding = actor.workspaceRoles?.find(row => row.workspaceId.replace(/^ws_/, "") === actor.workspace_id?.replace(/^ws_/, ""));
    if (!binding || !["admin", "editor"].includes(binding.role)) {
      throw new WorkflowHttpError(403, "TEMPLATE_WORKSPACE_ROLE_REQUIRED", "Edit rights in this workspace are required", "/api/v1/workflow-templates");
    }
    const id = parseWorkflowInput(WorkflowTemplateIdSchema, templateId, "/api/v1/workflow-templates");
    const path: EnginePath = `/api/v1/workflow-templates/${encodeURIComponent(id)}/instantiate`;
    const input = parseWorkflowInput(InstantiateWorkflowTemplateRequestSchema, body ?? {}, path);
    const result = await this.engine.post(path, input as EngineRequestBody, workflowCallerContext(actor, traceparent, path), { idempotencyKey: key, timeoutMs: 30000 });
    const parsed = InstantiateWorkflowTemplateResultSchema.parse(result.body);
    await this.audit.recordEvent({
      tenant_id: actor.tenant_id,
      actor_type: "user",
      actor_ref: actor.user_id,
      action: "workflow.template.instantiate",
      target_type: "workflow",
      target_ref: parsed.workflowId,
      result: "success",
      reason_code: parsed.status,
      context_json: JSON.stringify({ templateId: parsed.templateId, templateVersion: parsed.templateVersion, retry: input.workflowId !== undefined,
        ...(parsed.status === "compiled" ? { versionId: parsed.versionId } : { missingConnections: parsed.missingConnections.map((gap) => gap.connector_type) }) }),
      occurred_at: new Date().toISOString(),
    });
    return parsed;
  }
}
