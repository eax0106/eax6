import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, createExecutorWorker, createConversationLifecycleWorker } =
  vi.hoisted(() => ({
    connect: vi.fn(),
    createExecutorWorker: vi.fn(),
    createConversationLifecycleWorker: vi.fn(),
  }));

vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect },
}));

vi.mock("./worker", () => ({
  createExecutorWorker,
  createConversationLifecycleWorker,
}));

vi.mock("./namespace-readiness", () => ({
  assertTemporalNamespaceReady: vi.fn(),
}));

vi.mock("../grpc/nodeexec-client", () => ({
  NodeExecutionClient: class {},
}));

vi.mock("../grpc/blackboard-client", () => ({
  BlackboardClient: class {},
}));

vi.mock("./activities/executor-activities", () => ({
  createExecutorActivities: () => ({}),
}));

import { startExecutorWorker } from "./executor-bootstrap";

describe("startExecutorWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({});
  });

  it("starts executor and conversation workers on their distinct production queues", async () => {
    const executor = { run: vi.fn(), shutdown: vi.fn() };
    const conversation = { run: vi.fn(), shutdown: vi.fn() };
    createExecutorWorker.mockResolvedValue(executor);
    createConversationLifecycleWorker.mockResolvedValue(conversation);

    const handle = await startExecutorWorker({
      temporal: {
        address: "temporal.internal:7233",
        namespace: "engine",
        taskQueue: "executor",
      },
      conversationTaskQueue: "conversation-lifecycle",
      nodeexec: {
        address: "nodeexec.internal:50064",
        protoPath: "/tmp/nodeexec.proto",
      },
      blackboard: {
        address: "blackboard.internal:50065",
        protoPath: "/tmp/blackboard.proto",
      },
    });

    expect(createExecutorWorker).toHaveBeenCalledWith(
      expect.objectContaining({ taskQueue: "executor" }),
      expect.anything(),
      expect.anything(),
    );
    expect(createConversationLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ taskQueue: "conversation-lifecycle" }),
      expect.anything(),
    );
    expect(executor.run).toHaveBeenCalledOnce();
    expect(conversation.run).toHaveBeenCalledOnce();

    handle.shutdown();
    expect(executor.shutdown).toHaveBeenCalledOnce();
    expect(conversation.shutdown).toHaveBeenCalledOnce();
  });
});
