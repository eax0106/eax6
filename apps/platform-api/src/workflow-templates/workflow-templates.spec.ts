import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { EngineClient } from "../engine";
import { workspaceRolesMetadataKey } from "../rbac/rbac.metadata";
import type { ActorContext } from "../rbac/types";
import { PlatformWorkflowTemplatesController } from "./workflow-templates.controller";
import { PlatformWorkflowTemplatesService } from "./workflow-templates.service";

const id = (prefix: string, n = 1) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
const time = "2026-10-06T12:00:00.000Z";
const actor: ActorContext = { user_id: id("usr"), tenant_id: id("ten"), workspace_id: id("ws"), roles: ["editor"], workspaceRoles: [{ workspaceId: id("ws"), role: "editor" }], permissions: [], session_id: "tpl", auth_time: 1 };
const conversation = { id: id("cnv"), title: "Weekly report digest by email", type: "workflow_builder", status: "active", createdAt: time, updatedAt: time, linkedWorkflowId: id("wf") };
const summary = { template_id: "weekly-report-digest", version: 1, title: "Weekly report digest by email", summary: "Digest.", requirements: [] };

function fixture(body: unknown) {
  const engine = { get: vi.fn(async () => ({ status: 200, body: [summary] })), post: vi.fn(async () => ({ status: 201, body })) };
  const audit = { recordEvent: vi.fn(async () => ({})) };
  return { engine, audit, service: new PlatformWorkflowTemplatesService(engine as unknown as EngineClient, audit as never) };
}

describe("workflow templates relay", () => {
  it("lists templates through the engine with the member's identity", async () => {
    const f = fixture({});
    await expect(f.service.list(actor, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).resolves.toEqual([summary]);
    expect(f.engine.get).toHaveBeenCalledWith("/api/v1/workflow-templates", expect.objectContaining({ userId: actor.user_id, tenantId: actor.tenant_id, workspaceId: actor.workspace_id }));
  });

  it("instantiates with the caller's identity and idempotency key and audits the result", async () => {
    const f = fixture({ status: "compiled", templateId: "weekly-report-digest", templateVersion: 1, workflowId: id("wf"), conversation, versionId: id("wfv") });
    const result = await f.service.instantiate("weekly-report-digest", {}, actor, undefined, "key-1");
    expect(result).toMatchObject({ status: "compiled", workflowId: id("wf") });
    expect(f.engine.post).toHaveBeenCalledWith("/api/v1/workflow-templates/weekly-report-digest/instantiate", {},
      expect.objectContaining({ userId: actor.user_id, workspaceId: actor.workspace_id }), expect.objectContaining({ idempotencyKey: "key-1" }));
    expect(f.audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: actor.tenant_id, actor_ref: actor.user_id, action: "workflow.template.instantiate", target_type: "workflow", target_ref: id("wf"), reason_code: "compiled",
    }));
    expect(JSON.parse((f.audit.recordEvent.mock.calls[0] as unknown as [{ context_json: string }])[0].context_json)).toEqual({ templateId: "weekly-report-digest", templateVersion: 1, retry: false, versionId: id("wfv") });
  });

  it("audits a connections-required result with the connectors it named", async () => {
    const f = fixture({ status: "connections_required", templateId: "lead-capture-crm-welcome", templateVersion: 1, workflowId: id("wf"), conversation,
      missingConnections: [{ connector_type: "postgres", node_keys: ["save_lead"], reason: "missing" }] });
    await f.service.instantiate("lead-capture-crm-welcome", { workflowId: id("wf") }, actor, undefined, "key-2");
    expect(f.audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ reason_code: "connections_required",
      context_json: JSON.stringify({ templateId: "lead-capture-crm-welcome", templateVersion: 1, retry: true, missingConnections: ["postgres"] }) }));
  });

  it("refuses a malformed template id or body before calling the engine", async () => {
    const f = fixture({});
    await expect(f.service.instantiate("../runs", {}, actor, undefined, "k")).rejects.toMatchObject({ status: 400 });
    await expect(f.service.instantiate("knowledge-qa", { workflowId: "not-an-id" }, actor, undefined, "k")).rejects.toMatchObject({ status: 400 });
    expect(f.engine.post).not.toHaveBeenCalled();
    expect(f.audit.recordEvent).not.toHaveBeenCalled();
  });

  it("does not audit when the engine refuses", async () => {
    const f = fixture({});
    f.engine.post.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    await expect(f.service.instantiate("knowledge-qa", {}, actor, undefined, "k")).rejects.toThrow("not found");
    expect(f.audit.recordEvent).not.toHaveBeenCalled();
  });

  it("lets every workspace role list templates and only admins and editors instantiate", () => {
    const roles = (name: "list" | "instantiate") => Reflect.getMetadata(workspaceRolesMetadataKey, PlatformWorkflowTemplatesController.prototype[name]);
    expect(roles("list")).toEqual(["admin", "editor", "operator", "approver", "viewer"]);
    expect(roles("instantiate")).toEqual(["admin", "editor"]);
  });
});
