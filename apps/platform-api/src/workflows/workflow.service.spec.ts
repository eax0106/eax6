import { WorkflowHttpError } from "./problem";
import type { CompiledDag } from "@alterx/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  EngineCallerContext,
  EngineClient,
  EngineResponse,
} from "../engine";
import type { ActorContext } from "../rbac/types";
import { WorkflowService } from "./workflow.service";

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
const traceparent =
  "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
const actor: ActorContext = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["editor"],
  permissions: ["workflows:write"],
};

describe("WorkflowService", () => {
  it("relays approval policies with the caller and exact precondition", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    await service.approvalPolicies(workflowId, actor, traceparent);
    expect(engine.get).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}/approval-policies`, expectedContext());
    const input = { mode: "auto" as const, skip_on_timeout: true, timeout_seconds: 120, confirm_consequence: "this will send emails without asking" };
    await service.setApprovalPolicy(workflowId, "approval.send", input, actor, traceparent, "policy-key", '"step-etag"');
    expect(engine.put).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}/approval-policies/approval.send`, input, expectedContext(), { idempotencyKey: "policy-key", ifMatch: '"step-etag"' });
    expect(() => service.approvalPolicies("invalid", actor, traceparent)).toThrow(WorkflowHttpError);
    expect(() => service.setApprovalPolicy(workflowId, "../outside", input, actor, traceparent, "key", '"etag"')).toThrow(WorkflowHttpError);
    const unscoped = { ...actor };
    delete unscoped.workspace_id;
    expect(() => service.approvalPolicies(workflowId, unscoped, traceparent)).toThrow(WorkflowHttpError);
    expect(engine.put).toHaveBeenCalledTimes(1);
  });

  it("creates workflow through typed Engine client with caller context", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);

    await service.create({ goal: "Process invoices" }, actor, traceparent, "key-1");

    expect(engine.post).toHaveBeenCalledWith(
      "/api/v1/workflows",
      { goal: "Process invoices" },
      expectedContext(),
      { idempotencyKey: "key-1" },
    );
  });

  it("gets workflow and versions with encoded query", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);

    await service.get(workflowId, actor, traceparent);
    await service.versions(workflowId, "next cursor", "25", actor, traceparent);

    expect(engine.get).toHaveBeenNthCalledWith(
      1,
      `/api/v1/workflows/${workflowId}`,
      expectedContext(),
    );
    expect(engine.get).toHaveBeenNthCalledWith(
      2,
      `/api/v1/workflows/${workflowId}/versions?cursor=next+cursor&limit=25`,
      expectedContext(),
    );
  });

  it("lists workflows through real Engine HTTP route", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    await service.list("next cursor", "25", actor, traceparent);
    expect(engine.get).toHaveBeenCalledWith(
      "/api/v1/workflows?cursor=next+cursor&limit=25",
      expectedContext(),
    );
  });

  it("adds the name search to the engine list query (task B3.4)", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    await service.list(undefined, "5", actor, traceparent, " a&b ");
    expect(engine.get).toHaveBeenCalledWith("/api/v1/workflows?limit=5&q=a%26b", expectedContext());
    expect(() => service.list(undefined, undefined, actor, traceparent, "   ")).toThrow(WorkflowHttpError);
    expect(() => service.list(undefined, undefined, actor, traceparent, "x".repeat(201))).toThrow(WorkflowHttpError);
    expect(engine.get).toHaveBeenCalledTimes(1);
  });

  it("saves full canvas DAG with concurrency headers", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    const dag = workflowDag();

    await service.saveCanvas(
      workflowId,
      { dag },
      actor,
      traceparent,
      "save-key",
      '"etag-1"',
    );

    expect(engine.patch).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}`,
      { dag },
      expectedContext(),
      { idempotencyKey: "save-key", ifMatch: '"etag-1"' },
    );
  });

  it.each([
    ["validate", {}],
    ["compile", {}],
    ["simulate", { input: { invoice_id: "inv-1" } }],
    ["activate", {}],
    ["pause", {}],
    ["resume", {}],
  ] as const)("relays %s action without reshaping", async (action, body) => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);

    await service.action(
      workflowId,
      action,
      body,
      actor,
      traceparent,
      `${action}-key`,
    );

    expect(engine.post).toHaveBeenCalledWith(
      `/api/v1/workflows/${workflowId}/actions/${action}`,
      body,
      expectedContext(),
      { idempotencyKey: `${action}-key` },
    );
  });

  it("relays deployment actions and template variables to Engine", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    const versionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";

    await service.promoteVersion(
      workflowId,
      { workflowVersionId: versionId },
      actor,
      traceparent,
      "promote-key",
    );
    await service.startCanary(
      workflowId,
      { workflowVersionId: versionId, trafficPercent: 10 },
      actor,
      traceparent,
      "canary-key",
    );
    await service.rollback(
      workflowId,
      { workflowVersionId: versionId },
      actor,
      traceparent,
      "rollback-key",
    );
    await service.replaceTemplateVariables(
      workflowId,
      { definitions: [{ name: "region", value_type: "text", required: true }] },
      actor,
      traceparent,
      "definitions-key",
    );
    await service.setTemplateVariableValue(
      workflowId,
      "region",
      { value: "us-east-1" },
      actor,
      traceparent,
      "value-key",
    );

    expect(engine.post).toHaveBeenNthCalledWith(
      1,
      `/api/v1/workflows/${workflowId}/actions/promote-version`,
      { workflowVersionId: versionId },
      expectedContext(),
      { idempotencyKey: "promote-key" },
    );
    expect(engine.post).toHaveBeenNthCalledWith(
      2,
      `/api/v1/workflows/${workflowId}/actions/start-canary`,
      { workflowVersionId: versionId, trafficPercent: 10 },
      expectedContext(),
      { idempotencyKey: "canary-key" },
    );
    expect(engine.put).toHaveBeenNthCalledWith(
      1,
      `/api/v1/workflows/${workflowId}/template-variables`,
      { definitions: [{ name: "region", value_type: "text", required: true }] },
      expectedContext(),
      { idempotencyKey: "definitions-key" },
    );
  });

  it("generates trace context and requires workspace context", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    const {
      auth_time: _authTime,
      workspace_id: workspaceId,
      ...requiredActor
    } = actor;
    void _authTime;
    await service.get(
      workflowId,
      { ...requiredActor, workspace_id: workspaceId! },
      undefined,
    );
    expect(engine.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        traceparent: expect.stringMatching(
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        ),
        authTime: expect.any(Number),
      }),
    );

    expect(() =>
      service.get(workflowId, requiredActor, traceparent),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        response: expect.objectContaining({
          error_code: "WORKFLOW_WORKSPACE_REQUIRED",
        }),
      }),
    );
  });
});

function workflowDag(): CompiledDag {
  return {
    schema_version: "1",
    entry_node_keys: ["start"],
    nodes: [
      {
        key: "start",
        type: "LLMTask",
        config: { prompt: "Process invoice" },
        metadata: {
          ui: { position: { x: 120, y: 240 }, collapsed: false },
        },
      },
    ],
    edges: [],
    waves: [
      {
        key: "wave-1",
        order: 0,
        node_keys: ["start"],
        depends_on: [],
      },
    ],
  };
}

function expectedContext(): EngineCallerContext {
  return {
    userId: actor.user_id,
    tenantId: actor.tenant_id,
    workspaceId: actor.workspace_id!,
    sessionId: actor.session_id,
    authTime: actor.auth_time!,
    roles: actor.roles,
    permissions: actor.permissions,
    traceparent,
  };
}

function engineStub(): {
  value: EngineClient;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const response: EngineResponse<Readonly<Record<string, never>>> = {
    status: 200,
    body: {},
  };
  const get = vi.fn().mockResolvedValue(response);
  const post = vi.fn().mockResolvedValue(response);
  const patch = vi.fn().mockResolvedValue(response);
  const put = vi.fn().mockResolvedValue(response);
  return {
    value: { get, post, patch, put } as unknown as EngineClient,
    get,
    post,
    patch,
    put,
  };
}
