import { CompiledDagSchema, RunIdSchema, TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import type { MemoryWritebackHandler } from "@alterx/adapters";

import type { OrchestrationTenantStore } from "../runs/node-execution-ledger.service";
import type { ArtifactsService } from "../artifacts/artifacts.service";
import type { VerificationGateReader, VerificationResultRecord } from "./verification-gate-reader";

export interface RunFinalizationMemoryWriteResult {
  readonly written: boolean;
  readonly reason: string;
}

export interface RunFinalizationMemoryWriter {
  writeVerifiedOutputMemory(
    tenantId: string,
    runId: string,
  ): Promise<RunFinalizationMemoryWriteResult>;
}

interface RunRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly workflow_id: string | null;
  readonly workflow_version_id: string | null;
}

interface TerminalNodeCandidate extends Record<string, unknown> {
  readonly id: string;
  readonly dag_node_id: string;
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) throw new Error("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function numeric(value: string | number | null): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safetySeverity(value: unknown): "low" | "medium" | "high" | "critical" | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const severity = (parsed as Record<string, unknown>)["severity"];
  return severity === "low" || severity === "medium" || severity === "high" || severity === "critical"
    ? severity
    : undefined;
}

/**
 * Same pass/fail bar as synthesis.handler.ts's classifyVerification --
 * intentionally re-derived here rather than shared, matching that file's
 * own established precedent of keeping each caller's verification bar
 * self-contained (small duplication, contained blast radius).
 */
function isVerified(results: readonly VerificationResultRecord[]): boolean {
  const quality = results.find((result) => result.gateType === "quality");
  if (quality === undefined) return false;
  const score = numeric(quality.score);
  const threshold = numeric(quality.threshold);
  if (
    quality.verdict !== "pass" ||
    score === undefined ||
    threshold === undefined ||
    score < threshold ||
    threshold < 0 ||
    threshold > 1 ||
    score < 0 ||
    score > 1
  ) {
    return false;
  }
  const safety = results.find((result) => result.gateType === "safety");
  if (safety !== undefined && safetySeverity(safety.details) === "critical") return false;
  return true;
}

/**
 * Executor-mandatory MemoryWrite: every completed workflow run gets exactly
 * one best-effort attempt to write memory about its own verified final
 * output, without requiring the workflow author to hand-wire a MemoryWrite
 * node. Never invents data -- the "final output" is derived structurally
 * from the run's own compiled DAG + real node_executions (the one succeeded
 * node nothing downstream in this run actually consumed), its content comes
 * verbatim from the real Blackboard checkpoint that node's own execution
 * already wrote, and it never fires unless that exact node has a real
 * passing verification_results row. Ambiguous (0 or 2+ terminal candidates)
 * or unverified runs are silently skipped, never guessed.
 */
export class PostgresRunFinalizationMemoryWriter implements RunFinalizationMemoryWriter {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly verificationReader: VerificationGateReader,
    private readonly artifacts: ArtifactsService,
    private readonly memoryService: MemoryWritebackHandler,
  ) {}

  async writeVerifiedOutputMemory(
    tenantIdInput: string,
    runId: string,
  ): Promise<RunFinalizationMemoryWriteResult> {
    if (!RunIdSchema.safeParse(runId).success) {
      return { written: false, reason: "invalid_run_id" };
    }
    const tenantId = bareTenantUuid(tenantIdInput);

    const resolved = await this.store.withTenant(tenantId, async (tx) => {
      const runResult = await tx.query<RunRow>(
        `SELECT workspace_id::text, workflow_id, workflow_version_id
         FROM runs WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
      const run = runResult.rows[0];
      if (run === undefined || run.workflow_version_id === null) {
        return { ok: false as const, reason: "no_compiled_workflow_version" };
      }

      const versionResult = await tx.query<{ readonly compiled_dag: unknown }>(
        `SELECT compiled_dag FROM workflow_versions WHERE tenant_id = $1 AND id = $2`,
        [tenantId, run.workflow_version_id],
      );
      const parsedDag = CompiledDagSchema.safeParse(versionResult.rows[0]?.compiled_dag);
      if (!parsedDag.success) {
        return { ok: false as const, reason: "no_compiled_dag" };
      }

      const nodesResult = await tx.query<TerminalNodeCandidate>(
        `SELECT id, dag_node_id FROM node_executions
         WHERE tenant_id = $1 AND run_id = $2 AND status = 'succeeded'`,
        [tenantId, runId],
      );
      const succeededKeys = new Set(nodesResult.rows.map((row) => row.dag_node_id));
      // Terminal = succeeded this run, and never the source of a
      // real edge whose target also succeeded this run -- correctly
      // excludes dead conditional branches, which never get a
      // node_executions row at all.
      const nonTerminalKeys = new Set(
        parsedDag.data.edges
          .filter((edge) => succeededKeys.has(edge.from) && succeededKeys.has(edge.to))
          .map((edge) => edge.from),
      );
      const terminalCandidates = nodesResult.rows.filter(
        (row) => !nonTerminalKeys.has(row.dag_node_id),
      );
      if (terminalCandidates.length !== 1) {
        return {
          ok: false as const,
          reason: terminalCandidates.length === 0 ? "no_terminal_node" : "ambiguous_terminal_nodes",
        };
      }
      const terminal = terminalCandidates[0]!;

      const checkpointResult = await tx.query<{ readonly value_json: unknown }>(
        `SELECT value_json FROM blackboard_checkpoints
         WHERE tenant_id = $1 AND run_id = $2 AND context_key = $3`,
        [tenantId, runId, terminal.dag_node_id],
      );
      const valueJson = checkpointResult.rows[0]?.value_json;
      if (valueJson === undefined) {
        return { ok: false as const, reason: "no_output_content" };
      }

      return {
        ok: true as const,
        workspaceId: run.workspace_id,
        workflowId: run.workflow_id,
        dagNodeKey: terminal.dag_node_id,
        contentJson: JSON.stringify(valueJson),
      };
    });

    if (!resolved.ok) {
      return { written: false, reason: resolved.reason };
    }

    const verification = await this.verificationReader.findForSourceNode({
      tenantId: tenantIdInput,
      runId,
      sourceNodeKey: resolved.dagNodeKey,
    });
    if (!isVerified(verification)) {
      return { written: false, reason: "not_verified" };
    }

    const artifact = await this.artifacts.create(tenantIdInput, {
      runId,
      contentType: "application/json",
      bytes: new TextEncoder().encode(resolved.contentJson),
    });

    const response = await this.memoryService.proposeWriteback({
      tenant_id: tenantIdInput,
      workspace_id: WorkspaceIdSchema.parse(`ws_${resolved.workspaceId}`),
      run_id: runId,
      verified_output_artifact_id: artifact.id,
      namespace: `workflow:${resolved.workflowId ?? "unknown"}`,
    });

    return response.skipped
      ? { written: false, reason: "memory_disabled" }
      : { written: true, reason: "written" };
  }
}
