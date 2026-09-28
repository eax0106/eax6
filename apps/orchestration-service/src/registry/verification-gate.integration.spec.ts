import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GateHandler } from "./handlers/gate.handler";
import { MergeHandler } from "./handlers/merge.handler";
import { NodeHandlerRegistry } from "./node-handler-registry";
import { NodeexecService } from "./nodeexec.service";
import { PostgresVerificationGateReader } from "./verification-gate-reader";
import { VerifyGateService } from "./verify-gate.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_REQUEST = `ten_${TENANT}`;
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const SOURCE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
const GATE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a5";

describe.sequential("verification Gate real Postgres path", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let ledger: NodeExecutionLedgerService;
  let nodeexec: NodeexecService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db").withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex")).start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    ledger = new NodeExecutionLedgerService(store);
    nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new GateHandler(new PostgresVerificationGateReader(store))]), ledger,
    );
  }, 90_000);

  it("persists a real quality row when Verify Gate scores a node, so Gate/Synthesis can read it back", async () => {
    const verifyGate = new VerifyGateService({
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict: "pass", score: 0.95, threshold: 0.7, reviewer_model: "ADVANCED", details_json: "{\"rationale\":\"ok\"}",
      }),
    });
    const scoredNodeexec = new NodeexecService(
      new NodeHandlerRegistry([new MergeHandler()]), ledger, undefined, undefined, undefined,
      undefined, undefined, verifyGate,
    );
    const nodeExecutionId = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890b1";

    await scoredNodeexec.executeNode({
      tenant_id: TENANT_REQUEST, run_id: RUN, node_execution_id: nodeExecutionId,
      node_key: "node_merge", node_type: "Merge", config_json: "{}", inputs_json: "{}",
      success_criteria: [],
    });

    const row = await store.withTenant(TENANT, async (tx) => {
      const result = await tx.query<{ readonly gate_type: string; readonly verdict: string; readonly score: string; readonly threshold: string; readonly reviewer_model: string }>(
        "SELECT gate_type, verdict, score, threshold, reviewer_model FROM verification_results WHERE tenant_id = $1 AND node_execution_id = $2",
        [TENANT, nodeExecutionId],
      );
      return result.rows[0];
    });
    expect(row).toMatchObject({ gate_type: "quality", verdict: "pass", reviewer_model: "ADVANCED" });
    expect(Number(row!.score)).toBeCloseTo(0.95);
    expect(Number(row!.threshold)).toBeCloseTo(0.7);
  });

  afterAll(async () => { await store?.close(); await postgres?.stop(); }, 60_000);

  beforeEach(async () => {
    await store.withTenant(TENANT, async (tx) => {
      await tx.query("DELETE FROM verification_results WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM node_executions WHERE tenant_id = $1", [TENANT]);
      await tx.query("DELETE FROM runs WHERE tenant_id = $1", [TENANT]);
      await tx.query(`INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, status) VALUES ($1, $2, $3, 'workflow', 'running')`, [RUN, TENANT, WORKSPACE]);
    });
    await ledger.recordStarted({ tenantId: TENANT_REQUEST, runId: RUN, nodeExecutionId: SOURCE, dagNodeId: "reviewed", nodeType: "LLMTask" });
    await ledger.recordSucceeded({ tenantId: TENANT_REQUEST, runId: RUN, nodeExecutionId: SOURCE });
  });

  it("blocks a low-quality or critical result and records the typed pending-recovery state", async () => {
    await seedResults("fail", 0.2, 0.7, "critical");
    const result = await nodeexec.executeNode(gateRequest());

    expect(JSON.parse(result.output_json)).toMatchObject({ verification_status: "blocked_pending_recovery", activeSuccessors: [] });
    await expect(gateStatus()).resolves.toBe("blocked_pending_recovery");
  });

  it("allows a clean result to activate the protected external action", async () => {
    await seedResults("pass", 0.9, 0.7, "low");
    const result = await nodeexec.executeNode(gateRequest());

    expect(JSON.parse(result.output_json)).toMatchObject({ verification_status: "passed", activeSuccessors: ["external"] });
    await expect(gateStatus()).resolves.toBe("succeeded");
  });

  it("fails closed when the upstream output has no verification rows", async () => {
    const result = await nodeexec.executeNode(gateRequest());

    expect(JSON.parse(result.output_json)).toMatchObject({ verification_status: "blocked_pending_recovery", reason: "verification_result_missing" });
    await expect(gateStatus()).resolves.toBe("blocked_pending_recovery");
  });

  async function seedResults(verdict: "pass" | "fail", score: number, threshold: number, severity: string): Promise<void> {
    await store.withTenant(TENANT, async (tx) => {
      await tx.query(`INSERT INTO verification_results (id, tenant_id, run_id, node_execution_id, gate_type, verdict, score, threshold, details)
        VALUES
          ('ver_018f4d6e-2b4a-7a3e-8c1a-1234567890a6', $1, $2, $3, 'quality', $4, $5, $6, '{}'::jsonb),
          ('ver_018f4d6e-2b4a-7a3e-8c1a-1234567890a7', $1, $2, $3, 'safety', 'warn', NULL, NULL, $7::jsonb)`,
        [TENANT, RUN, SOURCE, verdict, score, threshold, JSON.stringify({ severity })]);
    });
  }

  async function gateStatus(): Promise<string> {
    return store.withTenant(TENANT, async (tx) => {
      const result = await tx.query<{ readonly status: string }>("SELECT status FROM node_executions WHERE tenant_id = $1 AND id = $2", [TENANT, GATE]);
      return result.rows[0]!.status;
    });
  }
});

function gateRequest() {
  return {
    tenant_id: TENANT_REQUEST, run_id: RUN, node_execution_id: GATE, node_key: "verification_gate", node_type: "Gate",
    config_json: JSON.stringify({ verification: { source_node_key: "reviewed", protected_node_key: "external" } }),
    inputs_json: "{}",
    success_criteria: [],
  };
}
