import { describe, expect, it, vi } from "vitest";

import {
  ModelInvocationPayloadSchema,
  type RootCauseEstimate,
} from "@alterx/contracts";

import {
  RecoveryDispatchService,
  type CapabilityResolverHandler,
  type GraphCompilerHandler,
  type NodeRetrySignaler,
  type PlannerReplanHandler,
  type RecoveryRunReader,
  type SelectionBindingHandler,
} from "./recovery-dispatch.service";
import { DISPATCHABLE_STRATEGIES, type RecoveryStrategy } from "./recovery-strategy-table";

const ALL_STRATEGIES: readonly RecoveryStrategy[] = [
  "repair",
  "retry",
  "backoff",
  "swap_agent",
  "escalate_model",
  "recompile",
  "replan",
  "degrade",
  "ask_user",
  "terminate",
];

const ESTIMATE: RootCauseEstimate = {
  schema_version: "heal5.v1",
  failure_class: "logic_output_failure",
  explanation: "test explanation",
  confidence: 0.8,
  evidence: ["evidence one"],
  node_attempt: 1,
  model_alias: "ADVANCED",
  resolved_capability: "ADVANCED:test",
};

const CONTEXT = {
  tenantId: "018f47a5-7b2c-7d10-8f11-123456789abc",
  runId: "run_018f47a5-7b2c-7d10-8f11-123456789abc",
  nodeExecutionId: "node_018f47a5-7b2c-7d10-8f11-123456789abc",
  nodeKey: "failed_node",
  failureClass: "logic_output_failure",
  estimate: ESTIMATE,
  recoveryActionId: "rec_018f47a5-7b2c-7d10-8f11-123456789abc",
};

function buildService(overrides: {
  invoke?: (request: unknown) => Promise<unknown>;
  compileWorkflow?: GraphCompilerHandler["compileWorkflow"];
  replan?: PlannerReplanHandler["replan"];
  createPending?: (request: unknown) => Promise<{ readonly id: string; readonly expiryAt: string }>;
  loadCompiledDagJson?: RecoveryRunReader["loadCompiledDagJson"];
  writeTerminalFailed?: RecoveryRunReader["writeTerminalFailed"];
  signalWorkflow?: NodeRetrySignaler["signalWorkflow"];
  readValue?: (request: unknown) => Promise<unknown>;
  writeValue?: (request: unknown) => Promise<void>;
  findForSourceNode?: (request: unknown) => Promise<unknown[]>;
  resolveNodeRequirements?: CapabilityResolverHandler["resolveNodeRequirements"];
  bindAgentModelTool?: SelectionBindingHandler["bindAgentModelTool"];
  createEscalation?: (request: unknown) => Promise<{ readonly id: string }>;
  createRecovery?: (request: unknown) => Promise<{ readonly id: string }>;
} = {}): RecoveryDispatchService {
  const modelGateway = {
    invoke:
      overrides.invoke ??
      vi.fn().mockResolvedValue({
        output_json: "{}",
        usage_json: "{}",
        resolved_capability: "ADVANCED:test",
      }),
  };
  const compiler: GraphCompilerHandler = {
    compileWorkflow:
      overrides.compileWorkflow ??
      vi.fn().mockResolvedValue({ workflow_version_id: "wfv_test" }),
  };
  const planner: PlannerReplanHandler = {
    replan:
      overrides.replan ??
      vi.fn().mockResolvedValue({
        revised_skeleton_json: "{}",
        reason: "test reason",
      }),
  };
  const approvals = {
    createPending:
      overrides.createPending ??
      vi.fn().mockResolvedValue({ id: "apr_test", expiryAt: "2026-01-01T00:00:00Z" }),
  };
  const runs: RecoveryRunReader = {
    loadCompiledDagJson:
      overrides.loadCompiledDagJson ??
      vi.fn().mockResolvedValue({
        compiledDagJson: "{}",
        // A version compiled since 0036 has one; the tests that care about
        // its absence override this with null.
        taskSkeletonJson: '{"version":"1","entry_point":"a","nodes":[]}',
        dagSchemaVersion: "v1",
        workflowId: "wf_test",
        workspaceId: "018f47a5-7b2c-7d10-8f11-000000000ws1",
      }),
    writeTerminalFailed: overrides.writeTerminalFailed ?? vi.fn().mockResolvedValue(undefined),
  };
  const nodeRetrySignaler: NodeRetrySignaler = {
    signalWorkflow: overrides.signalWorkflow ?? vi.fn().mockResolvedValue(undefined),
  };
  const blackboard = {
    readValue: overrides.readValue ?? vi.fn().mockResolvedValue(undefined),
    writeValue: overrides.writeValue ?? vi.fn().mockResolvedValue(undefined),
  };
  const verificationReader = {
    findForSourceNode: overrides.findForSourceNode ?? vi.fn().mockResolvedValue([]),
  };
  // Only constructed when a test explicitly configures one of these --
  // otherwise swap_agent must see them as unset, same as production
  // before app.module.ts wires the real clients in.
  const capabilityResolver: CapabilityResolverHandler | undefined =
    overrides.resolveNodeRequirements === undefined
      ? undefined
      : { resolveNodeRequirements: overrides.resolveNodeRequirements };
  const selectionBinding: SelectionBindingHandler | undefined =
    overrides.bindAgentModelTool === undefined
      ? undefined
      : { bindAgentModelTool: overrides.bindAgentModelTool };
  return new RecoveryDispatchService(
    modelGateway as never,
    compiler,
    planner,
    approvals as never,
    runs,
    nodeRetrySignaler,
    blackboard as never,
    verificationReader as never,
    // Real delay, kept tiny here so no test pays the real 5s default --
    // the dedicated backoff test below asserts the delay actually happens.
    5,
    capabilityResolver,
    selectionBinding,
    // Unset unless a test configures one, so "repair" sees production's
    // own optional dependency both ways round.
    overrides.createEscalation === undefined
      ? undefined
      : ({ create: overrides.createEscalation } as never),
    overrides.createRecovery === undefined ? undefined : ({ createRecovery: overrides.createRecovery } as never),
  );
}

describe("RecoveryDispatchService", () => {
  it.each(["target_missing", "ambiguous_outcome"])("%s creates a clarification even for persisted retry and swap strategies", async failureClass => {
    const createRecovery = vi.fn().mockResolvedValue({ id: "clr_real" });
    const signalWorkflow = vi.fn(), createPending = vi.fn(), bindAgentModelTool = vi.fn();
    const service = buildService({ createRecovery, signalWorkflow, createPending, bindAgentModelTool });
    for (const strategy of ["retry", "backoff", "swap_agent", "ask_user"] as const) {
      await expect(service.dispatch(strategy, { ...CONTEXT, failureClass })).resolves.toMatchObject({ outcome: "escalated" });
    }
    expect(createRecovery).toHaveBeenCalledTimes(4);
    expect(createRecovery).toHaveBeenCalledWith({ tenantId: `ten_${CONTEXT.tenantId}`, runId: CONTEXT.runId,
      nodeExecutionId: CONTEXT.nodeExecutionId, recoveryActionId: CONTEXT.recoveryActionId });
    expect(signalWorkflow).not.toHaveBeenCalled();
    expect(createPending).not.toHaveBeenCalled();
    expect(bindAgentModelTool).not.toHaveBeenCalled();
  });

  it("does not commit a false escalation when the clarification queue is unavailable", async () => {
    await expect(buildService().dispatch("ask_user", { ...CONTEXT, failureClass: "ambiguous_outcome" }))
      .rejects.toThrow("Recovery clarification queue is not configured");
    const createRecovery = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(buildService({ createRecovery }).dispatch("retry", { ...CONTEXT, failureClass: "target_missing" }))
      .rejects.toThrow("queue unavailable");
  });

  it("handles every one of the 10 locked strategy values without throwing (exhaustiveness guarantee)", async () => {
    const service = buildService();
    for (const strategy of ALL_STRATEGIES) {
      await expect(service.dispatch(strategy, CONTEXT)).resolves.toMatchObject({
        outcome: expect.stringMatching(/^(resolved|failed|escalated)$/),
      });
    }
  });

  it("honestly defers every non-dispatchable strategy instead of pretending to act", async () => {
    const service = buildService();
    for (const strategy of ALL_STRATEGIES) {
      if (DISPATCHABLE_STRATEGIES.has(strategy)) continue;
      const result = await service.dispatch(strategy, CONTEXT);
      expect(result.outcome).toBe("escalated");
      expect(result.detail).toContain("strategy_dispatch_deferred");
    }
  });

  const REAL_DAG = JSON.stringify({
    schema_version: "v1",
    entry_node_keys: [CONTEXT.nodeKey],
    nodes: [
      {
        key: CONTEXT.nodeKey,
        type: "LLMTask",
        config: { capabilities: ["analysis.reasoning"] },
        metadata: { ui: {} },
      },
    ],
    edges: [],
    waves: [{ key: "wave_0", order: 0, node_keys: [CONTEXT.nodeKey], depends_on: [] }],
  });

  // Decision 6: repair escalates and parks. Nothing here holds a tenant's
  // third-party credential, so the only honest move is to name the missing
  // connection to a person and leave the run waiting.
  const DAG_WITH_CREDENTIAL = JSON.stringify({
    schema_version: "v1",
    entry_node_keys: [CONTEXT.nodeKey],
    nodes: [
      {
        key: CONTEXT.nodeKey,
        type: "ToolCall",
        config: {
          // The shape the contract locks:
          // /alter/{env}/tenant/{tenant_id}/integration/{integration_id}/{secret_name}
          credential_ref:
            "/alter/local/tenant/ten_018f47a5-7b2c-7d10-8f11-123456789abc/integration/zendesk/oauth",
        },
        metadata: { ui: {} },
      },
    ],
    edges: [],
    waves: [{ key: "wave_0", order: 0, node_keys: [CONTEXT.nodeKey], depends_on: [] }],
  });

  function dagReader(dagJson: string) {
    return vi.fn().mockResolvedValue({
      compiledDagJson: dagJson,
      dagSchemaVersion: "v1",
      workflowId: "wf_test",
      workspaceId: "018f47a5-7b2c-7d10-8f11-000000000ws1",
    });
  }

  it("repair raises an escalation naming the connection the step could not authenticate with", async () => {
    const createEscalation = vi.fn().mockResolvedValue({ id: "esc_test" });
    const service = buildService({
      createEscalation,
      loadCompiledDagJson: dagReader(DAG_WITH_CREDENTIAL),
    });

    const result = await service.dispatch("repair", CONTEXT);

    expect(result.outcome).toBe("escalated");
    expect(createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: CONTEXT.runId,
        nodeExecutionId: CONTEXT.nodeExecutionId,
        recoveryActionId: CONTEXT.recoveryActionId,
        reason: expect.stringContaining("zendesk"),
      }),
    );
  });

  it("repair never signals the run, which is what parks it", async () => {
    const signalWorkflow = vi.fn().mockResolvedValue(undefined);
    const service = buildService({
      signalWorkflow,
      createEscalation: vi.fn().mockResolvedValue({ id: "esc_test" }),
      loadCompiledDagJson: dagReader(DAG_WITH_CREDENTIAL),
    });

    await service.dispatch("repair", CONTEXT);

    expect(signalWorkflow).not.toHaveBeenCalled();
  });

  it("repair names the node when the DAG carries no connection to name", async () => {
    const createEscalation = vi.fn().mockResolvedValue({ id: "esc_test" });
    const service = buildService({
      createEscalation,
      loadCompiledDagJson: dagReader(REAL_DAG),
    });

    await service.dispatch("repair", CONTEXT);

    expect(createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining(CONTEXT.nodeKey) }),
    );
  });

  it.each([
    ["no escalation queue is wired", undefined],
    ["the escalation cannot be raised", vi.fn().mockRejectedValue(new Error("queue down"))],
  ])("repair still reports escalated when %s", async (_case, createEscalation) => {
    const service = buildService({
      ...(createEscalation === undefined ? {} : { createEscalation }),
      loadCompiledDagJson: dagReader(DAG_WITH_CREDENTIAL),
    });

    const result = await service.dispatch("repair", CONTEXT);

    // Never "resolved": no credential was supplied, so nothing was repaired.
    expect(result.outcome).toBe("escalated");
  });

  it("swap_agent makes a real ranked-match call but never reports resolved (no execution-time consumer exists)", async () => {
    const loadCompiledDagJson = vi.fn().mockResolvedValue({
      compiledDagJson: REAL_DAG,
      dagSchemaVersion: "v1",
      workflowId: "wf_test",
      workspaceId: "018f47a5-7b2c-7d10-8f11-000000000ws1",
    });
    const resolveNodeRequirements = vi.fn().mockResolvedValue({
      node_requirements_json: '{"capabilities":["analysis.reasoning"]}',
      schema_version: "1",
    });
    const bindAgentModelTool = vi.fn().mockResolvedValue({
      matched: true,
      agent_id: "agt_018f47a5-7b2c-7d10-8f11-000000000ab1",
      agent_version: 1,
    });
    const service = buildService({
      loadCompiledDagJson,
      resolveNodeRequirements,
      bindAgentModelTool,
    });

    const result = await service.dispatch("swap_agent", CONTEXT);

    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("agt_018f47a5-7b2c-7d10-8f11-000000000ab1");
    expect(result.detail).toContain("no execution-time");
    expect(resolveNodeRequirements).toHaveBeenCalledWith(
      expect.objectContaining({ node_key: CONTEXT.nodeKey, node_type: "LLMTask" }),
    );
    expect(bindAgentModelTool).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "ws_018f47a5-7b2c-7d10-8f11-000000000ws1",
        node_key: CONTEXT.nodeKey,
      }),
    );
  });

  it("swap_agent reports the real no-match reason when ranked-match finds nothing eligible", async () => {
    const loadCompiledDagJson = vi.fn().mockResolvedValue({
      compiledDagJson: REAL_DAG,
      dagSchemaVersion: "v1",
      workflowId: "wf_test",
      workspaceId: "018f47a5-7b2c-7d10-8f11-000000000ws1",
    });
    const resolveNodeRequirements = vi.fn().mockResolvedValue({
      node_requirements_json: '{"capabilities":["analysis.reasoning"]}',
      schema_version: "1",
    });
    const bindAgentModelTool = vi.fn().mockResolvedValue({
      matched: false,
      reason: "no_eligible_agent",
    });
    const service = buildService({
      loadCompiledDagJson,
      resolveNodeRequirements,
      bindAgentModelTool,
    });

    const result = await service.dispatch("swap_agent", CONTEXT);

    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("no_eligible_agent");
  });

  it("swap_agent escalates honestly when the failed node isn't in the compiled DAG", async () => {
    const loadCompiledDagJson = vi.fn().mockResolvedValue({
      compiledDagJson: JSON.stringify({
        schema_version: "v1",
        entry_node_keys: ["other_node"],
        nodes: [{ key: "other_node", type: "LLMTask", config: {}, metadata: { ui: {} } }],
        edges: [],
        waves: [{ key: "wave_0", order: 0, node_keys: ["other_node"], depends_on: [] }],
      }),
      dagSchemaVersion: "v1",
      workflowId: "wf_test",
      workspaceId: "018f47a5-7b2c-7d10-8f11-000000000ws1",
    });
    const service = buildService({
      loadCompiledDagJson,
      resolveNodeRequirements: vi.fn(),
      bindAgentModelTool: vi.fn(),
    });

    const result = await service.dispatch("swap_agent", CONTEXT);

    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("not found in the compiled DAG");
  });

  it("escalate_model calls Model Gateway at ADVANCED tier and resolves", async () => {
    const invoke = vi.fn().mockResolvedValue({
      output_json: "{}",
      usage_json: "{}",
      resolved_capability: "ADVANCED:anthropic.claude",
    });
    const service = buildService({ invoke });
    const result = await service.dispatch("escalate_model", CONTEXT);
    expect(result.outcome).toBe("resolved");
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model_alias: "ADVANCED" }),
    );

    // Asserted through the provider's own schema rather than against bespoke
    // keys: this used to send `{task, failure_class, root_cause}` bare, which
    // every provider rejects before a model sees it, so escalation could only
    // ever report "failed" against a real gateway (#133).
    const payload = ModelInvocationPayloadSchema.parse(
      JSON.parse(invoke.mock.calls[0]![0].input_json),
    );
    expect(payload.messages).toHaveLength(1);
    expect(JSON.parse(payload.messages[0]!.content)).toMatchObject({
      failure_class: CONTEXT.failureClass,
    });
  });

  it("escalate_model fails (not throws) when Model Gateway errors", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("gateway unreachable"));
    const service = buildService({ invoke });
    const result = await service.dispatch("escalate_model", CONTEXT);
    expect(result.outcome).toBe("failed");
    // The cause has to survive: this is the only place it is reported.
    expect(result.detail).toContain("gateway unreachable");
  });

  it("replan sends the stored task skeleton, calls Planner, then recompiles", async () => {
    const taskSkeletonJson = '{"version":"1","entry_point":"a","nodes":[]}';
    const loadCompiledDagJson = vi.fn().mockResolvedValue({
      compiledDagJson: '{"schema_version":"v1"}',
      taskSkeletonJson,
      dagSchemaVersion: "v1",
      workflowId: "wf_real",
    });
    const replan = vi.fn().mockResolvedValue({
      revised_skeleton_json: '{"steps":[]}',
      reason: "logic failure detected",
    });
    const compileWorkflow = vi.fn().mockResolvedValue({ workflow_version_id: "wfv_new" });
    const service = buildService({ loadCompiledDagJson, replan, compileWorkflow });

    const result = await service.dispatch("replan", CONTEXT);

    expect(result.outcome).toBe("resolved");
    // The skeleton, never compiledDagJson. This assertion pinned the compiled
    // DAG until the skeleton was persisted, which is what made the defect
    // invisible: the planner parses this field as a TaskSkeleton regardless of
    // its `current_dag_json` name, so a DAG here fails every time.
    expect(replan).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: CONTEXT.runId,
        current_dag_json: taskSkeletonJson,
      }),
    );
    expect(JSON.parse(replan.mock.calls[0]?.[0].failure_context_json)).toEqual(
      expect.objectContaining({
        node_execution_id: CONTEXT.nodeExecutionId,
        node_key: CONTEXT.nodeKey,
      }),
    );
    expect(compileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: "wf_real",
        task_skeleton_json: '{"steps":[]}',
        dag_schema_version: "v1",
      }),
    );
  });

  it("replan defers instead of guessing when the version has no task skeleton", async () => {
    // Two real cases: a version compiled before task_skeleton existed, whose
    // skeleton survives only as a one-way hash, and an architecture-compiled
    // version, which never had one. Neither is a failure of this run.
    const loadCompiledDagJson = vi.fn().mockResolvedValue({
      compiledDagJson: '{"schema_version":"v1"}',
      taskSkeletonJson: null,
      dagSchemaVersion: "v1",
      workflowId: "wf_real",
    });
    const replan = vi.fn();
    const service = buildService({ loadCompiledDagJson, replan });

    const result = await service.dispatch("replan", CONTEXT);

    expect(result.outcome).toBe("escalated");
    expect(result.detail).toContain("strategy_dispatch_deferred");
    expect(replan).not.toHaveBeenCalled();
  });

  it("replan fails (not throws) when the run has no compiled DAG to replan from", async () => {
    const loadCompiledDagJson = vi.fn().mockRejectedValue(new Error("no compiled DAG"));
    const service = buildService({ loadCompiledDagJson });
    const result = await service.dispatch("replan", CONTEXT);
    expect(result.outcome).toBe("failed");
  });

  it("recompile shares replan's real mechanism (no narrower primitive exists)", async () => {
    const replan = vi.fn().mockResolvedValue({
      revised_skeleton_json: '{"steps":[]}',
      reason: "sandbox crash detected",
    });
    const compileWorkflow = vi.fn().mockResolvedValue({ workflow_version_id: "wfv_recompiled" });
    const service = buildService({ replan, compileWorkflow });

    const result = await service.dispatch("recompile", CONTEXT);

    expect(result.outcome).toBe("resolved");
    expect(replan).toHaveBeenCalledTimes(1);
    expect(compileWorkflow).toHaveBeenCalledTimes(1);
  });

  it("retry sends a real nodeRetryDecidedSignal to the run's Executor workflow", async () => {
    const signalWorkflow = vi.fn().mockResolvedValue(undefined);
    const service = buildService({ signalWorkflow });

    const result = await service.dispatch("retry", CONTEXT);

    expect(result.outcome).toBe("resolved");
    expect(signalWorkflow).toHaveBeenCalledWith({
      workflowId: CONTEXT.runId,
      signalName: "nodeRetryDecided",
      payload: { nodeExecutionId: CONTEXT.nodeExecutionId, action: "retry" },
    });
  });

  it("retry fails (not throws) when signaling the workflow fails", async () => {
    const signalWorkflow = vi.fn().mockRejectedValue(new Error("workflow not found"));
    const service = buildService({ signalWorkflow });

    const result = await service.dispatch("retry", CONTEXT);

    expect(result.outcome).toBe("failed");
  });

  it("backoff sends the same real signal as retry, after a real (injectable, here tiny) delay", async () => {
    const signalWorkflow = vi.fn().mockResolvedValue(undefined);
    const service = new RecoveryDispatchService(
      { invoke: vi.fn() } as never,
      { compileWorkflow: vi.fn() } as never,
      { replan: vi.fn() } as never,
      { createPending: vi.fn() } as never,
      {
        loadCompiledDagJson: vi.fn(),
        writeTerminalFailed: vi.fn(),
      } as never,
      { signalWorkflow },
      { readValue: vi.fn(), writeValue: vi.fn() } as never,
      { findForSourceNode: vi.fn() } as never,
      25, // real delay, injected small so the test doesn't burn 5 real seconds
    );

    const start = Date.now();
    const result = await service.dispatch("backoff", CONTEXT);
    const elapsedMs = Date.now() - start;

    expect(result.outcome).toBe("resolved");
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    expect(signalWorkflow).toHaveBeenCalledWith({
      workflowId: CONTEXT.runId,
      signalName: "nodeRetryDecided",
      payload: { nodeExecutionId: CONTEXT.nodeExecutionId, action: "retry" },
    });
  });

  describe("degrade", () => {
    const DAG_JSON = JSON.stringify({
      schema_version: "dag-v1",
      entry_node_keys: ["node_a", "node_b"],
      nodes: [
        { key: "node_a", type: "LLMTask", config: {}, metadata: { ui: {} } },
        { key: "node_b", type: "LLMTask", config: {}, metadata: { ui: {} } },
        { key: CONTEXT.nodeKey, type: "Synthesis", config: {}, metadata: { ui: {} } },
      ],
      edges: [
        { key: "e1", from: "node_a", to: CONTEXT.nodeKey, kind: "sequential" },
        { key: "e2", from: "node_b", to: CONTEXT.nodeKey, kind: "sequential" },
      ],
      waves: [
        { key: "w0", order: 0, node_keys: ["node_a", "node_b"], depends_on: [] },
        { key: "w1", order: 1, node_keys: [CONTEXT.nodeKey], depends_on: ["w0"] },
      ],
    });
    const PASS = { gateType: "quality", verdict: "pass", score: 0.9, threshold: 0.7, details: {} };
    const SAFE = {
      gateType: "safety",
      verdict: "pass",
      score: null,
      threshold: null,
      details: { severity: "low" },
    };

    it("synthesizes a real honest partial from verified predecessor outputs and writes it to the failed node's own Blackboard key", async () => {
      const readValue = vi.fn().mockImplementation((request: { key: string }) => {
        if (request.key === "node_a") return Promise.resolve({ text: "a" });
        return Promise.resolve(undefined);
      });
      const writeValue = vi.fn().mockResolvedValue(undefined);
      const invoke = vi.fn().mockResolvedValue({
        output_json: JSON.stringify({ summary: "partial" }),
        usage_json: "{}",
        resolved_capability: "ADVANCED:test",
      });
      const service = buildService({
        loadCompiledDagJson: vi.fn().mockResolvedValue({
          compiledDagJson: DAG_JSON,
          dagSchemaVersion: "dag-v1",
          workflowId: "wf_test",
        }),
        readValue,
        writeValue,
        invoke,
        findForSourceNode: vi.fn().mockResolvedValue([PASS, SAFE]),
      });

      const result = await service.dispatch("degrade", CONTEXT);

      expect(result.outcome).toBe("resolved");
      expect(writeValue).toHaveBeenCalledWith(
        expect.objectContaining({
          key: CONTEXT.nodeKey,
          value: expect.objectContaining({ deliverable: { summary: "partial" } }),
        }),
      );
    });

    it("escalates (never fakes resolved) when no predecessor has a Blackboard value", async () => {
      const service = buildService({
        loadCompiledDagJson: vi.fn().mockResolvedValue({
          compiledDagJson: DAG_JSON,
          dagSchemaVersion: "dag-v1",
          workflowId: "wf_test",
        }),
        readValue: vi.fn().mockResolvedValue(undefined),
      });

      const result = await service.dispatch("degrade", CONTEXT);

      expect(result.outcome).toBe("escalated");
    });

    it("escalates when Synthesis itself finds nothing verified, never claims resolved", async () => {
      const readValue = vi.fn().mockResolvedValue({ text: "a" });
      const service = buildService({
        loadCompiledDagJson: vi.fn().mockResolvedValue({
          compiledDagJson: DAG_JSON,
          dagSchemaVersion: "dag-v1",
          workflowId: "wf_test",
        }),
        readValue,
        // Every predecessor's input fails verification -- nothing honest to synthesize.
        findForSourceNode: vi.fn().mockResolvedValue([]),
      });

      const result = await service.dispatch("degrade", CONTEXT);

      expect(result.outcome).toBe("escalated");
    });

    it("fails (not resolved, not a crash) when the compiled DAG is invalid", async () => {
      const service = buildService({
        loadCompiledDagJson: vi.fn().mockResolvedValue({
          compiledDagJson: "not valid json",
          dagSchemaVersion: "dag-v1",
          workflowId: "wf_test",
        }),
      });

      const result = await service.dispatch("degrade", CONTEXT);

      expect(result.outcome).toBe("failed");
    });
  });

  it("ask_user creates a real pending approval and escalates", async () => {
    const createPending = vi
      .fn()
      .mockResolvedValue({ id: "apr_real", expiryAt: "2026-02-01T00:00:00Z" });
    const service = buildService({ createPending });
    const result = await service.dispatch("ask_user", CONTEXT);
    expect(result.outcome).toBe("escalated");
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ nodeExecutionId: CONTEXT.nodeExecutionId }),
    );
  });

  it("terminate writes the real terminal run state and reports failed", async () => {
    const writeTerminalFailed = vi.fn().mockResolvedValue(undefined);
    const service = buildService({ writeTerminalFailed });
    const result = await service.dispatch("terminate", CONTEXT);
    expect(result.outcome).toBe("failed");
    expect(writeTerminalFailed).toHaveBeenCalledWith(CONTEXT.tenantId, CONTEXT.runId);
  });
});
