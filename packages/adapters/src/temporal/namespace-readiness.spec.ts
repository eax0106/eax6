import { describe, expect, it, vi } from "vitest";

import {
  TemporalNamespaceConfigurationError,
  assertTemporalNamespaceReady,
} from "./namespace-readiness";

describe("assertTemporalNamespaceReady", () => {
  it("accepts a namespace whose retention meets the configured floor", async () => {
    const describeNamespace = vi.fn(async () => ({
      config: { workflowExecutionRetentionTtl: { seconds: 14 * 86_400, nanos: 0 } },
    }));

    await expect(
      assertTemporalNamespaceReady(
        { workflowService: { describeNamespace } } as never,
        "engine.prod",
        7,
      ),
    ).resolves.toBeUndefined();
    expect(describeNamespace).toHaveBeenCalledWith({ namespace: "engine.prod" });
  });

  it("fails before polling when Cloud retention is below the required floor", async () => {
    const describeNamespace = vi.fn(async () => ({
      config: { workflowExecutionRetentionTtl: { seconds: 86_400, nanos: 0 } },
    }));

    await expect(
      assertTemporalNamespaceReady(
        { workflowService: { describeNamespace } } as never,
        "engine.prod",
        7,
      ),
    ).rejects.toThrow(TemporalNamespaceConfigurationError);
  });
});
