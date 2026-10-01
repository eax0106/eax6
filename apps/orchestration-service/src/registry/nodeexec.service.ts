import type {
  NodeexecExecuteNodeRequest,
  NodeexecExecuteNodeResponse,
  NodeexecFinalizeApprovalNodeRequest,
  NodeexecFinalizeApprovalNodeResponse,
  NodeexecFinalizeRunRequest,
  NodeexecFinalizeRunResponse,
} from "@alterx/contracts";
import {
  hasExternalSideEffect,
  GENERATED_FILES_OUTPUT_INSTRUCTION,
  ModelAliasSchema,
  NodeTypeSchema,
  ProblemDetailsSchema,
  type NodeType,
} from "@alterx/contracts";

import type {
  CapabilityServiceHandlerClient,
  PerformanceRecorderHandler,
  SelectionBindingHandler,
} from "@alterx/adapters";

import { NodeHandlerValidationError } from "./handler";
import type { NodeHandlerRegistry } from "./node-handler-registry";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";
import type { RecoveryTriggerService } from "../recovery/recovery-trigger.service";
import type { RunOutcomeService } from "../runs/run-outcome.service";
import type { ProjectRunProvisioningService } from "../runs/project-run-provisioning.service";
import type { RunWorkspaceLookupService } from "../runs/run-workspace-lookup.service";
import type { GeneratedFileMaterializer } from "./generated-file-materializer";
import type { SelectionBindingFailClosedConfig } from "./selection-binding-fail-closed-config";
import type { RunFinalizationMemoryWriter } from "./run-finalization-memory-writer";
import {
  SAFETY_BLOCKED_REVIEWER_MODEL,
  SafetyViolationError,
  VerifyGateError,
  type VerifyGateService,
} from "./verify-gate.service";
import { createVerificationResultId } from "./verification-result-id";
import { MechanicalCheckFailedError, mechanicalCheck } from "./mechanical-check";
import type { RunAcceptanceCheck } from "./run-acceptance-check";

/**
 * Real producer of FailureClass "agent_creation_failure" (recovery-
 * classification.ts). Thrown only when Selection & Binding genuinely
 * found no eligible agent AND the compiled config has no fallback
 * model_alias to run with anyway -- never for a transient/infra failure
 * calling Selection & Binding itself, which stays fail-open regardless of
 * the kill switch (see #resolveAgentBindingBestEffort).
 */
export class AgentCreationFailedError extends Error {
  readonly code = "AGENT_CREATION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "AgentCreationFailedError";
  }
}

/**
 * The node already reached the outside world in this run (design log §4).
 * Carries its own code so Recovery sees why, not a generic failure.
 */
export class SideEffectAlreadyAppliedError extends Error {
  readonly code = "SIDE_EFFECT_ALREADY_APPLIED";

  constructor(nodeKey: string, toolName: string, priorStatus: string) {
    super(
      `Node "${nodeKey}" already called ${toolName} in this run (${priorStatus}); ` +
        "re-running it could repeat an external action, so it needs a person's decision",
    );
    this.name = "SideEffectAlreadyAppliedError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectOrEmpty(json: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json ?? "{}");
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonObject(json: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    throw new NodeHandlerValidationError(
      `${field} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new NodeHandlerValidationError(`${field} must parse to an object`);
  }
  return parsed;
}

function parseInputs(json: string): Record<string, Record<string, unknown>> {
  const raw = parseJsonObject(json, "inputs_json");
  const inputs: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    inputs[key] = isPlainObject(value) ? value : {};
  }
  return inputs;
}

function isGeneratedFileNode(request: NodeexecExecuteNodeRequest): boolean {
  return request.node_type === "LLMTask" && request.node_key === "node_generate_code";
}

function withGeneratedFileInstruction(
  config: Record<string, unknown>,
  generatedFileNode: boolean,
): Record<string, unknown> {
  if (!generatedFileNode || typeof config["prompt"] !== "string") return config;
  return {
    ...config,
    prompt: `${config["prompt"]}\n\n${GENERATED_FILES_OUTPUT_INSTRUCTION}`,
  };
}

/**
 * gRPC-facing NodeexecHandler. The Executor reaches every handler through
 * this boundary, so it owns the minimal durable node-executions ledger:
 * started before dispatch; succeeded/failed after dispatch. Full run
 * lifecycle and artifact output references remain EXEC-14 scope.
 */
export class NodeexecService {
  constructor(
    private readonly registry: NodeHandlerRegistry,
    private readonly ledger: NodeExecutionLedgerService,
    private readonly streamEvents?: RunStreamEventService,
    private readonly recovery?: RecoveryTriggerService,
    private readonly runOutcomes?: RunOutcomeService,
    private readonly projectProvisioning?: ProjectRunProvisioningService,
    private readonly generatedFileMaterializer?: GeneratedFileMaterializer,
    private readonly verifyGate?: VerifyGateService,
    private readonly runWorkspaceLookup?: RunWorkspaceLookupService,
    private readonly capabilityResolver?: CapabilityServiceHandlerClient,
    private readonly selectionBinding?: SelectionBindingHandler,
    private readonly performanceRecorder?: PerformanceRecorderHandler,
    private readonly selectionBindingFailClosed?: SelectionBindingFailClosedConfig,
    private readonly runFinalizationMemoryWriter?: RunFinalizationMemoryWriter,
    private readonly runAcceptance?: RunAcceptanceCheck,
    // D5: marks an approval skipped on timeout and flags its run.
    private readonly approvalSkips?: { markSkipped(tenantId: string, runId: string, nodeExecutionId: string): Promise<void> },
  ) {}

  async executeNode(
    request: NodeexecExecuteNodeRequest,
  ): Promise<NodeexecExecuteNodeResponse> {
    if (request.node_key.trim().length === 0) {
      throw new NodeHandlerValidationError("node_key is required");
    }
    if (request.node_type.trim().length === 0) {
      throw new NodeHandlerValidationError("node_type is required");
    }
    const nodeType = NodeTypeSchema.safeParse(request.node_type);
    if (!nodeType.success) {
      throw new NodeHandlerValidationError("node_type is not recognized");
    }

    const inputRef = safeInputRef(request.inputs_json);
    const started = await this.ledger.recordStarted({
      tenantId: request.tenant_id,
      runId: request.run_id,
      nodeExecutionId: request.node_execution_id,
      dagNodeId: request.node_key,
      nodeType: request.node_type,
      ...(inputRef === undefined ? {} : { inputRef }),
      ...modelAliasFromConfigJson(request.config_json),
    });
    await this.#ensureRunStatusBestEffort(request);
    await this.#appendBestEffort({
      event: "node.started",
      data: {
        node_execution_id: request.node_execution_id,
        dag_node_key: request.node_key,
        node_type: nodeType.data,
        attempt: started.attempt,
        started_at: started.startedAt,
      },
    }, request);

    let boundAgentId: string | undefined;
    let executedMetadata: Record<string, unknown> | undefined;
    const executionStartedAtMs = Date.now();
    try {
      const config = parseJsonObject(request.config_json, "config_json");
      const inputs = parseInputs(request.inputs_json);
      const generatedFileNode = isGeneratedFileNode(request);
      const configuredSandboxSessionId = config["sandbox_session_id"];
      const sandboxSessionId =
        typeof configuredSandboxSessionId === "string"
          ? configuredSandboxSessionId
          : configuredSandboxSessionId === undefined &&
              (generatedFileNode || request.node_type === "SandboxExec")
            ? await this.projectProvisioning?.getSessionForRun(
                request.tenant_id,
                request.run_id,
              )
            : undefined;
      const executionConfig = withGeneratedFileInstruction(
        sandboxSessionId !== undefined && configuredSandboxSessionId === undefined
          ? { ...config, sandbox_session_id: sandboxSessionId }
          : config,
        generatedFileNode,
      );
      const agentBinding = await this.#resolveAgentBindingBestEffort(request, executionConfig);
      boundAgentId = agentBinding.agent_id;
      const successCriteria = request.success_criteria ?? [];
      const sideEffectId = await this.#passIdempotencyGate(request, executionConfig);
      const result = await this.registry.execute(request.node_type, {
        config: executionConfig,
        inputs,
        ...(successCriteria.length === 0 ? {} : { success_criteria: successCriteria }),
        tenant_id: request.tenant_id,
        run_id: request.run_id,
        node_execution_id: request.node_execution_id,
        ...(typeof sandboxSessionId === "string"
          ? { sandbox_session_id: sandboxSessionId }
          : {}),
        ...agentBinding,
        on_model_delta: async (delta, index, final) =>
          this.#appendBestEffort({
            event: "model.delta",
            data: { node_execution_id: request.node_execution_id, delta, index, final },
          }, request),
      });

      executedMetadata = result.metadata;
      if (sideEffectId !== undefined) {
        await this.#settleSideEffect(request.tenant_id, sideEffectId, result);
      }
      if (request.node_type === "SandboxExec") {
        await this.#appendTerminalFramesBestEffort(request, result.output);
      }

      const outputJson = JSON.stringify(result.output);
      let metadata = result.metadata ?? {};

      if (result.metadata?.["execution_status"] === "blocked_pending_recovery") {
        const reason = String(result.output["reason"] ?? "verification blocked external action");
        await this.ledger.recordBlockedPendingRecovery(
          { tenantId: request.tenant_id, runId: request.run_id, nodeExecutionId: request.node_execution_id },
          reason,
        );
        await this.#triggerRecoveryBestEffort(request, reason);
        return { output_json: outputJson, metadata_json: JSON.stringify(metadata) };
      }

      if (result.metadata?.["execution_status"] === "pending_approval") {
        // HEAL-7: this node_execution is not done -- it stays 'running'
        // until FinalizeApprovalNode resolves it. Do not call recordSucceeded/
        // recordFailed, which would prematurely mark it terminal. Reuses
        // the Foundation-phase "approval.requested" SSE contract.
        const approvalId = result.output["approval_id"];
        const expiryAt = result.output["expiry_at"];
        if (typeof approvalId === "string" && typeof expiryAt === "string") {
          await this.#appendBestEffort({
            event: "approval.requested",
            data: {
              approval_id: approvalId,
              node_execution_id: request.node_execution_id,
              requested_action: config,
              requested_at: new Date().toISOString(),
              expiry_at: expiryAt,
            },
          }, request);
        }
        return { output_json: outputJson, metadata_json: JSON.stringify(metadata) };
      }

      const problem = ProblemDetailsSchema.safeParse(result.output);
      if (problem.success && problem.data.status >= 400) {
        await this.ledger.recordFailed(
          {
            tenantId: request.tenant_id,
            runId: request.run_id,
            nodeExecutionId: request.node_execution_id,
          },
          problem.data,
        );
        await this.#appendBestEffort(failedEvent(request, nodeType.data, started.attempt, {
          error_code: problem.data.error_code,
          message: problem.data.detail,
          retryable: problem.data.retryable,
        }), request);
        await this.#recordPerformanceBestEffort(
          request, boundAgentId, "failure", executionStartedAtMs, executedMetadata,
          problem.data.error_code,
        );
      } else {
        const mechanical =
          request.node_type === "ToolCall" && typeof executionConfig["tool_name"] === "string"
            ? mechanicalCheck(executionConfig["tool_name"], result.output)
            : undefined;
        if (mechanical !== undefined) {
          metadata = { ...metadata, mechanical_check: mechanical };
          if ("confirmed" in mechanical && !mechanical.confirmed) {
            throw new MechanicalCheckFailedError(mechanical.reason);
          }
        }
        const verification = await this.verifyGate?.scoreNodeInline({
          tenant_id: request.tenant_id,
          run_id: request.run_id,
          node_execution_id: request.node_execution_id,
          node_key: request.node_key,
          node_type: request.node_type,
          config_json: JSON.stringify(executionConfig),
          output_json: outputJson,
          success_criteria: successCriteria,
        });
        if (verification !== undefined) {
          await this.ledger.recordVerificationResult({
            id: createVerificationResultId(),
            tenantId: request.tenant_id,
            runId: request.run_id,
            nodeExecutionId: request.node_execution_id,
            gateType: "quality",
            verdict: verification.verdict,
            score: verification.score,
            threshold: verification.threshold,
            reviewerModel: verification.reviewer_model,
            detailsJson: verification.details_json,
          });
          metadata = {
            ...metadata,
            verification: {
              verdict: verification.verdict,
              score: verification.score,
              threshold: verification.threshold,
              reviewer_model: verification.reviewer_model,
            },
          };
          if (verification.verdict === "fail" && verification.reviewer_model === SAFETY_BLOCKED_REVIEWER_MODEL) {
            throw new SafetyViolationError(
              "Verify Gate blocked node output as a safety violation; the workflow halts",
            );
          }
          if (verification.verdict === "fail") {
            throw new VerifyGateError(
              "VERIFICATION_GATE_FAILED",
              "Verify Gate rejected node output",
            );
          }
        }
        const outputRef = generatedFileNode
          ? await this.#materializeGeneratedFiles(request, sandboxSessionId, result.output)
          : undefined;
        await this.ledger.recordSucceeded({
          tenantId: request.tenant_id,
          runId: request.run_id,
          nodeExecutionId: request.node_execution_id,
          ...(outputRef === undefined ? {} : { outputRef }),
        });
        await this.#appendBestEffort({ event: "node.completed", data: {
          node_execution_id: request.node_execution_id, dag_node_key: request.node_key,
          node_type: nodeType.data, attempt: started.attempt,
          status: "succeeded", ended_at: new Date().toISOString(),
          ...(verification === undefined ? {} : { verification_verdict: verification.verdict }),
        } }, request);
        await this.#recordPerformanceBestEffort(
          request, boundAgentId, "success", executionStartedAtMs, executedMetadata,
        );
      }
      return { output_json: outputJson, metadata_json: JSON.stringify(metadata) };
    } catch (error: unknown) {
      const failure = persistedError(error);
      await this.ledger.recordFailed(
        {
          tenantId: request.tenant_id,
          runId: request.run_id,
          nodeExecutionId: request.node_execution_id,
        },
        failure,
      );
      // The same failure the ledger and Recovery see. This used to restate the
      // constant independently, so even once the ledger carried a real cause
      // the event stream would still have said "Node execution failed".
      await this.#appendBestEffort(failedEvent(request, nodeType.data, started.attempt, {
        error_code: failure.code, message: failure.detail, retryable: false,
      }), request);
      await this.#recordPerformanceBestEffort(
        request, boundAgentId, "failure", executionStartedAtMs, executedMetadata,
        failure.code,
      );
      // A safety violation halts the whole workflow (design log §4); Recovery
      // is never asked to find a way to keep going.
      if (!(error instanceof SafetyViolationError)) {
        await this.#triggerRecoveryForFailureBestEffort(request, failure);
      }
      throw error;
    }
  }

  /**
   * Design log §4: the idempotency gate in front of every re-execution. A
   * ToolCall whose tool acts on the outside world is recorded in the
   * Side-Effect Ledger before it is called; if this run's node already has
   * such a record, the earlier attempt may have sent the message or written
   * the row, and running it again would do it twice. The node is refused
   * instead, and Recovery hands the decision to a person. Covers every
   * retry path at once: the activity's own retries, Recovery's retry and
   * backoff, and swap_agent.
   */
  async #passIdempotencyGate(
    request: NodeexecExecuteNodeRequest,
    config: Record<string, unknown>,
  ): Promise<string | undefined> {
    const toolName = config["tool_name"];
    if (
      request.node_type !== "ToolCall" ||
      typeof toolName !== "string" ||
      !hasExternalSideEffect(toolName)
    ) {
      return undefined;
    }
    const prior = await this.ledger.priorSideEffects(request.tenant_id, request.run_id, request.node_key);
    if (prior.length > 0) {
      throw new SideEffectAlreadyAppliedError(request.node_key, toolName, prior[prior.length - 1]!.status);
    }
    const id = createVerificationResultId().replace(/^ver_/, "sfx_");
    await this.ledger.recordSideEffectAttempt({
      id,
      tenantId: request.tenant_id,
      runId: request.run_id,
      dagNodeId: request.node_key,
      nodeExecutionId: request.node_execution_id,
      toolName,
    });
    return id;
  }

  /**
   * A returned result settles the attempt: success marks it completed with
   * the gateway's audit id; a call refused before dispatch (validation) is
   * withdrawn, since nothing left Alter; any other failure stays 'attempted'
   * -- a timeout or a gateway error may have acted, and must still block a
   * retry.
   */
  async #settleSideEffect(
    tenantId: string,
    id: string,
    result: { readonly output: Record<string, unknown>; readonly metadata?: Record<string, unknown> },
  ): Promise<void> {
    const problem = ProblemDetailsSchema.safeParse(result.output);
    if (problem.success && problem.data.status >= 400) {
      if (problem.data.error_code === "TOOL_CALL_VALIDATION_FAILED") {
        await this.ledger.withdrawSideEffectAttempt(tenantId, id);
      }
      return;
    }
    const auditId = result.metadata?.["audit_id"];
    await this.ledger.completeSideEffect(tenantId, id, typeof auditId === "string" ? auditId : undefined);
  }

  /**
   * Selection & Binding is resolved fresh here, per LLMTask node, rather
   * than baked into the compiled DAG at plan time -- same runtime-injection
   * shape as sandboxSessionId above, so a swap_agent retry (recovery-
   * dispatch.service.ts) is picked up by the very next execution without
   * recompiling the workflow. Fail-open: LLMTaskHandler falls back to its
   * own compiled config.model_alias whenever this returns {}, whether that's
   * because deps aren't configured, no eligible agent matched, or a real
   * call failed -- a missing binding must never fail the node.
   */
  async #resolveAgentBindingBestEffort(
    request: NodeexecExecuteNodeRequest,
    config: Record<string, unknown>,
  ): Promise<{
    readonly agent_id?: string;
    readonly bound_model_alias?: string;
    readonly bound_tool_names?: readonly string[];
    readonly bound_agent_instructions?: string;
  }> {
    if (
      request.node_type !== "LLMTask" ||
      this.runWorkspaceLookup === undefined ||
      this.capabilityResolver === undefined ||
      this.selectionBinding === undefined
    ) {
      return {};
    }
    let bound: Awaited<ReturnType<SelectionBindingHandler["bindAgentModelTool"]>>;
    try {
      const workspaceId = await this.runWorkspaceLookup.getWorkspaceId(
        request.tenant_id,
        request.run_id,
      );
      const requirements = await this.capabilityResolver.resolveNodeRequirements({
        tenant_id: request.tenant_id,
        run_id: request.run_id,
        node_key: request.node_key,
        node_type: request.node_type,
        node_config_json: JSON.stringify(config),
      });
      bound = await this.selectionBinding.bindAgentModelTool({
        tenant_id: request.tenant_id,
        run_id: request.run_id,
        node_key: request.node_key,
        // ResolveNodeRequirements answers for one node and returns that node's
        // requirement on its own. bind-agent-model-tool takes the DAG-shaped
        // map of node_key to requirement and looks this node up inside it, so
        // the single requirement has to be keyed before it is sent. The graph
        // compiler already does this when it builds a version's requirements
        // (see graph-compiler.service.ts); passing the bare object through
        // here made every bind fail with 422 "node_requirements_json has no
        // entry for node_key".
        node_requirements_json: JSON.stringify({
          [request.node_key]: JSON.parse(requirements.node_requirements_json),
        }),
        // getWorkspaceId returns the bare uuid the runs table stores; the
        // Selection & Binding contract takes a ws_ prefixed identifier, the
        // same way the recovery dispatcher already sends it.
        workspace_id: `ws_${workspaceId}`,
        node_type: request.node_type,
      });
    } catch (error: unknown) {
      // A genuine infra/transport failure calling Selection & Binding
      // itself always stays fail-open, independent of the kill switch --
      // that switch governs a real "no eligible agent" *answer*, not
      // Selection & Binding being unreachable.
      console.error("selection & binding resolution failed for LLMTask node", {
        node_execution_id: request.node_execution_id,
        run_id: request.run_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
    if (!bound.matched) {
      await this.#failClosedIfNoFallback(request, config, bound.reason);
      return {};
    }
    return {
      agent_id: bound.agent_id,
      bound_model_alias: bound.model_alias,
      bound_tool_names: bound.tool_names,
      bound_agent_instructions: bound.instructions,
    };
  }

  /**
   * Kill-switch-gated (default off -- see SelectionBindingFailClosedConfig).
   * A real "no eligible agent" answer only fails the node when there is
   * truly nothing to fall back to (no model_alias in the compiled config
   * either) and an operator has deliberately turned the switch on. Off by
   * default, this is a pure no-op: identical to today's always-fail-open
   * behavior.
   */
  async #failClosedIfNoFallback(
    request: NodeexecExecuteNodeRequest,
    config: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    if (this.selectionBindingFailClosed === undefined) return;
    const hasFallback =
      typeof config["model_alias"] === "string" && config["model_alias"].trim().length > 0;
    if (hasFallback) return;
    const enabled = await this.selectionBindingFailClosed.isEnabled().catch(() => false);
    if (!enabled) return;
    throw new AgentCreationFailedError(
      `No eligible agent for LLMTask node ${request.node_key} and no fallback ` +
        `model_alias in the compiled config (${reason})`,
    );
  }

  /**
   * The real performance_records writer call -- only fires when a real
   * Selection & Binding match happened (agentId defined), so this never
   * attributes performance to a compiled-config model_alias with no agent
   * identity behind it. Best-effort: a recording failure must never affect
   * the node's already-decided success/failure outcome.
   */
  async #recordPerformanceBestEffort(
    request: NodeexecExecuteNodeRequest,
    agentId: string | undefined,
    verdict: "success" | "failure",
    startedAtMs: number,
    metadata: Record<string, unknown> | undefined,
    failureCode?: string,
  ): Promise<void> {
    if (
      request.node_type !== "LLMTask" ||
      agentId === undefined ||
      this.performanceRecorder === undefined
    ) {
      return;
    }
    if (verdict === "failure" && !isAgentAttributableFailure(failureCode)) {
      // Nothing was learned about the agent, so nothing is asserted about it
      // (#164). Logged rather than silent, because "no record" and "a record
      // that was never attempted" look identical in the table afterwards.
      console.warn("performance observation skipped: failure not attributable to the agent", {
        node_execution_id: request.node_execution_id,
        run_id: request.run_id,
        agent_id: agentId,
        error_code: failureCode ?? "unknown",
      });
      return;
    }
    const usage = metadata?.["usage"];
    const inputTokens =
      isPlainObject(usage) && typeof usage["input_tokens"] === "number"
        ? usage["input_tokens"]
        : undefined;
    const outputTokens =
      isPlainObject(usage) && typeof usage["output_tokens"] === "number"
        ? usage["output_tokens"]
        : undefined;
    const tokenCount =
      inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0);
    try {
      await this.performanceRecorder.recordObservation(agentId, {
        tenant_id: request.tenant_id,
        run_id: request.run_id,
        node_type: request.node_type,
        verdict,
        latency_ms: Date.now() - startedAtMs,
        ...(tokenCount === undefined ? {} : { token_count: tokenCount }),
      });
    } catch (error: unknown) {
      console.error("performance observation recording failed", {
        node_execution_id: request.node_execution_id,
        run_id: request.run_id,
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #materializeGeneratedFiles(
    request: NodeexecExecuteNodeRequest,
    sessionId: string | undefined,
    output: Record<string, unknown>,
  ): Promise<string> {
    if (this.generatedFileMaterializer === undefined) {
      throw new NodeHandlerValidationError("Generated-file materializer is not configured");
    }
    const projectDirectory = await this.projectProvisioning?.getProjectDirectoryForRun(
      request.tenant_id,
      request.run_id,
    );
    const materialized = await this.generatedFileMaterializer.materialize({
      tenantId: request.tenant_id,
      runId: request.run_id,
      sessionId,
      projectDirectory,
      output,
    });
    return materialized.manifestArtifactId;
  }

  async #appendBestEffort(
    event: Parameters<RunStreamEventService["append"]>[2],
    request: NodeexecExecuteNodeRequest,
  ): Promise<void> {
    try {
      await this.streamEvents?.append(request.tenant_id, request.run_id, event);
    } catch {
      // SSE journal is convenience transport. Durable node_executions remains source of truth.
    }
  }

  async #appendTerminalFramesBestEffort(
    request: NodeexecExecuteNodeRequest,
    output: Record<string, unknown>,
  ): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      const data = output[stream];
      if (typeof data !== "string" || data.length === 0) continue;
      await this.#appendBestEffort({
        event: "terminal.frame",
        data: { stream, data },
      }, request);
    }
  }

  async #triggerRecoveryBestEffort(
    request: NodeexecExecuteNodeRequest,
    reason: string,
  ): Promise<void> {
    try {
      await this.recovery?.triggerForBlockedNode({
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
        reason,
      });
    } catch (error: unknown) {
      // HEAL-6 known gap: no reconciler re-scans blocked nodes lacking a
      // recovery_actions row if this best-effort trigger fails. The block
      // write above already durably succeeded either way.
      console.error("recovery trigger failed for blocked node", {
        node_execution_id: request.node_execution_id,
        run_id: request.run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Self-Healing exit-check closure: genuine node exceptions (thrown, not
   * Gate-blocked) previously never reached HEAL-5/6 at all, so retry/backoff
   * (and every other strategy) could never actually fire on a real failure
   * class like timeout/infrastructure_failure/rate_limit -- only against
   * Gate-blocked nodes. This is the same best-effort contract as the
   * blocked-node trigger: the failed ledger write above already succeeded
   * durably, so a trigger failure here must not crash the node's response
   * to the Executor.
   */
  async #triggerRecoveryForFailureBestEffort(
    request: NodeexecExecuteNodeRequest,
    failure: { readonly code: string; readonly detail: string },
  ): Promise<void> {
    try {
      await this.recovery?.triggerForFailedNode({
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
        errorCode: failure.code,
        detail: failure.detail,
      });
    } catch (error: unknown) {
      console.error("recovery trigger failed for failed node", {
        node_execution_id: request.node_execution_id,
        run_id: request.run_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * HEAL-8: run_outcomes is the VACR/VADR metric source of truth -- a
   * missing verdict is a real gap, not acceptable to silently swallow like
   * the SSE best-effort calls elsewhere in this file. Still caught (not
   * thrown) here so a metrics-write failure never breaks the actual
   * finalizeRun RPC response the Executor workflow is waiting on -- but
   * logged loudly, unlike the SSE convenience-transport catches.
   */
  async #recordOutcomeBestEffort(
    tenantId: string,
    runId: string,
    status: string,
  ): Promise<void> {
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      return;
    }
    try {
      await this.runOutcomes?.recordOutcome(tenantId, runId, status);
    } catch (error: unknown) {
      console.error("run_outcomes write failed -- VACR/VADR metrics gap", {
        run_id: runId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Executor-mandatory MemoryWrite (see run-finalization-memory-writer.ts).
   * Same fail-open, best-effort shape as #recordOutcomeBestEffort just
   * above: a missing/skipped memory write is an expected, silent outcome
   * for most runs (no single verified terminal node), never something that
   * should break the real finalizeRun RPC response.
   */
  async #writeVerifiedOutputMemoryBestEffort(
    tenantId: string,
    runId: string,
  ): Promise<void> {
    try {
      await this.runFinalizationMemoryWriter?.writeVerifiedOutputMemory(tenantId, runId);
    } catch (error: unknown) {
      console.error("run finalization memory write failed", {
        run_id: runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #ensureRunStatusBestEffort(
    request: NodeexecExecuteNodeRequest,
  ): Promise<void> {
    try {
      await this.streamEvents?.ensureRunRunning(
        request.tenant_id,
        request.run_id,
      );
    } catch {
      // SSE journal is convenience transport. Durable node_executions remains source of truth.
    }
  }

  /**
   * The Executor workflow's try/finally calls this exactly once, on
   * success or failure -- the only durable write of the run's terminal
   * status (EXEC-14). Idempotent via the ledger's status-guarded UPDATE.
   */
  async finalizeRun(
    request: NodeexecFinalizeRunRequest,
  ): Promise<NodeexecFinalizeRunResponse> {
    if (request.status !== "completed" && request.status !== "failed") {
      throw new NodeHandlerValidationError(
        `finalizeRun status must be "completed" or "failed", got "${request.status}"`,
      );
    }
    // Design log §5.3: a run whose every node passed still has to deliver
    // what the user asked for as a whole. A completed run that fails its
    // end-of-run check -- or whose check cannot complete (§5.5) -- is
    // finalized as failed, never counted as a success.
    let status: "completed" | "failed" = request.status;
    let acceptanceFailure: string | undefined;
    if (status === "completed" && this.runAcceptance !== undefined) {
      const acceptance = await this.runAcceptance.check(request.tenant_id, request.run_id);
      if (acceptance.checked && !acceptance.passed) {
        status = "failed";
        acceptanceFailure = acceptance.reason;
      }
    }
    const result = await this.ledger.finalizeRun(
      request.tenant_id,
      request.run_id,
      status,
    );
    // Project sessions outlive individual node calls, but not the run. This
    // call deliberately remains on the real terminal activity path so an
    // unavailable Provisioning service fails the activity and Temporal
    // retries cleanup instead of silently orphaning the sandbox.
    await this.projectProvisioning?.closeForTerminalRun(
      request.tenant_id,
      request.run_id,
    );
    await this.#recordOutcomeBestEffort(request.tenant_id, request.run_id, result.status);
    if (result.status === "completed") {
      await this.#writeVerifiedOutputMemoryBestEffort(request.tenant_id, request.run_id);
    }
    // Only emit when the ledger actually applied *this* finalize -- if the
    // run was already terminal for another reason (e.g. cancelled
    // concurrently), result.status reflects that real state instead, and
    // the SSE stream must not misreport it as completed/failed.
    if (result.status === "completed" || result.status === "failed") {
      try {
        await this.streamEvents?.append(request.tenant_id, request.run_id, {
          event: "run.status",
          data: {
            status: result.status,
            ...(acceptanceFailure === undefined ? {} : { reason: acceptanceFailure }),
          },
        });
      } catch {
        // SSE journal is convenience transport. Durable runs.status remains source of truth.
      }
    }
    return { status: result.status, ended_at: result.endedAt };
  }

  /**
   * Resolves a HumanApproval node_execution left 'running' by executeNode's
   * pending-approval branch, once the Executor workflow's durable wait
   * receives a decision (or expiry). Reuses the same ledger transitions
   * every other node uses -- an approved node "succeeds", a rejected or
   * expired one "fails" -- so downstream consumers (node inspector,
   * run history) see no special-cased state. HEAL-7.
   */
  async finalizeApprovalNode(
    request: NodeexecFinalizeApprovalNodeRequest,
  ): Promise<NodeexecFinalizeApprovalNodeResponse> {
    if (request.decision !== "approved" && request.decision !== "rejected") {
      throw new NodeHandlerValidationError(
        `finalizeApprovalNode decision must be "approved" or "rejected", got "${request.decision}"`,
      );
    }

    if (request.decision === "approved") {
      if (parseJsonObjectOrEmpty(request.decision_output_json)["skipped"] === true) {
        await this.approvalSkips?.markSkipped(request.tenant_id, request.run_id, request.node_execution_id);
      }
      await this.ledger.recordSucceeded({
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
        outputRef: request.node_key,
      });
      await this.#appendApprovalOutcomeBestEffort(request, "succeeded", null);
      return { status: "succeeded" };
    }

    const error = { code: "HUMAN_APPROVAL_REJECTED", detail: "Approval was rejected or expired" };
    await this.ledger.recordFailed(
      {
        tenantId: request.tenant_id,
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
      },
      error,
    );
    await this.#appendApprovalOutcomeBestEffort(request, "failed", error);
    return { status: "failed" };
  }

  async #appendApprovalOutcomeBestEffort(
    request: NodeexecFinalizeApprovalNodeRequest,
    status: "succeeded" | "failed",
    error: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      if (status === "succeeded") {
        await this.streamEvents?.append(request.tenant_id, request.run_id, {
          event: "node.completed",
          data: {
            node_execution_id: request.node_execution_id,
            dag_node_key: request.node_key,
            node_type: "HumanApproval",
            attempt: 1,
            status: "succeeded",
            ended_at: new Date().toISOString(),
          },
        });
      } else {
        await this.streamEvents?.append(request.tenant_id, request.run_id, {
          event: "node.failed",
          data: {
            node_execution_id: request.node_execution_id,
            dag_node_key: request.node_key,
            node_type: "HumanApproval",
            attempt: 1,
            status: "failed",
            error: {
              error_code: String(error?.["code"] ?? "HUMAN_APPROVAL_REJECTED"),
              message: String(error?.["detail"] ?? "Approval was rejected or expired"),
              retryable: false,
            },
            ended_at: new Date().toISOString(),
          },
        });
      }
    } catch {
      // SSE journal is convenience transport. Durable node_executions remains source of truth.
    }
  }
}

function safeInputRef(inputsJson: string): string | undefined {
  try {
    const raw = JSON.parse(inputsJson) as unknown;
    if (!isPlainObject(raw)) return undefined;
    const keys = Object.keys(raw);
    return keys.length === 0 ? undefined : keys.join(",");
  } catch {
    // Best-effort only -- the strict inputs_json parse/validation on the
    // dispatch path (parseInputs, below) is what actually fails the node;
    // this must never change that outcome.
    return undefined;
  }
}

function failedEvent(
  request: NodeexecExecuteNodeRequest,
  nodeType: NodeType,
  attempt: number,
  error: { readonly error_code: string; readonly message: string; readonly retryable: boolean },
): Parameters<RunStreamEventService["append"]>[2] {
  return { event: "node.failed", data: {
    node_execution_id: request.node_execution_id,
    dag_node_key: request.node_key,
    node_type: nodeType,
    attempt, status: "failed", error, ended_at: new Date().toISOString(),
  } };
}

function modelAliasFromConfigJson(configJson: string): { readonly modelAlias?: "FAST" | "STANDARD" | "ADVANCED" | "CEILING" } {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (!isPlainObject(parsed)) return {};
    const modelAlias = ModelAliasSchema.safeParse(parsed["model_alias"]);
    return modelAlias.success ? { modelAlias: modelAlias.data } : {};
  } catch {
    return {};
  }
}

/**
 * The failure codes that say something about the agent that was bound, rather
 * than about the platform it ran on.
 *
 * A `performance_records` row is an assertion that this agent did badly, and
 * Selection & Binding turns those rows into `performance_score` -- 20% of
 * `combined_score` at the default weights -- so one row routes work away from
 * that agent for good. A Verify Service outage, a gateway that could not be
 * reached, a node config that never named a model: none of those are evidence
 * about the agent, and recording them punished whichever agent happened to be
 * bound when the platform had a bad minute (#164). It also decayed fastest for
 * the agent currently judged best, because that is the agent most often bound
 * and therefore most exposed.
 *
 * An allowlist, not a denylist of infrastructure codes: an unrecognised code
 * is a failure nobody has classified yet, and the honest answer to "whose
 * fault was that" is silence. Losing a negative signal costs a ranking nudge;
 * inventing one poisons the ranking permanently.
 */
const AGENT_ATTRIBUTABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  // The model's own answer failed validation -- prose where JSON was asked
  // for, a truncated object. What the agent produced, judged on its face.
  "MODEL_OUTPUT_INVALID",
  // Verify Gate scored this output a fail. That is a verdict on the output,
  // which is the agent's; VERIFY_SERVICE_UNAVAILABLE, the outage, is not here.
  "VERIFICATION_GATE_FAILED",
]);

function isAgentAttributableFailure(code: string | undefined): boolean {
  return code !== undefined && AGENT_ATTRIBUTABLE_FAILURE_CODES.has(code);
}

/**
 * gRPC status numbers, named. A transport failure arrives with a numeric
 * `code`, which carries no signal for anyone reading the row and none for
 * FailureClassifier, whose patterns are textual. These are the ones the
 * classifier can act on: UNAVAILABLE and INTERNAL_ERROR are infrastructure
 * failures, DEADLINE_EXCEEDED a timeout, RESOURCE_EXHAUSTED a rate limit,
 * PERMISSION_DENIED a tool permission denial. Named here rather than
 * importing @grpc/grpc-js, which is an adapter concern.
 */
const GRPC_STATUS_NAMES: Readonly<Record<number, string>> = {
  4: "DEADLINE_EXCEEDED",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  13: "INTERNAL_ERROR",
  14: "UNAVAILABLE",
  16: "UNAUTHENTICATED",
};

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { readonly code: unknown }).code;
  if (typeof code === "string" && code.trim().length > 0) return code;
  if (typeof code === "number") return GRPC_STATUS_NAMES[code];
  return undefined;
}

/**
 * What Recovery is handed to classify a node failure.
 *
 * The fallback was a constant -- `NODE_EXECUTION_FAILED`, message discarded --
 * for everything that is not one of the three named types below.
 * FailureClassifier matches on the code, and at lower confidence on the detail
 * text, so a constant matching no pattern classified every unrecognised
 * failure as `unknown`. The strategy table maps `unknown` to `ask_user`, which
 * left seven of the eight dispatchable strategies unreachable in practice, and
 * each failure still spent an ADVANCED model call to be told the input carried
 * nothing (#149).
 *
 * The real message is now always kept, and a code derived wherever the error
 * carries one. `NODE_EXECUTION_FAILED` remains only for an error offering
 * neither.
 */
function persistedError(error: unknown): { readonly code: string; readonly detail: string } {
  if (error instanceof VerifyGateError) {
    return { code: error.code, detail: error.message };
  }
  if (error instanceof NodeHandlerValidationError) {
    return { code: "NODE_HANDLER_VALIDATION_FAILED", detail: error.message };
  }
  if (error instanceof AgentCreationFailedError) {
    return { code: error.code, detail: error.message };
  }
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    code: errorCodeOf(error) ?? "NODE_EXECUTION_FAILED",
    // The class name is worth keeping when the message is empty: it is the
    // only thing separating one silent failure from another.
    detail:
      message.length > 0
        ? message
        : error instanceof Error && error.name.length > 0
          ? error.name
          : "Node execution failed",
  };
}
