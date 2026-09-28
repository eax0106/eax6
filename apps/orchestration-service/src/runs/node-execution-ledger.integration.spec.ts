import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  createExecutorActivities,
  PostgresOrchestrationStoreProvider,
} from "@alterx/adapters";
import { createExecutorTestHarness } from "@alterx/adapters/testing";
import type { CompiledDag, NodeType } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BlackboardHandlerClient } from "@alterx/adapters";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import type { NodeExecutionResult, NodeHandler } from "../registry/handler";
import {
  NodeExecutionLedgerService,
  NodeExecutionRunNotFoundError,
} from "./node-execution-ledger.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const TENANT_A_REQUEST = `ten_${TENANT_A}`;
const TENANT_B_REQUEST = `ten_${TENANT_B}`;
const WORKSPACE_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const RUN_A = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const RUN_B = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890b3";
const NODE_A = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";

interface StoredExecution extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly attempt: number;
  readonly error: Record<string, unknown> | null;
  readonly dag_node_id?: string;
  readonly input_ref?: string | null;
  readonly output_ref?: string | null;
}

class EchoMergeHandler implements NodeHandler {
  readonly nodeType: NodeType = "Merge";

  async execute(): Promise<NodeExecutionResult> {
    return { output: { persisted: true } };
  }
}

function oneNodeDag(): CompiledDag {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_merge"],
    nodes: [{ key: "node_merge", type: "Merge", config: {}, metadata: { ui: {} } }],
    edges: [],
    waves: [{ key: "wave_0", order: 0, node_keys: ["node_merge"], depends_on: [] }],
  };
}

function blackboard(): BlackboardHandlerClient {
  const values = new Map<string, string>();
  return {
    async readValue(request) {
      const value = values.get(request.key);
      return value === undefined
        ? { found: false, value_json: "" }
        : { found: true, value_json: value };
    },
    async writeValue(request) {
      values.set(request.key, request.value_json);
      return {};
    },
  };
}

describe.sequential("node executions durable ledger", () => {
  let postgres: StartedPostgreSqlContainer;
  let adminStore: PostgresOrchestrationStoreProvider;
  let executionStore: PostgresOrchestrationStoreProvider;
  let ledger: NodeExecutionLedgerService;
  const role = `node_execution_test_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminStore = new PostgresOrchestrationStoreProvider(
      { authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder },
    );
    await adminStore.migrate();
    await adminStore.withTenant(TENANT_A, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    executionStore = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
        migrationsFolder,
      },
    );
    ledger = new NodeExecutionLedgerService(executionStore);
  }, 90_000);

  afterAll(async () => {
    await executionStore?.close();
    await adminStore.withTenant(TENANT_A, async (tx) => {
      await tx.query(`DROP OWNED BY ${role}`);
      await tx.query(`DROP ROLE IF EXISTS ${role}`);
    });
    await adminStore?.close();
    await postgres?.stop();
  }, 60_000);

  beforeEach(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await adminStore.withTenant(tenantId, async (tx) => {
        await tx.query("DELETE FROM node_executions WHERE tenant_id = $1", [tenantId]);
        await tx.query("DELETE FROM runs WHERE tenant_id = $1", [tenantId]);
      });
    }
    await seedRun(TENANT_A, RUN_A);
    await seedRun(TENANT_B, RUN_B);
  });

  async function seedRun(tenantId: string, runId: string): Promise<void> {
    await adminStore.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, status)
         VALUES ($1, $2, $3, 'workflow', 'running')`,
        [runId, tenantId, WORKSPACE_A],
      );
    });
  }

  async function executions(tenantId: string, runId: string): Promise<readonly StoredExecution[]> {
    return executionStore.withTenant(tenantId, async (tx) => {
      const result = await tx.query<StoredExecution>(
        `SELECT id, dag_node_id, status, attempt, error, input_ref, output_ref
         FROM node_executions
         WHERE tenant_id = $1 AND run_id = $2
         ORDER BY started_at`,
        [tenantId, runId],
      );
      return result.rows;
    });
  }

  async function runStatus(
    tenantId: string,
    runId: string,
  ): Promise<{ readonly status: string; readonly ended_at: string | null }> {
    return executionStore.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ readonly status: string; readonly ended_at: string | null }>(
        "SELECT status, ended_at::text FROM runs WHERE tenant_id = $1 AND id = $2",
        [tenantId, runId],
      );
      return result.rows[0]!;
    });
  }

  it("runs a real Temporal Executor activity through NodeexecService and persists succeeded", async () => {
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new EchoMergeHandler()]),
      ledger,
    );
    const harness = await createExecutorTestHarness(
      "node-execution-ledger-e2e",
      createExecutorActivities(nodeexec, blackboard()),
    );
    try {
      const result = await harness.run("node-execution-ledger-e2e-workflow", {
        tenantId: TENANT_A_REQUEST,
        runId: RUN_A,
        compiledDagJson: JSON.stringify(oneNodeDag()),
      });
      expect(result.outputs).toEqual({ node_merge: { persisted: true } });
    } finally {
      await harness.teardown();
    }

    const rows = await executions(TENANT_A, RUN_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", attempt: 1, error: null });
    expect(rows[0]?.id).toMatch(/^node_[0-9a-f-]+$/i);
  }, 120_000);

  it("finalizes the run as completed and records input_ref without a fabricated output_ref", async () => {
    const nodeexec = new NodeexecService(
      new NodeHandlerRegistry([new EchoMergeHandler()]),
      ledger,
    );
    const twoNodeDag: CompiledDag = {
      schema_version: "v1",
      entry_node_keys: ["node_a"],
      nodes: [
        { key: "node_a", type: "Merge", config: {}, metadata: { ui: {} } },
        { key: "node_b", type: "Merge", config: {}, metadata: { ui: {} } },
      ],
      edges: [{ key: "node_a-to-node_b", from: "node_a", to: "node_b", kind: "sequential" }],
      waves: [
        { key: "wave_0", order: 0, node_keys: ["node_a"], depends_on: [] },
        { key: "wave_1", order: 1, node_keys: ["node_b"], depends_on: ["wave_0"] },
      ],
    };
    const harness = await createExecutorTestHarness(
      "node-execution-ledger-finalize-e2e",
      createExecutorActivities(nodeexec, blackboard()),
    );
    try {
      await harness.run("node-execution-ledger-finalize-e2e-workflow", {
        tenantId: TENANT_A_REQUEST,
        runId: RUN_A,
        compiledDagJson: JSON.stringify(twoNodeDag),
      });
    } finally {
      await harness.teardown();
    }

    const status = await runStatus(TENANT_A, RUN_A);
    expect(status.status).toBe("completed");
    expect(status.ended_at).not.toBeNull();

    const rows = await executions(TENANT_A, RUN_A);
    const nodeA = rows.find((row) => row.dag_node_id === "node_a");
    const nodeB = rows.find((row) => row.dag_node_id === "node_b");
    expect(nodeA?.input_ref ?? null).toBeNull();
    expect(nodeA?.output_ref ?? null).toBeNull();
    expect(nodeB?.input_ref).toBe("node_a");
    expect(nodeB?.output_ref ?? null).toBeNull();
  }, 120_000);

  it("records failed execution and retries same node execution as a new attempt", async () => {
    const failingHandler: NodeHandler = {
      nodeType: "Merge",
      async execute() {
        throw new Error("provider failure contains no persisted secret");
      },
    };
    const service = new NodeexecService(new NodeHandlerRegistry([failingHandler]), ledger);
    const request = {
      tenant_id: TENANT_A_REQUEST,
      run_id: RUN_A,
      node_execution_id: NODE_A,
      node_key: "node_merge",
      node_type: "Merge",
      config_json: "{}",
      inputs_json: "{}",
      success_criteria: [],
    };
    await expect(service.executeNode(request)).rejects.toThrow("provider failure");
    await expect(service.executeNode(request)).rejects.toThrow("provider failure");

    await expect(executions(TENANT_A, RUN_A)).resolves.toEqual([
      expect.objectContaining({
        id: NODE_A,
        status: "failed",
        attempt: 2,
        // The handler threw `new Error("provider failure")`. `detail` used to
        // be the constant "Node execution failed", which is what left every
        // unrecognised failure classifying as `unknown` (#149). The code stays
        // NODE_EXECUTION_FAILED because a plain Error carries none.
        error: {
          code: "NODE_EXECUTION_FAILED",
          detail: "provider failure contains no persisted secret",
        },
      }),
    ]);
  });

  it("enforces RLS tenant isolation for list/read", async () => {
    await ledger.recordStarted({
      tenantId: TENANT_A_REQUEST,
      runId: RUN_A,
      nodeExecutionId: NODE_A,
      dagNodeId: "node_merge",
      nodeType: "Merge",
    });
    await ledger.recordSucceeded({
      tenantId: TENANT_A_REQUEST,
      runId: RUN_A,
      nodeExecutionId: NODE_A,
    });

    await expect(ledger.list(TENANT_A_REQUEST, RUN_A)).resolves.toMatchObject({
      data: [expect.objectContaining({ id: NODE_A })],
    });
    await expect(ledger.list(TENANT_B_REQUEST, RUN_A)).rejects.toBeInstanceOf(
      NodeExecutionRunNotFoundError,
    );
  });
});
