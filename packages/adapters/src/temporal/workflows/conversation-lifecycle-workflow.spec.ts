import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConversationLifecycleWorker } from "../worker";
import type {
  ConversationLifecycleInput,
  IncomingConversationMessage,
  SpawnChildRunSignalPayload,
} from "./conversation-lifecycle-workflow";

const WORKFLOW_TYPE = "conversationLifecycleWorkflow";

interface RunningWorker {
  readonly worker: Worker;
  readonly runPromise: Promise<void>;
}

function startWorker(worker: Worker): RunningWorker {
  return { worker, runPromise: worker.run() };
}

async function stopWorker(running: RunningWorker): Promise<void> {
  running.worker.shutdown();
  await running.runPromise;
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function message(
  messageId: string,
  overrides: Partial<IncomingConversationMessage> = {},
): IncomingConversationMessage {
  return {
    messageId,
    channel: "whatsapp",
    payload: { text: `hello-${messageId}` },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.sequential("conversationLifecycleWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  });

  afterAll(async () => {
    await environment.teardown();
  });

  function config(taskQueue: string) {
    return { address: environment.address, namespace: environment.namespace ?? "default", taskQueue };
  }

  function input(
    overrides: Partial<ConversationLifecycleInput> = {},
  ): ConversationLifecycleInput {
    return {
      tenantId: "tnt_test",
      conversationId: "conv_test",
      idleTimeoutSeconds: 60,
      historyRolloverEventCount: 500,
      ...overrides,
    };
  }

  it("orders accepted messages and dedupes by messageId", async () => {
    const taskQueue = "conversation-lifecycle-ordering";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-lifecycle-ordering-workflow";

    try {
      const handle = await environment.client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId,
        args: [input()],
      });

      await handle.signal("message", message("m1"));
      await handle.signal("message", message("m2"));
      await handle.signal("message", message("m1"));

      await expect(
        handle.query<readonly IncomingConversationMessage[]>("messages"),
      ).resolves.toMatchObject([{ messageId: "m1" }, { messageId: "m2" }]);
      await expect(handle.query("status")).resolves.toBe("active");

      await handle.signal("close");
      await handle.result();
      await expect(handle.query("status")).resolves.toBe("closed");
    } finally {
      await stopWorker(running);
    }
  });

  it("continues as new before history grows without losing recent state", async () => {
    const taskQueue = "conversation-lifecycle-history-rollover";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-lifecycle-history-rollover-workflow";

    try {
      const handle = await environment.client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId,
        args: [
          input({
            historyRolloverEventCount: 2,
          }),
        ],
      });
      const firstRunId = handle.firstExecutionRunId;

      await handle.signal("message", message("rollover-1"));
      await handle.signal("message", message("rollover-2"));

      await pollUntil(
        () => handle.describe(),
        (description) => description.runId !== firstRunId,
      );
      await expect(
        handle.query<readonly IncomingConversationMessage[]>("messages"),
      ).resolves.toMatchObject([
        { messageId: "rollover-1" },
        { messageId: "rollover-2" },
      ]);

      await handle.signal("message", message("rollover-1"));
      await expect(
        handle.query<readonly IncomingConversationMessage[]>("messages"),
      ).resolves.toHaveLength(2);

      await handle.signal("close");
      await handle.result();
    } finally {
      await stopWorker(running);
    }
  });

  it("auto-closes after the idle timeout elapses with no activity", async () => {
    const taskQueue = "conversation-lifecycle-idle";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-lifecycle-idle-workflow";

    try {
      const handle = await environment.client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId,
        args: [input({ idleTimeoutSeconds: 5 })],
      });

      await environment.sleep("10 seconds");
      await handle.result();
      await expect(handle.query("status")).resolves.toBe("closed");
    } finally {
      await stopWorker(running);
    }
  });

  it("spawns a child run via startChild, decoupled from the parent's own lifecycle", async () => {
    const taskQueue = "conversation-lifecycle-child-run";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-lifecycle-child-run-workflow";
    const childWorkflowId = "conversation-lifecycle-child-run-child";

    try {
      const handle = await environment.client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId,
        args: [input()],
      });

      const spawnPayload: SpawnChildRunSignalPayload = {
        workflowId: childWorkflowId,
        workflowType: WORKFLOW_TYPE,
        taskQueue,
        input: { ...input({ conversationId: "conv_child", idleTimeoutSeconds: 1 }) },
      };
      await handle.signal("spawnChildRun", spawnPayload);

      await pollUntil(
        () => handle.query<readonly string[]>("childRunIds"),
        (ids) => ids.length > 0,
      );
      await expect(
        handle.query<readonly string[]>("childRunIds"),
      ).resolves.toEqual([childWorkflowId]);

      // Parent closes immediately; ABANDON parentClosePolicy means the
      // child keeps running independently and reaches its own idle-close.
      await handle.signal("close");
      await handle.result();
      await expect(handle.query("status")).resolves.toBe("closed");

      const childHandle = environment.client.workflow.getHandle(childWorkflowId);
      await environment.sleep("5 seconds");
      await childHandle.result();
      await expect(childHandle.query("status")).resolves.toBe("closed");
    } finally {
      await stopWorker(running);
    }
  });

  it("survives a spawnChildRun that fails (duplicate child workflow id)", async () => {
    const taskQueue = "conversation-lifecycle-child-run-failure";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-lifecycle-child-run-failure-workflow";
    const childWorkflowId = "conversation-lifecycle-child-run-failure-child";

    try {
      const handle = await environment.client.workflow.start(WORKFLOW_TYPE, {
        taskQueue,
        workflowId,
        args: [input()],
      });

      const spawnPayload: SpawnChildRunSignalPayload = {
        workflowId: childWorkflowId,
        workflowType: WORKFLOW_TYPE,
        taskQueue,
        input: { ...input({ conversationId: "conv_child", idleTimeoutSeconds: 60 }) },
      };
      await handle.signal("spawnChildRun", spawnPayload);
      await pollUntil(
        () => handle.query<readonly string[]>("childRunIds"),
        (ids) => ids.length > 0,
      );

      // Same child workflow id again -- Temporal rejects the duplicate
      // startChild call; the workflow must swallow it, not crash.
      await handle.signal("spawnChildRun", spawnPayload);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(
        handle.query<readonly string[]>("childRunIds"),
      ).resolves.toEqual([childWorkflowId]);
      await expect(handle.query("status")).resolves.toBe("active");

      await handle.signal("close");
      await handle.result();
      await expect(handle.query("status")).resolves.toBe("closed");
    } finally {
      await stopWorker(running);
    }
  });
});
