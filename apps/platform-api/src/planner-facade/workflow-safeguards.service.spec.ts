import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { computeEtag } from "../concurrency";
import { workspaceRolesMetadataKey } from "../rbac/rbac.metadata";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { WorkflowSafeguardsController } from "./workflow-safeguards.controller";
import {
  effectiveSafeguards,
  WorkflowSafeguardsError,
  WorkflowSafeguardsService,
} from "./workflow-safeguards.service";

const TENANT = "018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE = "018f47a5-7b2c-7d10-8f11-123456789def";
const WORKFLOW = "wf_018f47a5-7b2c-7d10-8f11-123456789aaa";
const actor: ActorContext = {
  user_id: "user",
  tenant_id: `ten_${TENANT}`,
  workspace_id: `ws_${WORKSPACE}`,
  roles: ["editor"],
  permissions: [],
  session_id: "session",
};
const none = { customer_visible: false, contains_pii: false, approve_external_actions: false };
const workspaceOn = { contains_pii: true, approve_external_actions: true };

function db(rows: { workspace?: unknown; additions?: unknown }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM workspaces")) return { rows: rows.workspace === undefined ? [] : [{ safeguards: rows.workspace }] };
    if (sql.includes("FROM workflow_safeguards")) {
      return { rows: rows.additions === undefined ? [] : [{ workspace_id: WORKSPACE, additions: rows.additions }] };
    }
    return { rows: [] };
  });
  const withTenant = vi.fn(async (_tenant: string, operation: (client: PoolClient) => Promise<unknown>) =>
    operation({ query } as unknown as PoolClient),
  );
  const audit = { recordEvent: vi.fn().mockResolvedValue({}), getEvent: vi.fn() };
  const service = new WorkflowSafeguardsService(
    { withTenant } as unknown as PlatformDb,
    audit as unknown as AuditEventHandler,
  );
  return { service, query, withTenant, audit };
}

describe("effectiveSafeguards", () => {
  it("is the workspace's safeguards OR the workflow's additions", () => {
    expect(effectiveSafeguards(workspaceOn, none)).toEqual({ ...workspaceOn, customer_visible: false });
    expect(
      effectiveSafeguards(
        { contains_pii: false, approve_external_actions: false },
        { customer_visible: true, contains_pii: true, approve_external_actions: false },
      ),
    ).toEqual({ customer_visible: true, contains_pii: true, approve_external_actions: false });
  });
});

describe("WorkflowSafeguardsService", () => {
  it("reads bare ids within the tenant, with no additions until some are saved", async () => {
    const { service, withTenant, query } = db({ workspace: workspaceOn });
    await expect(service.get(actor, WORKFLOW)).resolves.toEqual({
      workspace: workspaceOn,
      additions: none,
      effective: { ...workspaceOn, customer_visible: false },
    });
    expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.not.stringContaining("FOR UPDATE"), [WORKSPACE, TENANT]);
  });

  it("answers 404 for a malformed workflow id or an actor with no workspace", async () => {
    const { service, withTenant } = db({ workspace: workspaceOn });
    await expect(service.get(actor, "wf_nope")).rejects.toMatchObject({ status: 404 });
    const noWorkspace: ActorContext = { ...actor };
    delete noWorkspace.workspace_id;
    await expect(service.get(noWorkspace, WORKFLOW)).rejects.toMatchObject({ status: 404 });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("fails closed for planning when the workspace or a stored value is unreadable", async () => {
    await expect(db({}).service.effectiveFor(TENANT, WORKSPACE, WORKFLOW)).rejects.toBeInstanceOf(
      WorkflowSafeguardsError,
    );
    await expect(
      db({ workspace: workspaceOn, additions: { customer_visible: "yes" } }).service.effectiveFor(
        TENANT,
        WORKSPACE,
        WORKFLOW,
      ),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("writes under both row locks and audits before and after", async () => {
    const { service, query, audit } = db({ workspace: workspaceOn });
    const view = { workspace: workspaceOn, additions: none, effective: { ...workspaceOn, customer_visible: false } };
    const additions = { ...none, customer_visible: true };

    const saved = await service.set(actor, WORKFLOW, { additions }, computeEtag(view));

    expect(saved.effective).toEqual({ ...workspaceOn, customer_visible: true });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM workspaces .*FOR UPDATE/), [WORKSPACE, TENANT]);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM workflow_safeguards .*FOR UPDATE/), [
      TENANT,
      WORKFLOW,
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO workflow_safeguards"), [
      TENANT,
      WORKSPACE,
      WORKFLOW,
      JSON.stringify(additions),
    ]);
    expect(audit.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        action: "workflow.safeguards.update",
        target_type: "workflow",
        target_ref: WORKFLOW,
        context_json: JSON.stringify({ scope: { before: none, after: additions } }),
      }),
    );
  });

  it.each([
    [{ additions: { customer_visible: true } }],
    [{ additions: { ...none, verification_required: true } }],
    [{ additions: { ...none, contains_pii: "true" } }],
    [{ safeguards: none }],
  ])("rejects a body that is not exactly the three additions: %j", async (body) => {
    const { service, withTenant } = db({ workspace: workspaceOn });
    await expect(service.set(actor, WORKFLOW, body, '"etag"')).rejects.toMatchObject({ status: 400 });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("requires If-Match and rejects a stale one without writing", async () => {
    const missing = db({ workspace: workspaceOn });
    await expect(missing.service.set(actor, WORKFLOW, { additions: none }, undefined)).rejects.toMatchObject({
      status: 428,
    });
    expect(missing.withTenant).not.toHaveBeenCalled();

    const stale = db({ workspace: workspaceOn });
    await expect(stale.service.set(actor, WORKFLOW, { additions: none }, '"stale"')).rejects.toMatchObject({
      status: 412,
    });
    expect(stale.query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT"), expect.anything());
    expect(stale.audit.recordEvent).not.toHaveBeenCalled();
  });
});

describe("WorkflowSafeguardsController", () => {
  it("forwards reads and writes, and lets only planners write", async () => {
    const get = vi.fn().mockResolvedValue({});
    const set = vi.fn().mockResolvedValue({});
    const controller = new WorkflowSafeguardsController({ get, set } as unknown as WorkflowSafeguardsService);
    const body = { additions: none };

    await controller.get(WORKFLOW, actor);
    await controller.set(WORKFLOW, body, '"etag"', actor);

    expect(get).toHaveBeenCalledWith(actor, WORKFLOW);
    expect(set).toHaveBeenCalledWith(actor, WORKFLOW, body, '"etag"');
    expect(Reflect.getMetadata(workspaceRolesMetadataKey, WorkflowSafeguardsController.prototype.set)).toEqual([
      "admin",
      "editor",
    ]);
    expect(Reflect.getMetadata(workspaceRolesMetadataKey, WorkflowSafeguardsController.prototype.get)).toEqual([
      "admin",
      "editor",
      "operator",
      "approver",
      "viewer",
    ]);
  });
});
