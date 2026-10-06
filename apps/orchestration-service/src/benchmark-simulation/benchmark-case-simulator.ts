import { v7 as uuidv7 } from "uuid";
import { CompiledDagSchema, type CompiledDag, type ScoreNodeInlineRequest, type ScoreNodeInlineResponse } from "@alterx/contracts";

import { ReferenceProblem, resolveArgumentReferences } from "../registry/handlers/toolcall.handler";

import type { NodeExecutionContext, NodeExecutionResult } from "../registry/handler";
import type { VerificationGateReader, VerificationResultRecord } from "../registry/verification-gate-reader";

/**
 * D25 (b): one benchmark case runs through Simulate. The workflow's current
 * compiled version executes in wave order with the case input as its trigger
 * payload. Compute nodes (model calls, gates, merges) execute for real through
 * the same handlers a run uses, and each executed node's output is scored by
 * the Verification & Quality Gate as it is in a run. Nodes that would act
 * outside Alter never execute: their step is recorded as simulated, with the
 * action it would have taken. The case is then judged by the Verification &
 * Quality Gate against the case's own success criteria, with the rubric a
 * run's own acceptance check uses.
 *
 * Routing follows a run's: a node behind conditional edges executes only when
 * a Gate in front of it chose it, exactly as the Executor decides
 * (isNodeGatedOff in executor-workflow.ts), and is otherwise recorded as
 * skipped. The verification gates the compiler puts before each outside
 * action open the way only when the step they check was executed; that step
 * has already been scored here, and a failed score has already stopped the
 * case, so they are not scored a second time.
 */

/** Node types whose execution reaches outside Alter or waits on a person. */
export const SIMULATED_NODE_TYPES: ReadonlySet<string> = new Set([
  "ToolCall",
  "SandboxExec",
  "MemoryWrite",
  "PubSub",
  "HumanApproval",
]);

export interface BenchmarkComputeHandlers {
  execute(nodeType: string, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export interface BenchmarkVerifier {
  scoreNodeInline(request: ScoreNodeInlineRequest): Promise<ScoreNodeInlineResponse>;
}

export interface BenchmarkWorkflowVersions {
  previewRun(tenantId: string, workflowId: string): Promise<{
    readonly workspaceId: string;
    readonly workflowVersionId: string;
    readonly compiledDag: CompiledDag;
  }>;
}

export interface BenchmarkCaseRequest {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly caseId: string;
  readonly input: Record<string, unknown>;
  readonly successCriteria: readonly string[];
}

export interface BenchmarkStep {
  readonly key: string;
  readonly type: string;
  readonly status: "executed" | "simulated" | "skipped" | "failed";
  readonly action?: string;
  readonly verdict?: string;
  readonly error?: string;
}

export interface BenchmarkCaseResult {
  readonly caseId: string;
  readonly workflowVersionId: string;
  readonly simulationRunId: string;
  readonly verdict: "pass" | "fail" | "error";
  readonly score: number | null;
  readonly threshold: number | null;
  readonly reviewerModel: string | null;
  readonly output: Record<string, unknown>;
  readonly steps: readonly BenchmarkStep[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly estimatedCostUsd: number | null };
  readonly durationMs: number;
  readonly error: string | null;
}

/** Scores recorded during one simulation, served to Gate and Synthesis nodes. */
class SimulationVerificationResults implements VerificationGateReader {
  readonly #byNode = new Map<string, VerificationResultRecord[]>();

  record(nodeKey: string, result: ScoreNodeInlineResponse): void {
    const records = this.#byNode.get(nodeKey) ?? [];
    records.push({
      gateType: "quality",
      verdict: result.verdict,
      score: result.score,
      threshold: result.threshold,
      details: parseDetails(result.details_json),
    });
    this.#byNode.set(nodeKey, records);
  }

  async findForSourceNode(request: { readonly sourceNodeKey: string }): Promise<readonly VerificationResultRecord[]> {
    return this.#byNode.get(request.sourceNodeKey) ?? [];
  }
}

function parseDetails(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function simulatedAction(type: string, config: Record<string, unknown>): string {
  const toolName = typeof config["tool_name"] === "string" ? config["tool_name"] : undefined;
  return toolName === undefined ? type : `${type}:${toolName}`;
}

/** The workflow is not in the case's workspace; it is reported as not found. */
export class BenchmarkWorkflowNotInWorkspaceError extends Error {
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} was not found in this workspace`);
    this.name = "BenchmarkWorkflowNotInWorkspaceError";
  }
}

export class BenchmarkCaseSimulator {
  constructor(
    private readonly versions: BenchmarkWorkflowVersions,
    private readonly computeHandlers: (verification: VerificationGateReader) => BenchmarkComputeHandlers,
    private readonly verifier: BenchmarkVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  async simulateCase(request: BenchmarkCaseRequest): Promise<BenchmarkCaseResult> {
    const startedAt = this.now();
    const version = await this.versions.previewRun(request.tenantId, request.workflowId);
    if (version.workspaceId !== request.workspaceId.replace(/^ws_/, "")) {
      throw new BenchmarkWorkflowNotInWorkspaceError(request.workflowId);
    }
    const dag = CompiledDagSchema.parse(version.compiledDag);
    const simulationRunId = `run_${uuidv7()}`;
    const verification = new SimulationVerificationResults();
    const handlers = this.computeHandlers(verification);
    const outputs = new Map<string, Record<string, unknown>>();
    const steps: BenchmarkStep[] = [];
    const usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: null as number | null };
    const inputKey = `benchmark.${request.caseId}`;
    const nodes = new Map(dag.nodes.map((node) => [node.key, node]));

    const finish = (
      verdict: BenchmarkCaseResult["verdict"],
      judged: ScoreNodeInlineResponse | undefined,
      output: Record<string, unknown>,
      error: string | null,
    ): BenchmarkCaseResult => ({
      caseId: request.caseId,
      workflowVersionId: version.workflowVersionId,
      simulationRunId,
      verdict,
      score: judged === undefined ? null : Number(judged.score),
      threshold: judged === undefined ? null : Number(judged.threshold),
      reviewerModel: judged?.reviewer_model ?? null,
      output,
      steps,
      usage,
      durationMs: this.now() - startedAt,
      error,
    });

    for (const wave of [...dag.waves].sort((a, b) => a.order - b.order)) {
      for (const key of wave.node_keys) {
        const node = nodes.get(key);
        if (node === undefined) continue;
        const config = isPlainObject(node.config) ? node.config : {};
        const predecessors = dag.edges.filter((edge) => edge.to === key).map((edge) => edge.from);
        const inputs: Record<string, Record<string, unknown>> = {};
        if (predecessors.length === 0) {
          inputs[inputKey] = request.input;
        }
        for (const predecessor of predecessors) {
          inputs[predecessor] = outputs.get(predecessor) ?? {};
        }
        const gates = gatingPredecessors(dag, key, outputs);
        if (gates !== undefined) {
          outputs.set(key, { skipped: true, reason: "gated_off_by_condition", gate_node_keys: gates });
          steps.push({ key, type: node.type, status: "skipped" });
          continue;
        }
        const verifies = node.type === "Gate" ? verificationTarget(config) : undefined;
        if (verifies !== undefined) {
          const checked = outputs.get(verifies.source);
          const executed = checked !== undefined && checked["skipped"] !== true
            && steps.some((step) => step.key === verifies.source && step.status === "executed" && step.verdict === "pass");
          outputs.set(key, executed
            ? { activeSuccessors: [verifies.protects], verification_status: "passed", verification_source_node_key: verifies.source }
            : { activeSuccessors: [], verification_status: "source_not_verified", blocked_successor: verifies.protects });
          steps.push({ key, type: node.type, status: "simulated", action: "verification" });
          continue;
        }
        if (SIMULATED_NODE_TYPES.has(node.type)) {
          // The action never runs. What it would have been given is kept, so
          // the judge can check what the workflow would have sent or written.
          const action = simulatedAction(node.type, config);
          try {
            let arguments_: unknown;
            if (node.type === "ToolCall") {
              if (!isPlainObject(config["arguments"])) throw new Error("ToolCall requires config.arguments as an object");
              arguments_ = resolveArgumentReferences(config["arguments"], inputs, "config.arguments");
              if (arguments_ instanceof ReferenceProblem) throw new Error(arguments_.detail);
              if (config["tool_name"] === "browser.click" && config["expected_page_state"] !== undefined && isPlainObject(arguments_)) {
                arguments_ = { ...arguments_, expected_page_state: config["expected_page_state"] };
              }
            }
            outputs.set(key, { simulated: true, action, inputs, ...(node.type === "ToolCall" ? { arguments: arguments_ } : {}) });
            steps.push({ key, type: node.type, status: "simulated", action });
          } catch (error: unknown) {
            steps.push({ key, type: node.type, status: "failed", error: errorMessage(error) });
            return finish("error", undefined, finalOutput(dag, outputs), errorMessage(error));
          }
          continue;
        }
        const nodeExecutionId = `node_${uuidv7()}`;
        try {
          const result = await handlers.execute(node.type, {
            config,
            inputs,
            tenant_id: request.tenantId,
            run_id: simulationRunId,
            node_execution_id: nodeExecutionId,
            ...(node.success_criteria === undefined ? {} : { success_criteria: node.success_criteria }),
          });
          addUsage(usage, result.metadata);
          outputs.set(key, result.output);
          const scored = await this.verifier.scoreNodeInline({
            tenant_id: request.tenantId,
            run_id: simulationRunId,
            node_execution_id: nodeExecutionId,
            node_key: key,
            node_type: node.type,
            config_json: JSON.stringify({ ...config, upstream_inputs: inputs }),
            output_json: JSON.stringify(result.output),
            success_criteria: [...(node.success_criteria ?? [])],
          });
          verification.record(key, scored);
          steps.push({ key, type: node.type, status: "executed", verdict: scored.verdict });
          if (scored.verdict === "fail") {
            return finish("fail", scored, finalOutput(dag, outputs), `Node ${key} failed its verification`);
          }
        } catch (error: unknown) {
          steps.push({ key, type: node.type, status: "failed", error: errorMessage(error) });
          return finish("error", undefined, finalOutput(dag, outputs), errorMessage(error));
        }
      }
    }

    const output = finalOutput(dag, outputs);
    try {
      const judged = await this.verifier.scoreNodeInline({
        tenant_id: request.tenantId,
        run_id: simulationRunId,
        node_execution_id: `node_${uuidv7()}`,
        node_key: inputKey,
        // The same rubric a run's end-of-run acceptance check uses
        // (run-acceptance-check.ts): the outputs taken together against the
        // stated criteria.
        node_type: "RunOutcome",
        config_json: JSON.stringify({ benchmark_case_id: request.caseId, input: request.input, success_criteria: request.successCriteria, mode: "simulate",
          outside_actions: "Outside actions are never executed in Simulate. Their resolved arguments describe the planned outcome to assess against the case criteria. Skipped branches were intentionally not selected; they are not missing actions. PII placeholders preserve detected values without revealing them." }),
        // Execution flags are engine metadata, not the content being judged.
        // Keep every planned argument (including untrusted text) in the review.
        output_json: JSON.stringify(Object.fromEntries(Object.entries(output)
          .filter(([, value]) => (value as Record<string, unknown>)["skipped"] !== true)
          .map(([key, value]) => {
            const planned = value as Record<string, unknown>;
            return [key, planned["simulated"] === true && typeof planned["action"] === "string" && planned["arguments"] !== undefined
              ? { tool_name: planned["action"].replace(/^ToolCall:/, ""), arguments: planned["arguments"] }
              : value];
          }))),
        success_criteria: [...request.successCriteria],
      });
      return finish(judged.verdict === "pass" ? "pass" : "fail", judged, output, null);
    } catch (error: unknown) {
      return finish("error", undefined, output, errorMessage(error));
    }
  }
}

/**
 * The Gates that kept this node from running, when it has conditional
 * predecessors and none of them chose it; undefined when it runs. Same rule
 * as the Executor's isNodeGatedOff.
 */
function gatingPredecessors(
  dag: CompiledDag,
  key: string,
  outputs: ReadonlyMap<string, Record<string, unknown>>,
): string[] | undefined {
  const conditional = dag.edges.filter((edge) => edge.to === key && edge.kind === "conditional");
  if (conditional.length === 0) return undefined;
  const chosen = conditional.some((edge) => {
    const active = outputs.get(edge.from)?.["activeSuccessors"];
    return Array.isArray(active) && active.includes(key);
  });
  return chosen ? undefined : conditional.map((edge) => edge.from);
}

/** A compiler-inserted verification gate's source step and the action it protects. */
function verificationTarget(config: Record<string, unknown>): { source: string; protects: string } | undefined {
  const verification = config["verification"];
  if (!isPlainObject(verification)) return undefined;
  const source = verification["source_node_key"];
  const protects = verification["protected_node_key"];
  return typeof source === "string" && typeof protects === "string" ? { source, protects } : undefined;
}

/** The outputs of nodes nothing else consumes: what the workflow produced. */
function finalOutput(dag: CompiledDag, outputs: ReadonlyMap<string, Record<string, unknown>>): Record<string, unknown> {
  const consumed = new Set(dag.edges.map((edge) => edge.from));
  const result: Record<string, unknown> = {};
  for (const node of dag.nodes) {
    if (!consumed.has(node.key) && outputs.has(node.key)) result[node.key] = outputs.get(node.key);
  }
  return result;
}

function addUsage(
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null },
  metadata: Record<string, unknown> | undefined,
): void {
  const reported = metadata?.["usage"];
  if (isPlainObject(reported)) {
    if (typeof reported["input_tokens"] === "number") usage.inputTokens += reported["input_tokens"];
    if (typeof reported["output_tokens"] === "number") usage.outputTokens += reported["output_tokens"];
  }
  const cost = Number(metadata?.["estimated_cost_usd"]);
  if (typeof metadata?.["estimated_cost_usd"] === "string" && Number.isFinite(cost)) {
    usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + cost;
  }
}
