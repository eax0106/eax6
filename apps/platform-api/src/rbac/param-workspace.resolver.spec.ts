import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineClient } from "../engine/engine-client";
import {
  CachedEngineResourceLookup,
  ConnectionWorkspaceLookup,
  defaultWorkspaceResolutionRules,
  legacyFlatRules,
  ParamWorkspaceResolver,
  WorkspaceLookupUnavailableError,
  type ResourceWorkspaceLookup,
  type WorkspaceResolutionRule,
} from "./param-workspace.resolver";
import type { PlatformDb } from "../signup/platform-db";
import type { ActorContext, RbacRequest } from "./types";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceA = "ws_018f47a5-7b2c-7d10-8f11-123456789aba";
const workspaceB = "ws_018f47a5-7b2c-7d10-8f11-123456789abb";
const projectId = "prj_018f47a5-7b2c-7d10-8f11-123456789abc";
const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const artifactId = "art_018f47a5-7b2c-7d10-8f11-123456789abc";
const sourceId = "src_018f47a5-7b2c-7d10-8f11-123456789abc";
const documentId = "doc_018f47a5-7b2c-7d10-8f11-123456789abc";
const jobId = "job_018f47a5-7b2c-7d10-8f11-123456789abc";
const triggerId = "trg_018f47a5-7b2c-7d10-8f11-123456789abc";
const approvalId = "apr_018f47a5-7b2c-7d10-8f11-123456789abc";
const escalationId = "esc_018f47a5-7b2c-7d10-8f11-123456789abc";
const clarificationId = "clr_018f47a5-7b2c-7d10-8f11-123456789abc";
const connectionId = "018f47a5-7b2c-7d10-8f11-123456789abd";

function request(
  params: Record<string, string>,
  url = "/test",
): RbacRequest {
  return {
    params,
    url,
    actorContext: actor,
  };
}

const actorWithoutWorkspace: ActorContext = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789ab1",
  tenant_id: tenantId,
  roles: ["admin"],
  permissions: ["approvals:decide"],
  session_id: "sess_x",
  auth_time: 1_789_000_000,
};
const actor = { ...actorWithoutWorkspace, workspace_id: "018f47a5-7b2c-7d10-8f11-123456789ab2" };

function staticLookup(value: string | undefined): ResourceWorkspaceLookup {
  return { getWorkspaceId: async () => value };
}

describe("defaultWorkspaceResolutionRules dispatch", () => {
  // One test swaps this implementation for its own; beforeEach puts this one
  // back, so a later test never inherits the swapped one.
  const engineResponse = async (
    path: string,
  ): Promise<{ status: number; body?: Record<string, unknown> }> => {
    {
      // Workflows and projects answer camelCase, as WorkflowReadService and
      // ProjectReadService really do. This fake used to say `workspace_id`
      // for both, which is why a suite this thorough stayed green while
      // every workflow and project id route answered 403 in a live stack.
      if (path.includes("/workflows/")) return { status: 200, body: { workspaceId: workspaceA } };
      if (path.includes("/projects/")) return { status: 200, body: { workspaceId: workspaceA } };
      if (path.includes("/runs/")) return { status: 200, body: { workspace_id: workspaceB } };
      if (path.includes("/artifacts/")) return { status: 200, body: { workspaceId: workspaceB } };
      if (path.includes("/ads/sources/")) return { status: 200, body: { workspace_id: workspaceA } };
      if (path.includes("/ads/documents/")) return { status: 200, body: { workspace_id: workspaceB } };
      if (path.includes("/ads/ingestion/jobs/")) return { status: 200, body: { workspace_id: workspaceA } };
      if (path.includes("/triggers/")) return { status: 200, body: { workspaceId: workspaceB } };
      if (path.includes("/approvals/")) return { status: 200, body: { workspace_id: workspaceA } };
      if (path.includes("/escalations/")) return { status: 200, body: { workspace_id: workspaceB } };
      if (path.includes("/clarifications/")) return { status: 200, body: { workspace_id: workspaceA } };
      if (path.includes("/events/")) return { status: 200, body: { workspace_id: workspaceB } };
      if (path.endsWith("/missing")) return { status: 404 };
      return { status: 500 };
    }
  };
  const getMock =
    vi.fn<(path: string) => Promise<{ status: number; body?: Record<string, unknown> }>>(
      engineResponse,
    );
  const queryTenantMock = vi.fn<
    (tenantId: string, sql: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>
  >(async () => [{ workspace_id: workspaceA }]);
  const deps = {
    engineClient: { get: getMock } as unknown as EngineClient,
    db: { queryTenant: queryTenantMock } as unknown as PlatformDb,
  };
  const resolver = new ParamWorkspaceResolver(defaultWorkspaceResolutionRules(deps));

  beforeEach(() => {
    getMock.mockClear();
    getMock.mockImplementation(engineResponse);
    queryTenantMock.mockClear();
  });

  it.each([
    ["projects", "/api/v1/projects/p/env-vars", { projectId }, workspaceA],
    ["workflows", "/api/v1/workflows/w/actions/compile", { workflowId: workflowId }, workspaceA],
    ["runs", "/api/v1/runs/r", { runId }, workspaceB],
    ["artifacts", "/api/v1/artifacts/f/download", { artifactId }, workspaceB],
    ["ads sources", "/api/v1/ads/sources/s/permissions", { sourceId }, workspaceA],
    ["ads documents", "/api/v1/ads/documents/d/permissions", { documentId }, workspaceB],
    ["ads ingestion jobs", "/api/v1/ads/ingestion/jobs/j", { jobId }, workspaceA],
    ["triggers (bare id)", "/api/v1/triggers/t/status", { id: triggerId }, workspaceB],
    ["events", "/api/v1/events/e/replay-for-real", { eventId: "evt_018f47a5-7b2c-7d10-8f11-123456789abc" }, workspaceB],
    ["approvals", "/api/v1/approvals/a/actions/approve", { approvalId: approvalId }, workspaceA],
    ["escalations", "/api/v1/escalations/e/actions/claim", { escalationId: escalationId }, workspaceB],
    ["clarifications", "/api/v1/clarifications/c/actions/assign", { clarificationId: clarificationId }, workspaceA],
  ])("resolves %s", async (_label, url, params, expected) => {
    await expect(
      resolver.resolveWorkspaceId(request(params as Record<string, string>, url)),
    ).resolves.toBe(expected);
  });

  it("passes a direct workspaceId param through without any lookup", async () => {
    await expect(
      resolver.resolveWorkspaceId(request({ workspaceId: workspaceA })),
    ).resolves.toBe(workspaceA);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("reads the workspace whichever way the engine spells it", async () => {
    for (const body of [{ workspace_id: workspaceA }, { workspaceId: workspaceA }]) {
      getMock.mockImplementation(async () => ({ status: 200, body }));
      await expect(
        resolver.resolveWorkspaceId(request({ projectId }, `/api/v1/projects/${projectId}`)),
      ).resolves.toBe(workspaceA);
      await expect(
        resolver.resolveWorkspaceId(request({ workflowId }, `/api/v1/workflows/${workflowId}`)),
      ).resolves.toBe(workspaceA);
    }
  });

  it("extracts snake_case workspace_id from run reads and camelCase from trigger reads", async () => {
    await expect(
      resolver.resolveWorkspaceId(request({ runId }, "/api/v1/runs/x")),
    ).resolves.toBe(workspaceB);
    await expect(
      resolver.resolveWorkspaceId(request({ id: triggerId }, "/api/v1/triggers/x")),
    ).resolves.toBe(workspaceB);
  });

  it("maps annotation items by their sibling type param", async () => {
    getMock.mockClear();
    getMock.mockImplementation(async (path: string) =>
      path.includes("/escalations/")
        ? { status: 200, body: { workspace_id: workspaceA } }
        : { status: 404 },
    );

    await expect(
      resolver.resolveWorkspaceId(
        request({ type: "escalation", id: escalationId }, "/api/v1/action-items/escalation/e/annotations"),
      ),
    ).resolves.toBe(workspaceA);
    expect(getMock).toHaveBeenCalledWith(
      `/api/v1/escalations/${escalationId}`,
      expect.objectContaining({ tenantId }),
    );
  });

  it("returns undefined for an unknown annotation type instead of guessing", async () => {
    await expect(
      resolver.resolveWorkspaceId(
        request({ type: "mystery", id: "x" }, "/api/v1/action-items/mystery/x/annotations"),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves connection ids from the local platform_db, not the engine", async () => {
    await expect(
      resolver.resolveWorkspaceId(
        request({ connectionId }, "/api/v1/integrations/connections/c/actions/health"),
      ),
    ).resolves.toBe(workspaceA);
    expect(deps.db.queryTenant).toHaveBeenCalledWith(
      tenantId,
      expect.stringContaining("oauth_connections"),
      expect.anything(),
    );
    expect(getMock).not.toHaveBeenCalledWith(
      expect.stringContaining("connections"),
      expect.anything(),
    );
  });

  it("treats a malformed connection id as missing rather than querying", async () => {
    await expect(
      resolver.resolveWorkspaceId(
        request({ connectionId: "not-a-uuid" }, "/api/v1/integrations/connections/x/health"),
      ),
    ).resolves.toBeUndefined();
    expect(queryTenantMock).not.toHaveBeenCalled(); // beforeEach-cleared; malformed never reaches the DB
  });

  it.each([
    ["an approval", approvalId, workspaceA],
    ["an escalation", escalationId, workspaceB],
    ["a clarification", clarificationId, workspaceA],
  ])("resolves %s addressed by the action centre through its own family", async (_name, id, expected) => {
    await expect(
      resolver.resolveWorkspaceId(request({ actionId: id }, `/api/v1/action-centre/${id}`)),
    ).resolves.toBe(expected);
  });

  it("leaves an action-centre id that names no family unresolved", async () => {
    await expect(
      resolver.resolveWorkspaceId(request({ actionId: runId }, `/api/v1/action-centre/${runId}`)),
    ).resolves.toBeUndefined();
  });

  it("keeps unrelated generic :id routes unbound (documented legacy path)", async () => {
    await expect(
      resolver.resolveWorkspaceId(request({ id: triggerId }, "/api/v1/unrelated-resource/id")),
    ).resolves.toBeUndefined();
  });
});

describe("CachedEngineResourceLookup caching contract", () => {
  it("caches positive results per resource and never re-fetches within TTL", async () => {
    const get = vi.fn(async () => ({ status: 200, body: { workspace_id: workspaceA } }));
    const lookup = new CachedEngineResourceLookup(
      { get } as never,
      (id) => `/api/v1/workflows/${id}`,
      (body) => (typeof body.workspace_id === "string" ? body.workspace_id : undefined),
    );

    await expect(lookup.getWorkspaceId(actor, workflowId)).resolves.toBe(workspaceA);
    await expect(lookup.getWorkspaceId(actor, workflowId)).resolves.toBe(workspaceA);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("collapses 404 to undefined with a short negative cache", async () => {
    const get = vi.fn(async () => ({ status: 404 }));
    const lookup = new CachedEngineResourceLookup(
      { get } as never,
      (id) => `/api/v1/workflows/${id}`,
      (body) => (typeof body.workspace_id === "string" ? body.workspace_id : undefined),
    );

    await expect(lookup.getWorkspaceId(actor, workflowId)).resolves.toBeUndefined();
    await expect(lookup.getWorkspaceId(actor, workflowId)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails closed on non-200/404 and never caches the failure", async () => {
    let status = 503;
    const get = vi.fn(async () => ({
      status,
      body: status === 200 ? { workspace_id: workspaceA } : {},
    }));
    const lookup = new CachedEngineResourceLookup(
      { get } as never,
      (id) => `/api/v1/workflows/${id}`,
      (body) => (typeof body.workspace_id === "string" ? body.workspace_id : undefined),
    );

    await expect(lookup.getWorkspaceId(actor, workflowId)).rejects.toBeInstanceOf(
      WorkspaceLookupUnavailableError,
    );
    status = 200;
    await expect(lookup.getWorkspaceId(actor, workflowId)).resolves.toBe(workspaceA);
  });
});

describe("CachedEngineResourceLookup caller identity", () => {
  it("asks the engine as the caller the guard is authorizing", async () => {
    const get = vi.fn(async () => ({ status: 200, body: { workspace_id: workspaceA } }));
    const lookup = new CachedEngineResourceLookup(
      { get } as never,
      (id) => `/api/v1/approvals/${id}`,
      (body) => (typeof body.workspace_id === "string" ? body.workspace_id : undefined),
    );

    await lookup.getWorkspaceId(actor, approvalId);

    expect(get).toHaveBeenCalledWith(
      `/api/v1/approvals/${approvalId}`,
      expect.objectContaining({
        userId: actor.user_id,
        tenantId: actor.tenant_id,
        workspaceId: actor.workspace_id,
        sessionId: actor.session_id,
        authTime: actor.auth_time,
        roles: actor.roles,
        permissions: actor.permissions,
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      }),
    );
  });

  it("fails closed without calling the engine for an actor with no workspace", async () => {
    const get = vi.fn();
    const lookup = new CachedEngineResourceLookup(
      { get } as never,
      (id) => `/api/v1/approvals/${id}`,
      (body) => (typeof body.workspace_id === "string" ? body.workspace_id : undefined),
    );

    await expect(lookup.getWorkspaceId(actorWithoutWorkspace, approvalId)).rejects.toBeInstanceOf(
      WorkspaceLookupUnavailableError,
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("ConnectionWorkspaceLookup fail-closed contract", () => {
  it("surfaces database failure as WorkspaceLookupUnavailableError, not undefined", async () => {
    const db = {
      queryTenant: vi.fn(async (): Promise<Record<string, unknown>[]> => {
        throw new Error("pool exhausted");
      }),
    };
    const lookup = new ConnectionWorkspaceLookup(db as never);

    await expect(
      lookup.getWorkspaceId(actor, connectionId),
    ).rejects.toBeInstanceOf(WorkspaceLookupUnavailableError);
  });
});

describe("legacy composition", () => {
  it("binds nothing, so the guard keeps its documented flat-role behavior", async () => {
    const resolver = new ParamWorkspaceResolver(legacyFlatRules());

    await expect(
      resolver.resolveWorkspaceId(request({ projectId, workspaceId: workspaceB })),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolveWorkspaceId(request({ id: triggerId }, "/api/v1/triggers/t")),
    ).resolves.toBeUndefined();
  });

  it("accepts custom rule arrays additively", async () => {
    const rules: readonly WorkspaceResolutionRule[] = [
      { paramNames: ["customId"], lookup: staticLookup(workspaceB) },
    ];
    const resolver = new ParamWorkspaceResolver(rules);

    await expect(resolver.resolveWorkspaceId(request({ customId: "c" }))).resolves.toBe(workspaceB);
  });
});
