import { describe, expect, it, vi } from "vitest";

import type {
  NodeexecExecuteNodeRequest,
  NodeexecExecuteNodeResponse,
} from "@alterx/contracts";
import { NodeExecutionClient } from "./nodeexec-client";

function fakeGrpcClient(
  handler: (
    request: NodeexecExecuteNodeRequest,
  ) => { error: Error | null; response?: NodeexecExecuteNodeResponse },
) {
  return {
    executeNode: vi.fn(
      (
        request: NodeexecExecuteNodeRequest,
        _options: unknown,
        callback: (
          error: Error | null,
          response?: NodeexecExecuteNodeResponse,
        ) => void,
      ) => {
        const { error, response } = handler(request);
        callback(error, response);
      },
    ),
  };
}

const REQUEST: NodeexecExecuteNodeRequest = {
  tenant_id: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
  run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
  node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
  node_key: "node_a",
  node_type: "Merge",
  config_json: "{}",
  inputs_json: "{}",
  success_criteria: [],
};

describe("NodeExecutionClient", () => {
  it("resolves with the Node Execution Service's real response", async () => {
    const grpcClient = fakeGrpcClient(() => ({
      error: null,
      response: { output_json: JSON.stringify({ x: 1 }), metadata_json: "{}" },
    }));
    const client = new NodeExecutionClient(
      { address: "localhost:1234", protoPath: "unused" },
      grpcClient as never,
    );

    const response = await client.executeNode(REQUEST);

    expect(response.output_json).toBe(JSON.stringify({ x: 1 }));
    expect(grpcClient.executeNode).toHaveBeenCalledWith(
      REQUEST,
      expect.objectContaining({ deadline: expect.any(Date) }),
      expect.any(Function),
    );
  });

  it("rejects when the gRPC call errors", async () => {
    const grpcClient = fakeGrpcClient(() => ({
      error: new Error("unavailable"),
    }));
    const client = new NodeExecutionClient(
      { address: "localhost:1234", protoPath: "unused" },
      grpcClient as never,
    );

    await expect(client.executeNode(REQUEST)).rejects.toThrow("unavailable");
  });

  it("rejects when the response is empty", async () => {
    const grpcClient = fakeGrpcClient(() => ({ error: null }));
    const client = new NodeExecutionClient(
      { address: "localhost:1234", protoPath: "unused" },
      grpcClient as never,
    );

    await expect(client.executeNode(REQUEST)).rejects.toThrow("empty response");
  });
});
