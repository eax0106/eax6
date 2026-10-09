import { CompiledDagSchema, RunIdSchema, TenantIdSchema } from "@alterx/contracts";

import type { OrchestrationTenantStore } from "../runs/node-execution-ledger.service";
import { ReferenceProblem, resolveArgumentReferences } from "./handlers/toolcall.handler";
import { createVerificationResultId } from "./verification-result-id";
import type { VerifyGateService } from "./verify-gate.service";

/** Why a completed run did, or did not, pass its end-of-run check. */
export type RunAcceptance =
  | { readonly checked: false; readonly reason: "no_success_criteria" | "no_compiled_dag" | "run_already_terminal" }
  | { readonly checked: true; readonly passed: boolean; readonly reason: string };

export interface RunAcceptanceCheck {
  check(tenantId: string, runId: string): Promise<RunAcceptance>;
}

interface RunAcceptanceLedger {
  recordRunVerificationResult(request: {
    readonly id: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly verdict: string;
    readonly score: number;
    readonly threshold: number;
    readonly reviewerModel: string;
    readonly detailsJson: string;
  }): Promise<void>;
}

/**
 * Design log §5.3: even after every node passes on its own, one final review
 * compares the combined outcome against the original success criteria the
 * user gave at intake -- each piece fine alone, the whole not what was
 * wanted. The criteria are the compiled DAG's own (C29 kept the global list
 * for exactly this); the combined outcome is every terminal node's output,
 * plus what each terminal tool call was asked to do and the step outputs that
 * fed it. A tool's own output is often only a receipt (an email.send returns
 * a message id), which cannot show who it went to or what it said.
 *
 * Fail-closed (§5.5): a check that cannot complete is not a pass.
 */
export class PostgresRunAcceptanceCheck implements RunAcceptanceCheck {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly verifyGate: VerifyGateService,
    private readonly ledger: RunAcceptanceLedger,
  ) {}

  async check(tenantIdInput: string, runId: string): Promise<RunAcceptance> {
    const tenant = TenantIdSchema.parse(tenantIdInput);
    RunIdSchema.parse(runId);
    const tenantId = tenant.slice("ten_".length);

    const loaded = await this.store.withTenant(tenantId, async (tx) => {
      // A finalize can be delivered again (an activity retry, a replayed
      // workflow) after the run is already terminal, or after the check
      // already ran and recorded its verdict. Neither must spend another
      // model call or write a second verdict row.
      const run = await tx.query<{ readonly status: string }>(
        "SELECT status FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      const status = run.rows[0]?.status;
      if (status !== undefined && status !== "pending" && status !== "running") {
        return { terminal: true as const };
      }
      const recorded = await tx.query<{ readonly verdict: string }>(
        `SELECT verdict FROM verification_results
         WHERE tenant_id = $1 AND run_id = $2 AND gate_type = 'acceptance'
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, runId],
      );
      if (recorded.rows[0] !== undefined) {
        return { recordedVerdict: recorded.rows[0].verdict };
      }
      const version = await tx.query<{ readonly compiled_dag: unknown }>(
        `SELECT v.compiled_dag FROM runs r
           JOIN workflow_versions v ON v.tenant_id = r.tenant_id AND v.id = r.workflow_version_id
         WHERE r.tenant_id = $1 AND r.id = $2`,
        [tenantId, runId],
      );
      const dag = CompiledDagSchema.safeParse(version.rows[0]?.compiled_dag);
      if (!dag.success) return undefined;
      const succeeded = await tx.query<{ readonly dag_node_id: string }>(
        `SELECT DISTINCT dag_node_id FROM node_executions
         WHERE tenant_id = $1 AND run_id = $2 AND status = 'succeeded'`,
        [tenantId, runId],
      );
      const succeededKeys = new Set(succeeded.rows.map((row) => row.dag_node_id));
      // Terminal: succeeded, and never the source of an edge whose target
      // also succeeded -- a skipped branch is not part of the outcome.
      const feeding = new Set(
        dag.data.edges
          .filter((edge) => succeededKeys.has(edge.from) && succeededKeys.has(edge.to))
          .map((edge) => edge.from),
      );
      const terminal = [...succeededKeys].filter((key) => !feeding.has(key)).sort();
      const stored: Record<string, Record<string, unknown>> = {};
      if (succeededKeys.size > 0) {
        const checkpoints = await tx.query<{ readonly context_key: string; readonly value_json: unknown }>(
          `SELECT context_key, value_json FROM blackboard_checkpoints
           WHERE tenant_id = $1 AND run_id = $2 AND context_key = ANY($3::text[])`,
          [tenantId, runId, [...succeededKeys]],
        );
        for (const row of checkpoints.rows) {
          stored[row.context_key] = isPlainObject(row.value_json) ? row.value_json : {};
        }
      }
      const nodes = new Map(dag.data.nodes.map((node) => [node.key, node]));
      const finalOutputs: Record<string, unknown> = {};
      const actionsTaken: Record<string, unknown> = {};
      for (const key of terminal) {
        if (key in stored) finalOutputs[key] = stored[key];
        const node = nodes.get(key);
        if (node?.type !== "ToolCall") continue;
        const config = isPlainObject(node.config) ? node.config : {};
        const resolved = resolveArgumentReferences(config["arguments"], stored, "config.arguments");
        if (resolved instanceof ReferenceProblem || resolved === undefined) continue;
        actionsTaken[key] = { tool_name: config["tool_name"], arguments: resolved };
      }
      // Gates only route; their output is not part of what the user asked for.
      const upstreamOutputs: Record<string, unknown> = {};
      for (const key of [...succeededKeys].sort()) {
        if (terminal.includes(key) || nodes.get(key)?.type === "Gate" || !(key in stored)) continue;
        upstreamOutputs[key] = stored[key];
      }
      const outputs = {
        final_outputs: finalOutputs,
        actions_taken: actionsTaken,
        upstream_outputs: upstreamOutputs,
      };
      return { criteria: dag.data.success_criteria ?? [], outputs };
    });

    if (loaded === undefined) return { checked: false, reason: "no_compiled_dag" };
    if ("terminal" in loaded) return { checked: false, reason: "run_already_terminal" };
    if ("recordedVerdict" in loaded) return acceptanceFrom(loaded.recordedVerdict);
    if (loaded.criteria.length === 0) return { checked: false, reason: "no_success_criteria" };

    let verdict: { verdict: string; score: number; threshold: number; reviewer_model: string; details_json: string };
    try {
      verdict = await this.verifyGate.scoreNodeInline({
        tenant_id: tenant,
        run_id: runId,
        // The reviewer's contract is per node; a run-level review carries a
        // fresh id that names no stored node execution.
        node_execution_id: createVerificationResultId().replace(/^ver_/, "node_"),
        node_key: "__run_outcome__",
        node_type: "RunOutcome",
        config_json: "{}",
        output_json: JSON.stringify(loaded.outputs),
        success_criteria: [...loaded.criteria],
      });
    } catch (error: unknown) {
      return {
        checked: true,
        passed: false,
        reason: `end-of-run check could not complete: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    await this.ledger.recordRunVerificationResult({
      id: createVerificationResultId(),
      tenantId: tenant,
      runId,
      verdict: verdict.verdict,
      score: verdict.score,
      threshold: verdict.threshold,
      reviewerModel: verdict.reviewer_model,
      detailsJson: verdict.details_json,
    });
    return acceptanceFrom(verdict.verdict);
  }
}

function acceptanceFrom(verdict: string): RunAcceptance {
  const passed = verdict !== "fail";
  return {
    checked: true,
    passed,
    reason: passed ? "combined outcome meets the success criteria" : "combined outcome does not meet every success criterion",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
