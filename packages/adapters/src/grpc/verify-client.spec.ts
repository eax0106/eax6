import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

import { VerifyServiceClient } from "./verify-client";

const request = {
  tenant_id: "ten_1",
  run_id: "run_1",
  node_execution_id: "node_1",
  node_key: "merge",
  node_type: "Merge",
  config_json: "{}",
  output_json: "{}",
  success_criteria: [],
};

describe("VerifyServiceClient", () => {
  it("calls the real ScoreNodeInline RPC with the executor's final payload", async () => {
    const grpc = {
      scoreNodeInline: vi.fn((_request, _metadata, _options, callback) => callback(null, {
        verdict: "pass", score: 1, threshold: 0.8, reviewer_model: "deterministic", details_json: "{}",
      })),
    };
    const client = new VerifyServiceClient({ address: "localhost:50054", protoPath: "unused", authorization: "Bearer service-token" }, grpc as never);

    await expect(client.scoreNodeInline(request)).resolves.toMatchObject({ verdict: "pass", score: 1 });
    expect(grpc.scoreNodeInline).toHaveBeenCalledWith(
      request,
      expect.any(Metadata),
      expect.objectContaining({ deadline: expect.any(Date) }),
      expect.any(Function),
    );
    const metadata = grpc.scoreNodeInline.mock.calls[0]?.[1] as Metadata;
    expect(metadata.get("authorization")).toEqual(["Bearer service-token"]);
  });

  it("sanitizes gRPC failures", async () => {
    const grpc = {
      scoreNodeInline: vi.fn((_request, _metadata, _options, callback) => callback({ code: status.DEADLINE_EXCEEDED })),
    };
    const client = new VerifyServiceClient({ address: "localhost:50054", protoPath: "unused", authorization: "Bearer service-token" }, grpc as never);

    await expect(client.scoreNodeInline(request)).rejects.toMatchObject({ code: "deadline_exceeded" });
  });
});
