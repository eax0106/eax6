import { describe, expect, it, vi } from "vitest";

import type { BlackboardHandlerClient } from "../../grpc/blackboard-client";
import type { NodeExecutionHandler } from "../../grpc/nodeexec-client";

import { createExecutorActivities } from "./executor-activities";

const BASE_INPUT = {
  tenantId: "ten_test",
  runId: "run_test",
  nodeExecutionId: "node_test",
  nodeKey: "node_b",
  nodeType: "Merge",
  configJson: "{}",
};

function fakeNodeExecutionClient(
  outputJson: string,
  metadataJson = "{}",
): NodeExecutionHandler {
  return {
    executeNode: vi.fn(async () => ({
      output_json: outputJson,
      metadata_json: metadataJson,
    })),
    finalizeRun: vi.fn(async () => ({ status: "completed", ended_at: "" })),
    finalizeApprovalNode: vi.fn(async () => ({ status: "succeeded" })),
  };
}

function fakeBlackboardClient(
  values: Record<string, unknown> = {},
): BlackboardHandlerClient {
  return {
    readValue: vi.fn(async (request) => {
      const value = values[request.key];
      return value === undefined
        ? { found: false, value_json: "" }
        : { found: true, value_json: JSON.stringify(value) };
    }),
    writeValue: vi.fn(async () => ({})),
  };
}

describe("createExecutorActivities.executeNode", () => {
  it("reads each predecessor's value from the Blackboard and assembles inputs_json", async () => {
    const nodeExecutionClient = fakeNodeExecutionClient(JSON.stringify({ ok: true }));
    const blackboardClient = fakeBlackboardClient({
      node_a: { from: "node_a" },
      node_c: { from: "node_c" },
    });
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    await activities.executeNode({
      ...BASE_INPUT,
      predecessorKeys: ["node_a", "node_c"],
    });

    expect(blackboardClient.readValue).toHaveBeenCalledWith({
      tenant_id: "ten_test",
      run_id: "run_test",
      key: "node_a",
    });
    expect(blackboardClient.readValue).toHaveBeenCalledWith({
      tenant_id: "ten_test",
      run_id: "run_test",
      key: "node_c",
    });
    expect(nodeExecutionClient.executeNode).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs_json: JSON.stringify({
          node_a: { from: "node_a" },
          node_c: { from: "node_c" },
        }),
      }),
    );
  });

  it("carries the compiled node's success criteria to Nodeexec, and none on older workflows (C29)", async () => {
    const nodeExecutionClient = fakeNodeExecutionClient(JSON.stringify({ ok: true }));
    const activities = createExecutorActivities(nodeExecutionClient, fakeBlackboardClient({}));

    await activities.executeNode({ ...BASE_INPUT, predecessorKeys: [], successCriteria: ["Currency given"] });
    await activities.executeNode({ ...BASE_INPUT, predecessorKeys: [] });

    expect(vi.mocked(nodeExecutionClient.executeNode).mock.calls.map(([request]) => request.success_criteria)).toEqual([
      ["Currency given"],
      [],
    ]);
  });

  it("omits a predecessor from inputs when its Blackboard value is not found", async () => {
    const nodeExecutionClient = fakeNodeExecutionClient(JSON.stringify({ ok: true }));
    const blackboardClient = fakeBlackboardClient({});
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    await activities.executeNode({ ...BASE_INPUT, predecessorKeys: ["node_missing"] });

    expect(nodeExecutionClient.executeNode).toHaveBeenCalledWith(
      expect.objectContaining({ inputs_json: "{}" }),
    );
  });

  it("writes its own output to the Blackboard under its node key", async () => {
    const nodeExecutionClient = fakeNodeExecutionClient(JSON.stringify({ result: 42 }));
    const blackboardClient = fakeBlackboardClient();
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    await activities.executeNode({ ...BASE_INPUT, predecessorKeys: [] });

    expect(blackboardClient.writeValue).toHaveBeenCalledWith({
      tenant_id: "ten_test",
      run_id: "run_test",
      key: "node_b",
      value_json: JSON.stringify({ result: 42 }),
    });
  });

  it("returns the node execution's output and metadata", async () => {
    const nodeExecutionClient = fakeNodeExecutionClient(
      JSON.stringify({ x: 1 }),
      JSON.stringify({ usage: {} }),
    );
    const blackboardClient = fakeBlackboardClient();
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    const result = await activities.executeNode({ ...BASE_INPUT, predecessorKeys: [] });

    expect(result).toEqual({
      outputJson: JSON.stringify({ x: 1 }),
      metadataJson: JSON.stringify({ usage: {} }),
    });
  });

  it("reads predecessors concurrently, not sequentially", async () => {
    const order: string[] = [];
    const nodeExecutionClient = fakeNodeExecutionClient("{}");
    const blackboardClient: BlackboardHandlerClient = {
      readValue: vi.fn(async (request) => {
        order.push(`start:${request.key}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${request.key}`);
        return { found: false, value_json: "" };
      }),
      writeValue: vi.fn(async () => ({})),
    };
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    await activities.executeNode({
      ...BASE_INPUT,
      predecessorKeys: ["node_a", "node_c"],
    });

    // Both reads must start before either finishes -- proves Promise.all,
    // not a sequential await-in-a-loop.
    expect(order.slice(0, 2).sort()).toEqual(["start:node_a", "start:node_c"]);
  });

  it("propagates a nodeExecutionClient error", async () => {
    const nodeExecutionClient: NodeExecutionHandler = {
      executeNode: vi.fn().mockRejectedValue(new Error("boom")),
      finalizeRun: vi.fn(async () => ({ status: "completed", ended_at: "" })),
    finalizeApprovalNode: vi.fn(async () => ({ status: "succeeded" })),
    };
    const blackboardClient = fakeBlackboardClient();
    const activities = createExecutorActivities(nodeExecutionClient, blackboardClient);

    await expect(
      activities.executeNode({ ...BASE_INPUT, predecessorKeys: [] }),
    ).rejects.toThrow("boom");
  });
});
