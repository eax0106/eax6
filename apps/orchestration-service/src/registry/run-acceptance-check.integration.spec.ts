import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { PostgresRunAcceptanceCheck } from "./run-acceptance-check";
import type { VerifyGateService } from "./verify-gate.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const TENANT = `ten_${BARE_TENANT}`;
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c2";
const RUN_NO_CRITERIA = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c3";
const RUN_PASS = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c4";
const RUN_UNAVAILABLE = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c5";
const RUN_DONE = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c6";
const RUN_PARTIAL = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890c7";
const CRITERIA = ["Refund total stated", "Customer is emailed"];

// node_a feeds node_c directly and node_b through gate_a; node_b and node_c
// are the run's outcome. node_c sends node_a's output on.
const NODE_KEYS = ["node_a", "gate_a", "node_b", "node_c"];
function dag(successCriteria?: readonly string[]) {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_a"],
    nodes: [
      { key: "node_a", type: "LLMTask", config: {}, metadata: { ui: {} } },
      { key: "gate_a", type: "Gate", config: {}, metadata: { ui: {} } },
      { key: "node_b", type: "LLMTask", config: {}, metadata: { ui: {} } },
      {
        key: "node_c",
        type: "ToolCall",
        config: { tool_name: "email.send", arguments: { to: "team@example.com", body: { $from: "node_a", path: "from" } } },
        metadata: { ui: {} },
      },
    ],
    edges: [
      { key: "e1", from: "node_a", to: "gate_a", kind: "sequential" },
      { key: "e2", from: "gate_a", to: "node_b", kind: "sequential" },
      { key: "e3", from: "node_a", to: "node_c", kind: "sequential" },
    ],
    waves: [
      { key: "w0", order: 0, node_keys: ["node_a"], depends_on: [] },
      { key: "w1", order: 1, node_keys: ["gate_a", "node_c"], depends_on: ["w0"] },
      { key: "w2", order: 2, node_keys: ["node_b"], depends_on: ["w1"] },
    ],
    ...(successCriteria === undefined ? {} : { success_criteria: successCriteria }),
  };
}

// C37, design log §5.3: the end-of-run check over a real orchestration_db.
describe.sequential("PostgresRunAcceptanceCheck", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let ledger: NodeExecutionLedgerService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: postgres.getConnectionUri(),
      migrationsFolder,
    });
    await store.migrate();
    ledger = new NodeExecutionLedgerService(store);
    await store.withTenant(BARE_TENANT, async (tx) => {
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ('wf_acc',$1,$1,'acceptance')", [BARE_TENANT]);
      await tx.query(
        "INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES ('wfv_acc1',$1,'wf_acc',1,$2,'v1'),('wfv_acc2',$1,'wf_acc',2,$3,'v1')",
        [BARE_TENANT, JSON.stringify(dag(CRITERIA)), JSON.stringify(dag())],
      );
      await tx.query(
        "INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id) VALUES ($2,$1,$1,'workflow','wf_acc','wfv_acc1'),($3,$1,$1,'workflow','wf_acc','wfv_acc2')",
        [BARE_TENANT, RUN, RUN_NO_CRITERIA],
      );
      await tx.query(
        "INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id,status) VALUES ($2,$1,$1,'workflow','wf_acc','wfv_acc1','running'),($3,$1,$1,'workflow','wf_acc','wfv_acc1','running'),($4,$1,$1,'workflow','wf_acc','wfv_acc1','completed')",
        [BARE_TENANT, RUN_PASS, RUN_UNAVAILABLE, RUN_DONE],
      );
      await tx.query(
        "INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id,status) VALUES ($2,$1,$1,'workflow','wf_acc','wfv_acc1','running')",
        [BARE_TENANT, RUN_PARTIAL],
      );
      // node_a left no checkpoint, and node_b's is not an object.
      for (const key of NODE_KEYS) {
        await tx.query(
          "INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$2,$3,$4,'LLMTask','succeeded')",
          [`node_${key}_${RUN_PARTIAL.slice(-4)}`, BARE_TENANT, RUN_PARTIAL, key],
        );
      }
      await tx.query(
        "INSERT INTO blackboard_checkpoints(tenant_id,run_id,context_key,value_json) VALUES ($1,$2,'node_b',$3),($1,$2,'node_c',$4)",
        [BARE_TENANT, RUN_PARTIAL, JSON.stringify("text"), JSON.stringify({ from: "node_c" })],
      );
      for (const run of [RUN, RUN_PASS, RUN_UNAVAILABLE, RUN_DONE]) {
        for (const key of NODE_KEYS) {
          await tx.query(
            "INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$2,$3,$4,'LLMTask','succeeded')",
            [`node_${key}_${run.slice(-4)}`, BARE_TENANT, run, key],
          );
          await tx.query(
            "INSERT INTO blackboard_checkpoints(tenant_id,run_id,context_key,value_json) VALUES ($1,$2,$3,$4)",
            [BARE_TENANT, run, key, JSON.stringify({ from: key })],
          );
        }
      }
    });
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  function gate(verdict: "pass" | "fail") {
    return {
      scoreNodeInline: vi.fn().mockResolvedValue({
        verdict, score: 0.9, threshold: 0.8, reviewer_model: "ADVANCED",
        details_json: JSON.stringify({ criteria: [] }),
      }),
    } as unknown as VerifyGateService & { scoreNodeInline: ReturnType<typeof vi.fn> };
  }

  it("judges the run's outcome, what its tool calls were asked to send and the steps that fed them, and records the verdict", async () => {
    const verifyGate = gate("fail");
    const result = await new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN);

    expect(result).toEqual({ checked: true, passed: false, reason: "combined outcome does not meet every success criterion" });
    const call = verifyGate.scoreNodeInline.mock.calls[0]![0];
    expect(call).toMatchObject({ node_type: "RunOutcome", success_criteria: CRITERIA, run_id: RUN });
    expect(call.node_execution_id).toMatch(/^node_[0-9a-f-]{36}$/);
    // node_a fed both leaves, so the outcome is node_b and node_c only. A tool's
    // output can be just a receipt, so the reviewer also sees what node_c was
    // asked to send and node_a's output behind it; the gate only routed.
    expect(JSON.parse(call.output_json)).toEqual({
      final_outputs: { node_b: { from: "node_b" }, node_c: { from: "node_c" } },
      actions_taken: { node_c: { tool_name: "email.send", arguments: { to: "team@example.com", body: "node_a" } } },
      upstream_outputs: { node_a: { from: "node_a" } },
    });
    const stored = await store.withTenant(BARE_TENANT, (tx) =>
      tx.query<{ gate_type: string; verdict: string; node_execution_id: string | null }>(
        "SELECT gate_type, verdict, node_execution_id FROM verification_results WHERE run_id = $1",
        [RUN],
      ),
    );
    expect(stored.rows).toEqual([{ gate_type: "acceptance", verdict: "fail", node_execution_id: null }]);
  });

  it("leaves out a tool call's arguments when a step it read from left no output", async () => {
    const verifyGate = gate("pass");
    await new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN_PARTIAL);
    expect(JSON.parse(verifyGate.scoreNodeInline.mock.calls[0]![0].output_json)).toEqual({
      final_outputs: { node_b: {}, node_c: { from: "node_c" } },
      actions_taken: {},
      upstream_outputs: {},
    });
  });

  it("passes a run whose combined output meets the criteria", async () => {
    await expect(new PostgresRunAcceptanceCheck(store, gate("pass"), ledger).check(TENANT, RUN_PASS)).resolves.toMatchObject({
      checked: true,
      passed: true,
    });
  });

  it("fails closed when the check cannot complete (§5.5)", async () => {
    const verifyGate = {
      scoreNodeInline: vi.fn().mockRejectedValue(new Error("Verify Service call failed: unavailable")),
    } as unknown as VerifyGateService;
    await expect(new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN_UNAVAILABLE)).resolves.toMatchObject({
      checked: true,
      passed: false,
    });
  });

  it("reuses the recorded verdict when the finalize is delivered again, with no second model call or row", async () => {
    const verifyGate = gate("pass");
    // RUN's verdict ("fail") was recorded by the first test.
    await expect(new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN)).resolves.toEqual({
      checked: true,
      passed: false,
      reason: "combined outcome does not meet every success criterion",
    });
    expect(verifyGate.scoreNodeInline).not.toHaveBeenCalled();
    const stored = await store.withTenant(BARE_TENANT, (tx) =>
      tx.query("SELECT 1 FROM verification_results WHERE run_id = $1 AND gate_type = 'acceptance'", [RUN]),
    );
    expect(stored.rows).toHaveLength(1);
  });

  it("does not judge a run that is already terminal", async () => {
    const verifyGate = gate("fail");
    await expect(new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN_DONE)).resolves.toEqual({
      checked: false,
      reason: "run_already_terminal",
    });
    expect(verifyGate.scoreNodeInline).not.toHaveBeenCalled();
  });

  it("does not judge a run whose workflow has no intake criteria", async () => {
    const verifyGate = gate("fail");
    await expect(
      new PostgresRunAcceptanceCheck(store, verifyGate, ledger).check(TENANT, RUN_NO_CRITERIA),
    ).resolves.toEqual({ checked: false, reason: "no_success_criteria" });
    expect(verifyGate.scoreNodeInline).not.toHaveBeenCalled();
  });
});
