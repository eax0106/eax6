import { ModelGatewayInvalidResponseError } from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";

import {
  NodeHandlerValidationError,
  type NodeExecutionContext,
  type NodeHandler,
} from "./handler";
import { MergeHandler } from "./handlers/merge.handler";
import { NodeHandlerRegistry } from "./node-handler-registry";
import { NodeexecService } from "./nodeexec.service";
import type { GeneratedFileMaterializer } from "./generated-file-materializer";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";
import type { RecoveryTriggerService } from "../recovery/recovery-trigger.service";
import { SafetyViolationError, VerifyGateError, VerifyGateService } from "./verify-gate.service";

const TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function service(ledger = fakeLedger()): NodeexecService {
  return new NodeexecService(new NodeHandlerRegistry([new MergeHandler()]), ledger);
}

function fakeLedger(): NodeExecutionLedgerService {
  return {
    recordStarted: vi.fn().mockResolvedValue({
      attempt: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
    }),
    recordSucceeded: vi.fn().mockResolvedValue(undefined),
    recordFailed: vi.fn().mockResolvedValue(undefined),
    recordVerificationResult: vi.fn().mockResolvedValue(undefined),
    finalizeRun: vi.fn().mockResolvedValue({
      status: "completed",
      endedAt: "2026-07-28T00:00:01.000Z",
    }),
  } as unknown as NodeExecutionLedgerService;
}

describe("NodeexecService.executeNode", () => {
  it("dispatches to the handler and returns JSON-serialized output/metadata", async () => {
    const ledger = fakeLedger();
    const response = await service(ledger).executeNode({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge",
      node_type: "Merge",
      config_json: "{}",
      inputs_json: JSON.stringify({ node_a: { x: 1 } }),
      success_criteria: [],
    });

    expect(JSON.parse(response.output_json)).toEqual({ x: 1 });
    expect(JSON.parse(response.metadata_json)).toEqual({});
    expect(ledger.recordStarted).toHaveBeenCalledOnce();
    expect(ledger.recordSucceeded).toHaveBeenCalledOnce();
  });

  it("scores ordinary node output before recording success", async () => {
    const ledger = fakeLedger();
    const verifyGate = {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "pass", score: 1, threshold: 0.8, reviewer_model: "deterministic", details_json: "{}",
      }),
    } as unknown as VerifyGateService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, undefined, undefined,
      undefined, undefined, verifyGate,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}",
      inputs_json: JSON.stringify({ node_a: { x: 1 } }),
      success_criteria: [],
    });

    expect(verifyGate.scoreNodeInline).toHaveBeenCalledWith({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", output_json: "{\"x\":1}",
      success_criteria: [],
    });
    expect(ledger.recordSucceeded).toHaveBeenCalledOnce();
    expect(JSON.parse(response.metadata_json)).toMatchObject({ verification: { verdict: "pass" } });
    expect(ledger.recordVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID, runId: RUN_ID, nodeExecutionId: NODE_EXECUTION_ID,
        gateType: "quality", verdict: "pass", score: 1, threshold: 0.8,
        reviewerModel: "deterministic", detailsJson: "{}",
      }),
    );
  });

  it("gives the node and the gate the node's own success criteria, and fails on an unmet one (C29)", async () => {
    const ledger = fakeLedger();
    const seen: NodeExecutionContext[] = [];
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      execute: async (context) => {
        seen.push(context);
        return { output: { text: "a poem" } };
      },
    };
    const verifyGate = {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "fail", score: 0.95, threshold: 0.7, reviewer_model: "ADVANCED",
        details_json: JSON.stringify({ reason: "output does not meet every success criterion" }),
      }),
    } as unknown as VerifyGateService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), ledger, undefined, undefined, undefined,
      undefined, undefined, verifyGate,
    );
    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "summarise", node_type: "LLMTask", config_json: JSON.stringify({ prompt: "x", model_alias: "FAST" }),
      inputs_json: "{}", success_criteria: ["Refund total stated"],
    })).rejects.toBeInstanceOf(VerifyGateError);
    expect(seen[0]!.success_criteria).toEqual(["Refund total stated"]);
    expect(verifyGate.scoreNodeInline).toHaveBeenCalledWith(
      expect.objectContaining({ node_key: "summarise", success_criteria: ["Refund total stated"] }),
    );
    expect(ledger.recordSucceeded).not.toHaveBeenCalled();
  });

  it("records a warning verdict distinctly while preserving success", async () => {
    const ledger = fakeLedger();
    const verifyGate = {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "warn", score: 0.81, threshold: 0.8, reviewer_model: "deterministic", details_json: "{}",
      }),
    } as unknown as VerifyGateService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, undefined, undefined,
      undefined, undefined, verifyGate,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    });

    expect(ledger.recordSucceeded).toHaveBeenCalledOnce();
    expect(JSON.parse(response.metadata_json)).toMatchObject({ verification: { verdict: "warn" } });
  });

  it("fails closed and triggers recovery when Verify rejects node output", async () => {
    const ledger = fakeLedger();
    const recovery = {
      triggerForBlockedNode: vi.fn().mockResolvedValue(undefined),
      triggerForFailedNode: vi.fn().mockResolvedValue(undefined),
    } as unknown as RecoveryTriggerService;
    const verifyGate = {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "fail", score: 0, threshold: 0.8, reviewer_model: "deterministic", details_json: "{}",
      }),
    } as unknown as VerifyGateService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, recovery, undefined,
      undefined, undefined, verifyGate,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow(/Verify Gate rejected/);

    expect(ledger.recordSucceeded).not.toHaveBeenCalled();
    expect(ledger.recordFailed).toHaveBeenCalledWith(
      expect.anything(),
      { code: "VERIFICATION_GATE_FAILED", detail: "Verify Gate rejected node output" },
    );
    expect(recovery.triggerForFailedNode).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "VERIFICATION_GATE_FAILED",
    }));
  });

  it("halts on a safety violation without asking Recovery to keep going (design log §4, C40)", async () => {
    const ledger = fakeLedger();
    const recovery = {
      triggerForBlockedNode: vi.fn().mockResolvedValue(undefined),
      triggerForFailedNode: vi.fn().mockResolvedValue(undefined),
    } as unknown as RecoveryTriggerService;
    const verifyGate = {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "fail", score: 0, threshold: 0.8, reviewer_model: "injection-blocked",
        details_json: JSON.stringify({ reason: "rubric override attempt" }),
      }),
    } as unknown as VerifyGateService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, recovery, undefined,
      undefined, undefined, verifyGate,
    );

    const error = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafetyViolationError);
    expect((error as Error).name).toBe("SafetyViolationError");
    expect(ledger.recordFailed).toHaveBeenCalledWith(expect.anything(), {
      code: "SAFETY_VIOLATION",
      detail: "Verify Gate blocked node output as a safety violation; the workflow halts",
    });
    expect(recovery.triggerForFailedNode).not.toHaveBeenCalled();
    expect(recovery.triggerForBlockedNode).not.toHaveBeenCalled();
  });

  it("fails closed when Verify Service is unavailable", async () => {
    const ledger = fakeLedger();
    const verifyGate = new VerifyGateService({
      scoreNodeInline: vi.fn().mockRejectedValue(new Error("unavailable")),
    });
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, undefined, undefined,
      undefined, undefined, verifyGate,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow(/Verify Service call failed: unavailable/);
    expect(ledger.recordSucceeded).not.toHaveBeenCalled();
    // The code is what the caller branches on; the detail carries the reason
    // the gate actually failed, so a stored row is diagnosable on its own.
    expect(ledger.recordFailed).toHaveBeenCalledWith(
      expect.anything(),
      { code: "VERIFY_SERVICE_UNAVAILABLE", detail: "Verify Service call failed: unavailable" },
    );
  });

  it("passes sandbox_session_id from compiled config through execution context", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "SandboxExec",
      async execute(context) {
        received = context;
        return { output: {} };
      },
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]),
      fakeLedger(),
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_sandbox",
      node_type: "SandboxExec",
      config_json: JSON.stringify({ sandbox_session_id: "e2b_ses_123" }),
      inputs_json: "{}",
      success_criteria: [],
    });

    expect(received?.sandbox_session_id).toBe("e2b_ses_123");
  });

  it("journals real SandboxExec stdout and stderr as terminal frames", async () => {
    const handler: NodeHandler = {
      nodeType: "SandboxExec",
      async execute() {
        return { output: { stdout: "installed\\n", stderr: "warning\\n", exit_code: 0 } };
      },
    };
    const streamEvents = { append: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]),
      fakeLedger(),
      streamEvents as unknown as RunStreamEventService,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_sandbox",
      node_type: "SandboxExec",
      config_json: JSON.stringify({ sandbox_session_id: "e2b_ses_123" }),
      inputs_json: "{}",
      success_criteria: [],
    });

    expect(streamEvents.append).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      { event: "terminal.frame", data: { stream: "stdout", data: "installed\\n" } },
    );
    expect(streamEvents.append).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      { event: "terminal.frame", data: { stream: "stderr", data: "warning\\n" } },
    );
  });

  it("falls back to the durable project-run session for SandboxExec", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "SandboxExec",
      async execute(context) {
        received = context;
        return { output: {} };
      },
    };
    const provisioned = {
      getSessionForRun: vi.fn().mockResolvedValue("e2b_ses_project"),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      provisioned as never,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_install_dependencies", node_type: "SandboxExec",
      config_json: JSON.stringify({ command: "pnpm install" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(provisioned.getSessionForRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(received?.sandbox_session_id).toBe("e2b_ses_project");
    expect(received?.config.sandbox_session_id).toBe("e2b_ses_project");
  });

  it("falls back to the project run session and materializes node_generate_code output", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute(context) {
        received = context;
        return { output: { files: [{ path: "src/index.ts", content: "export {};" }] } };
      },
    };
    const ledger = fakeLedger();
    const provisioned = {
      getSessionForRun: vi.fn().mockResolvedValue("e2b_ses_project"),
      getProjectDirectoryForRun: vi.fn().mockResolvedValue("/workspace/prj_project"),
    };
    const materializer = {
      materialize: vi.fn().mockResolvedValue({ manifestArtifactId: "art_manifest", files: [] }),
    } as unknown as GeneratedFileMaterializer;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), ledger, undefined, undefined, undefined,
      provisioned as never, materializer,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_generate_code", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Build app", model_alias: "ADVANCED" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(provisioned.getSessionForRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(provisioned.getProjectDirectoryForRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(received?.sandbox_session_id).toBe("e2b_ses_project");
    expect(received?.config.prompt).toContain("Return only JSON matching");
    expect(materializer.materialize).toHaveBeenCalledWith({
      tenantId: TENANT_ID, runId: RUN_ID, sessionId: "e2b_ses_project",
      projectDirectory: "/workspace/prj_project",
      output: { files: [{ path: "src/index.ts", content: "export {};" }] },
    });
    expect(ledger.recordSucceeded).toHaveBeenCalledWith(expect.objectContaining({ outputRef: "art_manifest" }));
  });

  it("resolves a real Selection & Binding match for LLMTask and injects it into context", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute(context) {
        received = context;
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({
        node_requirements_json: '{"task_category":"codegen"}',
        schema_version: "1",
      }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({
        matched: true,
        agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        agent_version: 3,
        model_alias: "ADVANCED",
        tool_names: ["search_web"],
        instructions: "You review code for security issues first.",
      }),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
    );

    const configJson = JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" });
    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask", config_json: configJson, inputs_json: "{}",
      success_criteria: [],
    });

    expect(runWorkspaceLookup.getWorkspaceId).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(capabilityResolver.resolveNodeRequirements).toHaveBeenCalledWith({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_key: "node_task", node_type: "LLMTask",
      node_config_json: configJson,
    });
    expect(selectionBinding.bindAgentModelTool).toHaveBeenCalledWith({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_key: "node_task",
      node_requirements_json: '{"node_task":{"task_category":"codegen"}}', workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef",
      node_type: "LLMTask",
    });
    expect(received?.agent_id).toBe("agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab");
    expect(received?.bound_model_alias).toBe("ADVANCED");
    expect(received?.bound_tool_names).toEqual(["search_web"]);
    // The bound agent's instructions reach the handler, which sends them as the
    // model's system message.
    expect(received?.bound_agent_instructions).toBe("You review code for security issues first.");
  });

  it("leaves binding fields absent when Selection & Binding finds no eligible agent", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute(context) {
        received = context;
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({ matched: false, reason: "no eligible agent" }),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(received?.agent_id).toBeUndefined();
    expect(received?.bound_model_alias).toBeUndefined();
    expect(received?.bound_tool_names).toBeUndefined();
  });

  it("fails open when Selection & Binding resolution errors, never failing the node", async () => {
    let received: NodeExecutionContext | undefined;
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute(context) {
        received = context;
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockRejectedValue(new Error("run not found")) };
    const capabilityResolver = { resolveNodeRequirements: vi.fn() };
    const selectionBinding = { bindAgentModelTool: vi.fn() };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(response.output_json).toBe("{}");
    expect(received?.agent_id).toBeUndefined();
    expect(capabilityResolver.resolveNodeRequirements).not.toHaveBeenCalled();
  });

  it("stays fail-open with no fallback when no kill switch is configured at all", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({ matched: false, reason: "no eligible agent" }),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(response.output_json).toBe("{}");
  });

  it("fails closed with a real AgentCreationFailedError when the kill switch is on and there is no fallback", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: {} };
      },
    };
    const ledger = fakeLedger();
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({ matched: false, reason: "no eligible agent" }),
    };
    const failClosed = { isEnabled: vi.fn().mockResolvedValue(true) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), ledger, undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      undefined, failClosed as never,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it" }), inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow(/No eligible agent/);

    expect(ledger.recordFailed).toHaveBeenCalledWith(
      expect.anything(),
      { code: "AGENT_CREATION_FAILED", detail: expect.stringContaining("No eligible agent") },
    );
  });

  it("stays fail-open when the kill switch is on but the compiled config has a fallback model_alias", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({ matched: false, reason: "no eligible agent" }),
    };
    const failClosed = { isEnabled: vi.fn().mockResolvedValue(true) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      undefined, failClosed as never,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(response.output_json).toBe("{}");
  });

  it("never fails closed for a genuine Selection & Binding infra error, even with the kill switch on", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockRejectedValue(new Error("unreachable")) };
    const capabilityResolver = { resolveNodeRequirements: vi.fn() };
    const selectionBinding = { bindAgentModelTool: vi.fn() };
    const failClosed = { isEnabled: vi.fn().mockResolvedValue(true) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      undefined, failClosed as never,
    );

    const response = await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(response.output_json).toBe("{}");
    expect(failClosed.isEnabled).not.toHaveBeenCalled();
  });

  it("does not attempt Selection & Binding resolution for non-LLMTask node types", async () => {
    const runWorkspaceLookup = { getWorkspaceId: vi.fn() };
    const capabilityResolver = { resolveNodeRequirements: vi.fn() };
    const selectionBinding = { bindAgentModelTool: vi.fn() };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    });

    expect(runWorkspaceLookup.getWorkspaceId).not.toHaveBeenCalled();
  });

  it("records a real performance observation when a bound LLMTask node succeeds", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return {
          output: {},
          metadata: { usage: { input_tokens: 10, output_tokens: 25 } },
        };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({
        matched: true,
        agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        agent_version: 1,
        model_alias: "ADVANCED",
        tool_names: [],
      }),
    };
    const performanceRecorder = { recordObservation: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      performanceRecorder as never,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(performanceRecorder.recordObservation).toHaveBeenCalledWith(
      "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      expect.objectContaining({
        tenant_id: TENANT_ID, run_id: RUN_ID, node_type: "LLMTask",
        verdict: "success", token_count: 35,
      }),
    );
    expect(performanceRecorder.recordObservation.mock.calls[0]?.[1].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("records a real performance observation as a failure when a bound LLMTask node throws", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        // MODEL_OUTPUT_INVALID: the model's own answer failed validation, so
        // the failure is the agent's and belongs on its record. This used to
        // throw NodeHandlerValidationError, which is a verdict on the node's
        // config rather than on the agent -- no longer recorded (#164), and
        // asserted as such two tests below.
        throw new ModelGatewayInvalidResponseError("answered in prose, not JSON");
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({
        matched: true,
        agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        agent_version: 1,
        model_alias: "ADVANCED",
        tool_names: [],
      }),
    };
    const performanceRecorder = { recordObservation: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      performanceRecorder as never,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow(ModelGatewayInvalidResponseError);

    expect(performanceRecorder.recordObservation).toHaveBeenCalledWith(
      "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      expect.objectContaining({ verdict: "failure" }),
    );
  });

  it.each([
    ["VERIFY_SERVICE_UNAVAILABLE", new VerifyGateError("VERIFY_SERVICE_UNAVAILABLE", "upstream")],
    ["NODE_HANDLER_VALIDATION_FAILED", new NodeHandlerValidationError("no model_alias in config")],
    ["a bare transport failure", Object.assign(new Error("socket closed"), { code: 14 })],
  ])("does not blame the bound agent for %s", async (_label, thrown) => {
    // A performance record asserts that this agent did badly, and Selection &
    // Binding routes away from an agent that has one. None of these say
    // anything about the agent: an outage, a node config that never named a
    // model, a dropped socket. Recording them punished whichever agent
    // happened to be bound while the platform had a bad minute (#164).
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        throw thrown;
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({
        matched: true,
        agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        agent_version: 1,
        model_alias: "ADVANCED",
        tool_names: [],
      }),
    };
    const performanceRecorder = { recordObservation: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      performanceRecorder as never,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow();

    expect(performanceRecorder.recordObservation).not.toHaveBeenCalled();
  });

  it("blames the bound agent when Verify Gate rejects its output", async () => {
    // The other half of the same rule: VERIFICATION_GATE_FAILED is a verdict
    // on the output, which is the agent's, unlike the service being down.
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        throw new VerifyGateError("VERIFICATION_GATE_FAILED", "Verify Gate rejected node output");
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({
        matched: true,
        agent_id: "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        agent_version: 1,
        model_alias: "ADVANCED",
        tool_names: [],
      }),
    };
    const performanceRecorder = { recordObservation: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      performanceRecorder as never,
    );

    await expect(nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    })).rejects.toThrow(VerifyGateError);

    expect(performanceRecorder.recordObservation).toHaveBeenCalledWith(
      "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      expect.objectContaining({ verdict: "failure" }),
    );
  });

  it("does not record a performance observation when no real binding matched", async () => {
    const handler: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: {} };
      },
    };
    const runWorkspaceLookup = { getWorkspaceId: vi.fn().mockResolvedValue("018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef") };
    const capabilityResolver = {
      resolveNodeRequirements: vi.fn().mockResolvedValue({ node_requirements_json: "{}", schema_version: "1" }),
    };
    const selectionBinding = {
      bindAgentModelTool: vi.fn().mockResolvedValue({ matched: false, reason: "no eligible agent" }),
    };
    const performanceRecorder = { recordObservation: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([handler]), fakeLedger(), undefined, undefined, undefined,
      undefined, undefined, undefined,
      runWorkspaceLookup as never, capabilityResolver as never, selectionBinding as never,
      performanceRecorder as never,
    );

    await nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_task", node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Do it", model_alias: "STANDARD" }), inputs_json: "{}",
      success_criteria: [],
    });

    expect(performanceRecorder.recordObservation).not.toHaveBeenCalled();
  });

  it("rejects a blank node_key", async () => {
    await expect(
      service().executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "",
        node_type: "Merge",
        config_json: "{}",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("rejects an unknown node type before opening a durable execution", async () => {
    const ledger = fakeLedger();

    await expect(
      service(ledger).executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_unknown",
        node_type: "UnknownNode",
        config_json: "{}",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
    expect(ledger.recordStarted).not.toHaveBeenCalled();
  });

  it("rejects malformed config_json", async () => {
    await expect(
      service().executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge",
        node_type: "Merge",
        config_json: "{not json",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("fails closed when recording a failed execution cannot persist", async () => {
    const persistenceFailure = new Error("checkpoint store unavailable");
    const ledger = fakeLedger();
    vi.mocked(ledger.recordFailed).mockRejectedValue(persistenceFailure);

    await expect(
      service(ledger).executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge",
        node_type: "Merge",
        config_json: "{not json",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(persistenceFailure);
  });

  it("triggers recovery for a genuine node exception, not only for Gate-blocked nodes", async () => {
    const ledger = fakeLedger();
    const recovery = {
      triggerForBlockedNode: vi.fn().mockResolvedValue(undefined),
      triggerForFailedNode: vi.fn().mockResolvedValue(undefined),
    } as unknown as RecoveryTriggerService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      ledger,
      undefined,
      recovery,
    );

    await expect(
      nodeexec.executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge",
        node_type: "Merge",
        config_json: "{not json",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);

    expect(recovery.triggerForFailedNode).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      nodeExecutionId: NODE_EXECUTION_ID,
      errorCode: "NODE_HANDLER_VALIDATION_FAILED",
      detail: expect.stringContaining("config_json is not valid JSON"),
    });
    expect(recovery.triggerForBlockedNode).not.toHaveBeenCalled();
  });

  it("does not let a recovery-trigger failure mask the real node failure (best-effort)", async () => {
    const ledger = fakeLedger();
    const recovery = {
      triggerForBlockedNode: vi.fn().mockResolvedValue(undefined),
      triggerForFailedNode: vi.fn().mockRejectedValue(new Error("trigger unreachable")),
    } as unknown as RecoveryTriggerService;
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      ledger,
      undefined,
      recovery,
    );

    await expect(
      nodeexec.executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge",
        node_type: "Merge",
        config_json: "{not json",
        inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("rejects malformed inputs_json", async () => {
    await expect(
      service().executeNode({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge",
        node_type: "Merge",
        config_json: "{}",
        inputs_json: "[1,2,3]",
        success_criteria: [],
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("records predecessor keys as input_ref and leaves generic output_ref unset", async () => {
    const ledger = fakeLedger();
    await service(ledger).executeNode({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge",
      node_type: "Merge",
      config_json: "{}",
      inputs_json: JSON.stringify({ node_a: { x: 1 }, node_b: { y: 2 } }),
      success_criteria: [],
    });

    expect(ledger.recordStarted).toHaveBeenCalledWith(
      expect.objectContaining({ inputRef: "node_a,node_b" }),
    );
    expect(ledger.recordSucceeded).toHaveBeenCalledWith(
      expect.not.objectContaining({ outputRef: expect.anything() }),
    );
  });

  it("omits input_ref for a source node with no predecessor data", async () => {
    const ledger = fakeLedger();
    await service(ledger).executeNode({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      node_execution_id: NODE_EXECUTION_ID,
      node_key: "node_merge",
      node_type: "Merge",
      config_json: "{}",
      inputs_json: "{}",
      success_criteria: [],
    });

    expect(ledger.recordStarted).toHaveBeenCalledWith(
      expect.not.objectContaining({ inputRef: expect.anything() }),
    );
  });
});

describe("NodeexecService.finalizeRun end-of-run check (design log §5.3, C37)", () => {
  function nodeexecWith(acceptance: { check: ReturnType<typeof vi.fn> }) {
    const ledger = fakeLedger();
    vi.mocked(ledger.finalizeRun).mockImplementation(async (_tenant, _run, status) => ({
      status,
      endedAt: "2026-07-28T00:00:01.000Z",
    }));
    const streamEvents = { append: vi.fn().mockResolvedValue(undefined) };
    const args: unknown[] = [
      new NodeHandlerRegistry([new MergeHandler()]), ledger, streamEvents,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, acceptance,
    ];
    const nodeexec = new (NodeexecService as unknown as new (...a: unknown[]) => NodeexecService)(...args);
    return { nodeexec, ledger, streamEvents };
  }

  it("finalizes a completed run as failed when its combined outcome misses the criteria", async () => {
    const check = vi.fn().mockResolvedValue({
      checked: true, passed: false, reason: "combined outcome does not meet every success criterion",
    });
    const { nodeexec, ledger, streamEvents } = nodeexecWith({ check });

    const response = await nodeexec.finalizeRun({
      tenant_id: TENANT_ID, run_id: RUN_ID, status: "completed", error_json: "",
    });

    expect(check).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
    expect(ledger.finalizeRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID, "failed");
    expect(response.status).toBe("failed");
    expect(streamEvents.append).toHaveBeenCalledWith(TENANT_ID, RUN_ID, {
      event: "run.status",
      data: { status: "failed", reason: "combined outcome does not meet every success criterion" },
    });
  });

  it("keeps a completed run completed when the check passes or does not apply", async () => {
    for (const result of [
      { checked: true, passed: true, reason: "combined outcome meets the success criteria" },
      { checked: false, reason: "no_success_criteria" },
    ]) {
      const { nodeexec, ledger } = nodeexecWith({ check: vi.fn().mockResolvedValue(result) });
      await nodeexec.finalizeRun({ tenant_id: TENANT_ID, run_id: RUN_ID, status: "completed", error_json: "" });
      expect(ledger.finalizeRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID, "completed");
    }
  });

  it("does not judge a run that already failed", async () => {
    const check = vi.fn();
    const { nodeexec } = nodeexecWith({ check });
    await nodeexec.finalizeRun({ tenant_id: TENANT_ID, run_id: RUN_ID, status: "failed", error_json: "" });
    expect(check).not.toHaveBeenCalled();
  });
});

describe("NodeexecService.finalizeRun", () => {
  it("finalizes a completed run and emits a run.status SSE event", async () => {
    const ledger = fakeLedger();
    const streamEvents = { append: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      ledger,
      streamEvents as unknown as RunStreamEventService,
    );

    const response = await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "completed",
      error_json: "",
    });

    expect(response.status).toBe("completed");
    expect(ledger.finalizeRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID, "completed");
    expect(streamEvents.append).toHaveBeenCalledWith(
      TENANT_ID,
      RUN_ID,
      expect.objectContaining({ event: "run.status", data: { status: "completed" } }),
    );
  });

  it("closes a project provisioning cycle from the real terminal activity path", async () => {
    const closeForTerminalRun = vi.fn().mockResolvedValue(undefined);
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      fakeLedger(),
      undefined,
      undefined,
      undefined,
      { closeForTerminalRun } as never,
    );

    await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "completed",
      error_json: "",
    });

    expect(closeForTerminalRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
  });

  it("does not emit run.status when the run was already terminal for another reason", async () => {
    const ledger = fakeLedger();
    vi.mocked(ledger.finalizeRun).mockResolvedValue({
      status: "cancelled",
      endedAt: "2026-07-28T00:00:01.000Z",
    });
    const streamEvents = { append: vi.fn().mockResolvedValue(undefined) };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      ledger,
      streamEvents as unknown as RunStreamEventService,
    );

    const response = await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "failed",
      error_json: "{}",
    });

    expect(response.status).toBe("cancelled");
    expect(streamEvents.append).not.toHaveBeenCalled();
  });

  it("rejects a status other than completed or failed", async () => {
    await expect(
      service().finalizeRun({
        tenant_id: TENANT_ID,
        run_id: RUN_ID,
        status: "running",
        error_json: "",
      }),
    ).rejects.toThrow(NodeHandlerValidationError);
  });

  it("triggers the run-finalization memory write only on a real completed status", async () => {
    const runFinalizationMemoryWriter = {
      writeVerifiedOutputMemory: vi.fn().mockResolvedValue({ written: true, reason: "written" }),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      fakeLedger(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      runFinalizationMemoryWriter,
    );

    await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "completed",
      error_json: "",
    });

    expect(runFinalizationMemoryWriter.writeVerifiedOutputMemory).toHaveBeenCalledWith(TENANT_ID, RUN_ID);
  });

  it("does not attempt a memory write on a failed run", async () => {
    const ledger = fakeLedger();
    vi.mocked(ledger.finalizeRun).mockResolvedValue({
      status: "failed",
      endedAt: "2026-07-28T00:00:01.000Z",
    });
    const runFinalizationMemoryWriter = { writeVerifiedOutputMemory: vi.fn() };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      ledger,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      runFinalizationMemoryWriter,
    );

    await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "failed",
      error_json: "{}",
    });

    expect(runFinalizationMemoryWriter.writeVerifiedOutputMemory).not.toHaveBeenCalled();
  });

  it("stays fail-open: a memory-writer error never breaks the real finalizeRun response", async () => {
    const runFinalizationMemoryWriter = {
      writeVerifiedOutputMemory: vi.fn().mockRejectedValue(new Error("memory service unavailable")),
    };
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]),
      fakeLedger(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      runFinalizationMemoryWriter,
    );

    const response = await nodeexec.finalizeRun({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      status: "completed",
      error_json: "",
    });

    expect(response.status).toBe("completed");
  });
});

describe("NodeexecService failure cause (#149)", () => {
  /** A handler that always throws whatever it is given. */
  function throwingHandler(error: unknown): NodeHandler {
    return {
      nodeType: "Merge",
      execute: () => {
        throw error;
      },
    } as unknown as NodeHandler;
  }

  async function failWith(error: unknown): Promise<{ code: string; detail: string }> {
    const ledger = fakeLedger();
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([throwingHandler(error)]),
      ledger,
    );
    await expect(
      nodeexec.executeNode({
        tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
        node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
        success_criteria: [],
      }),
    ).rejects.toBeDefined();
    return vi.mocked(ledger.recordFailed).mock.calls[0]![1] as {
      code: string;
      detail: string;
    };
  }

  it("keeps the message of an error that carries no code", async () => {
    // This is the whole defect: the message used to be replaced by the
    // constant "Node execution failed", which matches none of the
    // classifier's patterns, so the failure classified as `unknown`.
    const failure = await failWith(new Error("model gateway returned no content"));

    expect(failure.code).toBe("NODE_EXECUTION_FAILED");
    expect(failure.detail).toBe("model gateway returned no content");
  });

  it("uses a string code as the error code", async () => {
    const failure = await failWith(
      Object.assign(new Error("credential is missing"), { code: "CREDENTIAL_MISSING" }),
    );

    expect(failure.code).toBe("CREDENTIAL_MISSING");
    expect(failure.detail).toBe("credential is missing");
  });

  it("names a gRPC status number so the classifier can read it", async () => {
    // 14 is UNAVAILABLE. As a bare number it matched no pattern; named, the
    // classifier scores it as an infrastructure_failure, which is the one
    // thing a transport error should be.
    const failure = await failWith(
      Object.assign(new Error("no connection established"), { code: 14 }),
    );

    expect(failure.code).toBe("UNAVAILABLE");
  });

  it("falls back to the error name when the message is empty", async () => {
    // `name`, not `constructor.name`: a subclass that does not assign
    // `this.name` inherits "Error", but every error class in this codebase
    // assigns it, and `constructor.name` would not survive a minified bundle.
    class SandboxSessionLost extends Error {
      constructor(message: string) {
        super(message);
        this.name = "SandboxSessionLost";
      }
    }
    const failure = await failWith(new SandboxSessionLost(""));

    expect(failure.detail).toBe("SandboxSessionLost");
  });

  it("still reports a non-Error throw without inventing a cause", async () => {
    const failure = await failWith("a bare string");

    expect(failure).toEqual({
      code: "NODE_EXECUTION_FAILED",
      detail: "Node execution failed",
    });
  });
});

// C36, design log §5.2: the mechanical check before the semantic gate.
describe("NodeexecService mechanical check", () => {
  function run(output: Record<string, unknown>) {
    const ledger = fakeLedger();
    const scoreNodeInline = vi.fn().mockResolvedValue({
      verdict: "pass", score: 1, threshold: 0.8, reviewer_model: "ADVANCED", details_json: "{}",
    });
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([{ nodeType: "ToolCall", execute: vi.fn().mockResolvedValue({ output }) }]),
      ledger, undefined, undefined, undefined, undefined, undefined,
      { scoreNodeInline } as unknown as VerifyGateService,
    );
    const call = nodeexec.executeNode({
      tenant_id: TENANT_ID, run_id: RUN_ID, node_execution_id: NODE_EXECUTION_ID,
      node_key: "update_order", node_type: "ToolCall",
      config_json: JSON.stringify({ tool_name: "database.update", input: {} }),
      inputs_json: "{}", success_criteria: [],
    });
    return { call, ledger, scoreNodeInline };
  }

  it("fails a write that changed nothing, before any semantic review", async () => {
    const { call, ledger, scoreNodeInline } = run({ rowCount: 0, rows: [] });

    await expect(call).rejects.toThrow(/affected no rows/);

    expect(scoreNodeInline).not.toHaveBeenCalled();
    expect(ledger.recordSucceeded).not.toHaveBeenCalled();
    expect(ledger.recordFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "MECHANICAL_CHECK_FAILED" }));
  });

  it("passes a confirmed write on to the semantic gate and records the basis", async () => {
    const { call, scoreNodeInline } = run({ rowCount: 1, rows: [] });

    const response = await call;

    expect(scoreNodeInline).toHaveBeenCalledOnce();
    expect(JSON.parse(response.metadata_json)).toMatchObject({
      mechanical_check: { confirmed: true, basis: "database reported 1 affected row(s)" },
    });
  });
});
