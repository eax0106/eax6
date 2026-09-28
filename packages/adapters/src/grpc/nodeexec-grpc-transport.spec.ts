import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { describe, expect, it } from "vitest";

import {
  NodeexecGrpcController,
  SAFETY_VIOLATION_PREFIX,
  type NodeexecHandler,
} from "./nodeexec-grpc-transport";

function controllerThrowing(error: Error): NodeexecGrpcController {
  const handler = {
    executeNode: async () => {
      throw error;
    },
  } as unknown as NodeexecHandler;
  return new NodeexecGrpcController(handler);
}

async function rpcError(controller: NodeexecGrpcController): Promise<{ code: number; message: string }> {
  const caught = await controller
    .executeNode({} as Parameters<NodeexecGrpcController["executeNode"]>[0])
    .catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(RpcException);
  return (caught as RpcException).getError() as { code: number; message: string };
}

describe("NodeexecGrpcController error mapping", () => {
  it("carries a safety halt across the wire as its own marked failure (design log §4)", async () => {
    const error = new Error("Verify Gate blocked node output as a safety violation; the workflow halts");
    error.name = "SafetyViolationError";

    const mapped = await rpcError(controllerThrowing(error));

    expect(mapped.code).toBe(status.FAILED_PRECONDITION);
    expect(mapped.message).toBe(`${SAFETY_VIOLATION_PREFIX}${error.message}`);
  });

  it("does not mark an ordinary failure as a safety halt", async () => {
    const mapped = await rpcError(controllerThrowing(new Error("Verify Gate rejected node output")));

    expect(mapped.message.startsWith(SAFETY_VIOLATION_PREFIX)).toBe(false);
  });
});
