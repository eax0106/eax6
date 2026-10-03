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
import type { WorkflowSafeguardsService } from "../planner-facade/workflow-safeguards.service";

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
  it("compares models without outside-action rules and rereads rules for proposed outside tools", async () => {
    const engine = engineStub();
    const effectiveFor = vi.fn().mockResolvedValue({ approve_external_actions: true, customer_visible: false });
    const service = new WorkflowService(engine.value, { effectiveFor } as unknown as WorkflowSafeguardsService);
    const dag = outsideDag();
    dag.nodes[2]!.config = { tool_name: "search.web" };
    const comparison = { nodeKey: "send", choice: { kind: "model", value: "STANDARD" }, approval_required: true,
      original: { choice: null, selection: null }, candidate: null, warnings: [],
      cost: { currency: "INR", before_minor: null, after_minor: null }, validation: { valid: true, errors: [] }, data_contract: null };
    engine.post.mockResolvedValue({ status: 200, body: comparison });
    expect(await service.compareNodeOverride(workflowId, { nodeKey: "send", choice: { kind: "model", value: "STANDARD" }, dag }, actor, traceparent, "model")).toEqual(comparison);
    expect(effectiveFor).not.toHaveBeenCalled();
    expect(engine.post).toHaveBeenLastCalledWith(`/api/v1/workflows/${workflowId}/node-overrides/compare`,
      { nodeKey: "send", choice: { kind: "model", value: "STANDARD" }, dag }, expectedContext(), { idempotencyKey: "model" });
    const choice = { kind: "tool", value: "email.send" } as const;
    engine.post.mockResolvedValue({ status: 200, body: { ...comparison, choice } });
    await service.compareNodeOverride(workflowId, { nodeKey: "send", choice, dag }, actor, traceparent, "tool");
    expect(effectiveFor).toHaveBeenCalledWith(actor.tenant_id, actor.workspace_id, workflowId);
    expect(engine.post).toHaveBeenLastCalledWith(`/api/v1/workflows/${workflowId}/node-overrides/compare`,
      { nodeKey: "send", choice, dag, overrideSafeguards: { approval_required: true } }, expectedContext(), { idempotencyKey: "tool" });
  });

  it("refuses outside changes when current safeguards cannot be read", async () => {
    const engine = engineStub();
    const service = new WorkflowService(engine.value);
    await expect(service.saveCanvas(workflowId, { dag: outsideDag() }, actor, traceparent, "save", '"etag"'))
      .rejects.toMatchObject({ response: expect.objectContaining({ error_code: "OVERRIDE_SAFEGUARDS_UNAVAILABLE", status: 400 }) });
    expect(engine.patch).not.toHaveBeenCalled();
    expect(engine.post).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
  ])("uses current workspace/workflow approval rules for a manual outside choice (%s, %s)", async (approveExternal, customerVisible, required) => {
    const engine = engineStub();
    const effectiveFor = vi.fn().mockResolvedValue({ approve_external_actions: approveExternal, customer_visible: customerVisible, contains_pii: false });
    const service = new WorkflowService(engine.value, { effectiveFor } as unknown as WorkflowSafeguardsService);
    const dag = outsideDag();
    // The submitted snapshot carries the opposite rule. Only the current
    // workspace/workflow setting decides whether an approval step is needed.
    dag.nodes[2]!.metadata.override_safeguards = { approval_required: !required };
    if (required) {
      await expect(service.saveCanvas(workflowId, { dag }, actor, traceparent, "save", '"etag"')).rejects.toThrow(WorkflowHttpError);
      expect(engine.patch).not.toHaveBeenCalled();
    } else {
      await service.saveCanvas(workflowId, { dag }, actor, traceparent, "save", '"etag"');
      expect(engine.patch).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}`, expect.objectContaining({ overrideSafeguards: { approval_required: false }, dag: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ key: "send", metadata: expect.objectContaining({ override_safeguards: { approval_required: false } }) })]) }) }), expectedContext(), { idempotencyKey: "save", ifMatch: '"etag"' });
    }
    expect(effectiveFor).toHaveBeenCalledWith(actor.tenant_id, actor.workspace_id, workflowId);
    effectiveFor.mockClear();
    engine.get.mockResolvedValue({ status: 200, body: { dag } });
    await service.action(workflowId, "compile", {}, actor, traceparent, "compile");
    expect(effectiveFor).toHaveBeenCalledOnce();
    expect(engine.post).toHaveBeenCalledWith(`/api/v1/workflows/${workflowId}/actions/compile`, { overrideSafeguards: { approval_required: required } }, expectedContext(), { idempotencyKey: "compile" });
  });

  it("keeps the normal verification boundary when approval is disabled", async () => {
    const engine = engineStub();
    const effectiveFor = vi.fn().mockResolvedValue({ approve_external_actions: false, customer_visible: false, contains_pii: false });
    const service = new WorkflowService(engine.value, { effectiveFor } as unknown as WorkflowSafeguardsService);
    const dag = outsideDag();
    delete dag.nodes[1]!.config.verification;
    await expect(service.saveCanvas(workflowId, { dag }, actor, traceparent, "save", '"etag"')).rejects.toThrow(WorkflowHttpError);
    expect(engine.patch).not.toHaveBeenCalled();
  });
  it("reads scoped workflow health and preserves list pagination", async () => {
    const engine = engineStub(), service = new WorkflowService(engine.value);
    const dimension = { score: null, status: "not_enough_data", summary: "No recorded evidence", observations: 0, passed: 0 };
    const health = { workflowId, overallScore: null, status: "not_enough_data", dimensions: { validation: dimension, availability: dimension, correctness: dimension, reliability: dimension }, recentFailures: 0, degradedRuns: 0, lastEvaluatedAt: "2026-10-03T12:00:00.000Z", window: { startAt: "2026-09-26T12:00:00.000Z", endAt: "2026-10-03T12:00:00.000Z", maximumRuns: 20, sampledRuns: 0 } };
    const page = { next_cursor: "next cursor", has_more: true, limit: 1 };
    engine.get.mockResolvedValueOnce({ status: 200, body: { data: [{ id: workflowId }], page } }).mockResolvedValue({ status: 200, body: health });
    expect(await service.healths("prior", "1", actor, traceparent)).toEqual({ data: [health], page });
    expect(engine.get).toHaveBeenNthCalledWith(1, "/api/v1/workflows?cursor=prior&limit=1", expectedContext());
    expect(engine.get).toHaveBeenNthCalledWith(2, `/api/v1/workflows/${workflowId}/health`, expectedContext());
    await expect(service.health("invalid", actor, traceparent)).rejects.toThrow(WorkflowHttpError);
    const unscoped = { ...actor }; delete unscoped.workspace_id;
    await expect(service.health(workflowId, unscoped, traceparent)).rejects.toThrow(WorkflowHttpError);
    engine.get.mockResolvedValue({ status: 200, body: { ...health, overallScore: 101 } });
    await expect(service.health(workflowId, actor, traceparent)).rejects.toThrow();
  });

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

function outsideDag(): CompiledDag {
  return {
    schema_version: "v1", entry_node_keys: ["start"],
    nodes: [
      { key: "start", type: "LLMTask", config: { model_alias: "FAST" }, metadata: { ui: {} } },
      { key: "verify", type: "Gate", config: { verification: { source_node_key: "start", protected_node_key: "send", policy: "provisional-quality-pass-and-noncritical-safety" } }, metadata: { ui: {} } },
      { key: "send", type: "ToolCall", config: { tool_name: "email.send", manual_tool_override: true }, metadata: { ui: {} } },
    ],
    edges: [
      { key: "prepare", from: "start", to: "verify", kind: "sequential" },
      { key: "send-after-verification", from: "verify", to: "send", kind: "conditional", condition: { expression: "true", language: "cel" } },
    ],
    waves: [
      { key: "first", order: 0, node_keys: ["start"], depends_on: [] },
      { key: "verification", order: 1, node_keys: ["verify"], depends_on: ["first"] },
      { key: "last", order: 2, node_keys: ["send"], depends_on: ["verification"] },
    ],
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
