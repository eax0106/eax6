import {
  InstantiateWorkflowTemplateRequestSchema, TenantIdSchema, UserIdSchema, WorkspaceIdSchema,
  type ConnectionRegistrySnapshot, type ConnectionsRequired, type InstantiateWorkflowTemplateResult, type WorkflowTemplateSummary,
} from "@alterx/contracts";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";

import { CompilerConnectionsRequiredError } from "../connections/connection-preflight";
import { GraphCompilerService } from "../compiler/graph-compiler.service";
import type { OrchestrationTenantStore } from "../project-read/project-read.service";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowChatService } from "../workflow-chat/workflow-chat.service";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { bindTemplateSkeleton } from "./template-skeleton";
import type { WorkflowTemplateRegistry } from "./template-registry.client";

type MissingConnection = ConnectionsRequired["missing_connections"][number];
type Actor = NonNullable<IdentityTenantGatewayRequest["actorContext"]>;

export class WorkflowTemplateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/**
 * D18: starting a workflow from an Alter-authored template. The template's
 * reviewed skeleton is compiled as it stands into a new draft workflow, which
 * gets its chat like any other workflow (D6); from there the chat changes it.
 * Instantiating never activates or runs anything. When the workspace lacks a
 * connection the template needs, the workflow and chat still exist and the
 * caller retries with the workflow id once it is connected.
 */
export class WorkflowTemplatesService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly registry: WorkflowTemplateRegistry,
    private readonly chats: WorkflowChatService,
    private readonly environment: string,
  ) {}

  list(): Promise<WorkflowTemplateSummary[]> {
    return this.registry.list();
  }

  async instantiate(actor: Actor, templateId: string, body: unknown): Promise<InstantiateWorkflowTemplateResult> {
    const input = InstantiateWorkflowTemplateRequestSchema.parse(body ?? {});
    const s = scope(actor);
    const template = await this.registry.get(templateId);
    const workflowId = input.workflowId === undefined
      ? (await new WorkflowReadService(this.store).createWorkflow({
          tenantId: `ten_${s.tenant}`, workspaceId: `ws_${s.workspace}`, name: template.title, createdBy: `usr_${s.user}`,
        })).id
      : await this.requireRetryable(s, input.workflowId, template.template_id);
    const chatId = `cnv_${workflowId.slice(3)}`;
    const origin = { templateId: template.template_id, templateVersion: template.version };

    const connections = await this.store.withTenant(s.tenant, async (tx) => (await tx.query<ConnectionRegistrySnapshot>(
      "SELECT tenant_id, workspace_id, connection_id, connector_type, status, secret_ref, source_revision FROM connection_registry WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY connector_type, connection_id",
      [s.tenant, s.workspace],
    )).rows);
    const bound = bindTemplateSkeleton(template.skeleton, { tenantId: `ten_${s.tenant}`, environment: this.environment }, connections);
    let missing: MissingConnection[] = bound.missing;
    let versionId: string | undefined;
    if (missing.length === 0) {
      try {
        versionId = (await new GraphCompilerService(this.store).compileWorkflow({
          tenant_id: `ten_${s.tenant}`, workflow_id: workflowId,
          task_skeleton_json: JSON.stringify(bound.skeleton), dag_schema_version: "v1",
        })).workflow_version_id;
      } catch (error: unknown) {
        if (!(error instanceof CompilerConnectionsRequiredError)) {
          // The workflow and chat exist; the note lets the caller retry into them.
          await this.note(s, chatId, workflowId, "action", { ...origin, type: "template_failed",
            text: `The "${template.title}" template could not be compiled. Try it again from here.` });
          throw error;
        }
        missing = error.result.missing_connections;
      }
    }

    const conversation = await this.chats.get(actor, chatId);
    if (versionId === undefined) {
      await this.note(s, chatId, workflowId, "action", {
        ...origin, type: "connections_required", missing_connections: missing,
        text: `Created from the "${template.title}" template. Connect ${missing.map((gap) => gap.connector_type).join(", ")}, then use the template again to compile it.`,
      });
      return { status: "connections_required", ...origin, workflowId, conversation, missingConnections: missing };
    }
    await this.note(s, chatId, workflowId, "workflow", {
      ...origin, workflowId, versionId,
      text: `Created from the "${template.title}" template and compiled as a draft. Review its steps and success criteria here, then test it before activating.`,
    });
    return { status: "compiled", ...origin, workflowId, conversation, versionId };
  }

  /** A retry compiles only into an uncompiled workflow this template created. */
  private async requireRetryable(s: Scope, workflowId: string, templateId: string): Promise<string> {
    return this.store.withTenant(s.tenant, async (tx) => {
      const row = (await tx.query<{ versions: string; from_template: boolean }>(
        `SELECT (SELECT count(*) FROM workflow_versions v WHERE v.tenant_id=w.tenant_id AND v.workflow_id=w.id) AS versions,
                EXISTS (SELECT 1 FROM conversation_messages m WHERE m.tenant_id=w.tenant_id AND m.workspace_id=w.workspace_id
                        AND m.conversation_id='cnv_' || substring(w.id FROM 4) AND m.role='system'
                        AND m.content_json->>'templateId'=$4) AS from_template
         FROM workflows w WHERE w.tenant_id=$1 AND w.workspace_id=$2 AND w.id=$3`,
        [s.tenant, s.workspace, workflowId, templateId],
      )).rows[0];
      if (row === undefined) throw new WorkflowTemplateError(404, "WORKFLOW_NOT_FOUND", "Workflow was not found");
      if (!row.from_template) throw new WorkflowTemplateError(409, "TEMPLATE_WORKFLOW_MISMATCH", "This workflow was not created from this template");
      if (Number(row.versions) > 0) throw new WorkflowTemplateError(409, "TEMPLATE_ALREADY_COMPILED", "This workflow already has a compiled version; change it in its chat");
      return workflowId;
    });
  }

  /** One system message per template attempt, recorded in the workflow's chat. */
  private async note(s: Scope, chatId: string, workflowId: string, kind: "action" | "workflow", content: Record<string, unknown>): Promise<void> {
    await this.store.withTenant(s.tenant, async (tx) => {
      await tx.query(
        `INSERT INTO conversation_messages(id,tenant_id,workspace_id,conversation_id,role,kind,content_json,request_key)
         VALUES($1,$2,$3,$4,'system',$5,$6::jsonb,$7) ON CONFLICT(tenant_id,conversation_id,request_key) DO NOTHING`,
        [`msg_${uuidV7()}`, s.tenant, s.workspace, chatId, kind, JSON.stringify(content), `template:${workflowId}:${uuidV7()}`],
      );
      await tx.query("UPDATE conversations SET last_activity_at=clock_timestamp() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [s.tenant, s.workspace, chatId]);
    });
  }
}

type Scope = { tenant: string; workspace: string; user: string };

function scope(actor: Actor): Scope {
  const tenant = TenantIdSchema.parse(actor.tenant_id.startsWith("ten_") ? actor.tenant_id : `ten_${actor.tenant_id}`).slice(4);
  const workspace = WorkspaceIdSchema.parse(actor.workspace_id?.startsWith("ws_") ? actor.workspace_id : `ws_${actor.workspace_id}`).slice(3);
  const user = UserIdSchema.parse(actor.user_id?.startsWith("usr_") ? actor.user_id : `usr_${actor.user_id}`).slice(4);
  return { tenant, workspace, user };
}
