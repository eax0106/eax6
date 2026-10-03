import type { MemoryWritebackHandler } from "@alterx/adapters";
import { describe, expect, it, vi } from "vitest";

import { NodeHandlerValidationError } from "../handler";
import { MemoryWriteHandler } from "./memory-write.handler";

const context = {
  config: {
    workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    verified_output_artifact_id: "art_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    namespace: "project-memory",
  },
  inputs: {},
  tenant_id: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  run_id: "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
};

describe("MemoryWriteHandler", () => {
  it("writes the verified artifact through Memory Service", async () => {
    const proposeWriteback = vi.fn().mockResolvedValue({
      memory_id: "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      candidate_json: "{\"status\":\"candidate\"}",
    });
    const handler = new MemoryWriteHandler({ proposeWriteback } as MemoryWritebackHandler);

    await expect(handler.execute(context)).resolves.toEqual({
      output: {
        memory_id: "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        candidate_json: "{\"status\":\"candidate\"}",
      },
    });
    expect(proposeWriteback).toHaveBeenCalledWith({
      tenant_id: context.tenant_id,
      workspace_id: context.config.workspace_id,
      run_id: context.run_id,
      verified_output_artifact_id: context.config.verified_output_artifact_id,
      namespace: context.config.namespace,
    });
  });

  it("fails closed when a verified artifact reference is absent", async () => {
    const handler = new MemoryWriteHandler({ proposeWriteback: vi.fn() });
    await expect(handler.execute({ ...context, config: {} })).rejects.toBeInstanceOf(
      NodeHandlerValidationError,
    );
  });

  it("completes a disabled write without reporting a stored memory", async () => {
    const handler = new MemoryWriteHandler({ proposeWriteback: vi.fn().mockResolvedValue({
      memory_id: "", candidate_json: "{}", skipped: true,
    }) });
    await expect(handler.execute(context)).resolves.toEqual({
      output: { skipped: true, reason: "memory_disabled" },
    });
  });
});
