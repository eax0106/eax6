import { describe, expect, it, vi } from "vitest";

import { PostgresRunFinalizationMemoryWriter } from "./run-finalization-memory-writer";
import type { OrchestrationTenantStore } from "../runs/node-execution-ledger.service";
import type { ArtifactsService } from "../artifacts/artifacts.service";
import type { VerificationGateReader, VerificationResultRecord } from "./verification-gate-reader";

const TENANT_ID = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const BARE_TENANT_ID = TENANT_ID.slice("ten_".length);
const RUN_ID = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE_ID = "018f47a5-7b2c-7d10-8f11-000000000001";
const WORKFLOW_VERSION_ID = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";

interface FakeDb {
  run?: { workspace_id: string; workflow_id: string | null; workflow_version_id: string | null };
  compiledDag?: unknown;
  succeededNodes?: readonly { id: string; dag_node_id: string }[];
  checkpoint?: { value_json: unknown };
}

function fakeStore(db: FakeDb): OrchestrationTenantStore {
  return {
    async withTenant<T>(
      tenantId: string,
      operation: (tx: {
        query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
      }) => Promise<T>,
    ): Promise<T> {
      expect(tenantId).toBe(BARE_TENANT_ID);
      return operation({
        query: (async (sql: string) => {
          if (sql.includes("FROM runs WHERE")) {
            return db.run === undefined ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [db.run] };
          }
          if (sql.includes("FROM workflow_versions")) {
            return db.compiledDag === undefined
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [{ compiled_dag: db.compiledDag }] };
          }
          if (sql.includes("FROM node_executions")) {
            return { rowCount: db.succeededNodes?.length ?? 0, rows: db.succeededNodes ?? [] };
          }
          if (sql.includes("FROM blackboard_checkpoints")) {
            return db.checkpoint === undefined
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [db.checkpoint] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }) as never,
      });
    },
  };
}

function fakeVerificationReader(
  records: readonly VerificationResultRecord[],
): VerificationGateReader {
  return { findForSourceNode: vi.fn().mockResolvedValue(records) };
}

function fakeArtifacts(): ArtifactsService {
  return {
    create: vi.fn().mockResolvedValue({
      id: "art_018f47a5-7b2c-7d10-8f11-987654321abc",
      runId: RUN_ID,
      contentType: "application/json",
      sizeBytes: 2,
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  } as unknown as ArtifactsService;
}

function singleNodeDag() {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_a"],
    nodes: [
      { key: "node_a", type: "LLMTask", config: {}, metadata: { ui: {} } },
    ],
    edges: [],
    waves: [{ key: "wave_1", order: 0, node_keys: ["node_a"], depends_on: [] }],
  };
}

function linearTwoNodeDag() {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_a"],
    nodes: [
      { key: "node_a", type: "LLMTask", config: {}, metadata: { ui: {} } },
      { key: "node_b", type: "Synthesis", config: {}, metadata: { ui: {} } },
    ],
    edges: [{ key: "edge_1", from: "node_a", to: "node_b", kind: "sequential" }],
    waves: [
      { key: "wave_1", order: 0, node_keys: ["node_a"], depends_on: [] },
      { key: "wave_2", order: 1, node_keys: ["node_b"], depends_on: ["wave_1"] },
    ],
  };
}

function parallelLeavesDag() {
  return {
    schema_version: "v1",
    entry_node_keys: ["node_a"],
    nodes: [
      { key: "node_a", type: "LLMTask", config: {}, metadata: { ui: {} } },
      { key: "node_b", type: "LLMTask", config: {}, metadata: { ui: {} } },
      { key: "node_c", type: "LLMTask", config: {}, metadata: { ui: {} } },
    ],
    edges: [
      { key: "edge_1", from: "node_a", to: "node_b", kind: "sequential" },
      { key: "edge_2", from: "node_a", to: "node_c", kind: "sequential" },
    ],
    waves: [
      { key: "wave_1", order: 0, node_keys: ["node_a"], depends_on: [] },
      { key: "wave_2", order: 1, node_keys: ["node_b", "node_c"], depends_on: ["wave_1"] },
    ],
  };
}

const PASS_QUALITY: readonly VerificationResultRecord[] = [
  { gateType: "quality", verdict: "pass", score: 0.95, threshold: 0.8, details: {} },
];

describe("PostgresRunFinalizationMemoryWriter.writeVerifiedOutputMemory", () => {
  it("reports disabled workflow memory as skipped", async () => {
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore({
        run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_018f47a5-7b2c-7d10-8f11-123456789abc", workflow_version_id: WORKFLOW_VERSION_ID },
        compiledDag: singleNodeDag(), succeededNodes: [{ id: "node_exec_a", dag_node_id: "node_a" }],
        checkpoint: { value_json: { answer: "verified" } },
      }), fakeVerificationReader(PASS_QUALITY), fakeArtifacts(),
      { proposeWriteback: vi.fn().mockResolvedValue({ memory_id: "", candidate_json: "{}", skipped: true }) },
    );
    await expect(writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID)).resolves.toEqual({ written: false, reason: "memory_disabled" });
  });
  it("writes memory for a single verified terminal node", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: linearTwoNodeDag(),
      succeededNodes: [
        { id: "node_exec_a", dag_node_id: "node_a" },
        { id: "node_exec_b", dag_node_id: "node_b" },
      ],
      checkpoint: { value_json: { answer: "final" } },
    };
    const verificationReader = fakeVerificationReader(PASS_QUALITY);
    const artifacts = fakeArtifacts();
    const memoryService = { proposeWriteback: vi.fn().mockResolvedValue({ memory_id: "mem_1", candidate_json: "{}" }) };

    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      verificationReader,
      artifacts,
      memoryService,
    );
    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: true, reason: "written" });
    expect(verificationReader.findForSourceNode).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      runId: RUN_ID,
      sourceNodeKey: "node_b",
    });
    expect(artifacts.create).toHaveBeenCalledWith(TENANT_ID, {
      runId: RUN_ID,
      contentType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify({ answer: "final" })),
    });
    expect(memoryService.proposeWriteback).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      workspace_id: `ws_${WORKSPACE_ID}`,
      run_id: RUN_ID,
      verified_output_artifact_id: "art_018f47a5-7b2c-7d10-8f11-987654321abc",
      namespace: "workflow:wf_abc",
    });
  });

  it("skips silently when the run has no compiled workflow version", async () => {
    const db: FakeDb = { run: { workspace_id: WORKSPACE_ID, workflow_id: null, workflow_version_id: null } };
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      fakeVerificationReader([]),
      fakeArtifacts(),
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "no_compiled_workflow_version" });
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("skips when zero terminal nodes exist (nothing succeeded)", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: singleNodeDag(),
      succeededNodes: [],
    };
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      fakeVerificationReader([]),
      fakeArtifacts(),
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "no_terminal_node" });
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("skips when multiple terminal nodes are ambiguous (parallel leaves, no merge/synthesis)", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: parallelLeavesDag(),
      succeededNodes: [
        { id: "node_exec_a", dag_node_id: "node_a" },
        { id: "node_exec_b", dag_node_id: "node_b" },
        { id: "node_exec_c", dag_node_id: "node_c" },
      ],
    };
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      fakeVerificationReader([]),
      fakeArtifacts(),
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "ambiguous_terminal_nodes" });
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("skips when the terminal node never wrote a real Blackboard checkpoint", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: singleNodeDag(),
      succeededNodes: [{ id: "node_exec_a", dag_node_id: "node_a" }],
    };
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      fakeVerificationReader([]),
      fakeArtifacts(),
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "no_output_content" });
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("skips when the terminal node has no passing quality verdict", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: singleNodeDag(),
      succeededNodes: [{ id: "node_exec_a", dag_node_id: "node_a" }],
      checkpoint: { value_json: { answer: "final" } },
    };
    const artifacts = fakeArtifacts();
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      fakeVerificationReader([]),
      artifacts,
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "not_verified" });
    expect(artifacts.create).not.toHaveBeenCalled();
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("skips when quality passes but safety is critical", async () => {
    const db: FakeDb = {
      run: { workspace_id: WORKSPACE_ID, workflow_id: "wf_abc", workflow_version_id: WORKFLOW_VERSION_ID },
      compiledDag: singleNodeDag(),
      succeededNodes: [{ id: "node_exec_a", dag_node_id: "node_a" }],
      checkpoint: { value_json: { answer: "final" } },
    };
    const verificationReader = fakeVerificationReader([
      { gateType: "quality", verdict: "pass", score: 0.95, threshold: 0.8, details: {} },
      { gateType: "safety", verdict: "pass", score: 1, threshold: 0, details: { severity: "critical" } },
    ]);
    const memoryService = { proposeWriteback: vi.fn() };
    const writer = new PostgresRunFinalizationMemoryWriter(
      fakeStore(db),
      verificationReader,
      fakeArtifacts(),
      memoryService,
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, RUN_ID);

    expect(result).toEqual({ written: false, reason: "not_verified" });
    expect(memoryService.proposeWriteback).not.toHaveBeenCalled();
  });

  it("rejects an invalid run id before touching the store", async () => {
    const store = fakeStore({});
    const withTenantSpy = vi.spyOn(store, "withTenant");
    const writer = new PostgresRunFinalizationMemoryWriter(
      store,
      fakeVerificationReader([]),
      fakeArtifacts(),
      { proposeWriteback: vi.fn() },
    );

    const result = await writer.writeVerifiedOutputMemory(TENANT_ID, "not-a-run-id");

    expect(result).toEqual({ written: false, reason: "invalid_run_id" });
    expect(withTenantSpy).not.toHaveBeenCalled();
  });
});
