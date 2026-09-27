import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConversationDispatchClient,
  ConversationDispatchConfigurationError,
  type ConversationDispatchConfig,
} from "./conversation-dispatch-client";
import { createConversationLifecycleWorker } from "./worker";
import type {
  ConversationLifecycleInput,
  IncomingConversationMessage,
} from "./workflows/conversation-lifecycle-workflow";

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

describe.sequential("ConversationDispatchClient", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  });

  afterAll(async () => {
    await environment.teardown();
  });

  function config(taskQueue: string): ConversationDispatchConfig {
    return {
      address: environment.address,
      namespace: environment.namespace ?? "default",
      taskQueue,
    };
  }

  function workflowInput(
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

  function messagePayload(
    messageId: string,
  ): IncomingConversationMessage {
    return {
      messageId,
      channel: "whatsapp",
      payload: { text: `hello-${messageId}` },
      receivedAt: new Date().toISOString(),
    };
  }

  it("starts a fresh workflow and signals it in one call when none is running", async () => {
    const taskQueue = "conversation-dispatch-start";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-dispatch-start-workflow";
    const client = new ConversationDispatchClient(
      config(taskQueue),
      environment.connection,
    );

    try {
      const result = await client.dispatchMessage({
        workflowId,
        workflowType: WORKFLOW_TYPE,
        workflowInput: { ...workflowInput({ conversationId: workflowId }) },
        signalName: "message",
        signalPayload: { ...messagePayload("m1") },
      });

      expect(result.workflowId).toBe(workflowId);
      expect(result.signaledRunId).not.toHaveLength(0);

      const handle = environment.client.workflow.getHandle(workflowId);
      await expect(
        handle.query<readonly IncomingConversationMessage[]>("messages"),
      ).resolves.toMatchObject([{ messageId: "m1" }]);

      await handle.signal("close");
      await handle.result();
    } finally {
      await client.close();
      await stopWorker(running);
    }
  });

  it("signals an already-running workflow instead of restarting it", async () => {
    const taskQueue = "conversation-dispatch-existing";
    const running = startWorker(
      await createConversationLifecycleWorker(
        config(taskQueue),
        environment.nativeConnection,
      ),
    );
    const workflowId = "conversation-dispatch-existing-workflow";
    const client = new ConversationDispatchClient(
      config(taskQueue),
      environment.connection,
    );

    try {
      const firstRunId = await environment.client.workflow.start(
        WORKFLOW_TYPE,
        {
          taskQueue,
          workflowId,
          args: [workflowInput({ conversationId: workflowId })],
        },
      );

      const result = await client.dispatchMessage({
        workflowId,
        workflowType: WORKFLOW_TYPE,
        workflowInput: { ...workflowInput({ conversationId: workflowId }) },
        signalName: "message",
        signalPayload: { ...messagePayload("m1") },
      });

      expect(result.signaledRunId).toBe(firstRunId.firstExecutionRunId);

      const handle = environment.client.workflow.getHandle(workflowId);
      await expect(
        handle.query<readonly IncomingConversationMessage[]>("messages"),
      ).resolves.toMatchObject([{ messageId: "m1" }]);

      await handle.signal("close");
      await handle.result();
    } finally {
      await client.close();
      await stopWorker(running);
    }
  });

  it("rejects incomplete connection configuration", () => {
    expect(
      () =>
        new ConversationDispatchClient({
          address: " ",
          namespace: "default",
          taskQueue: "queue",
        }),
    ).toThrow(ConversationDispatchConfigurationError);
    expect(
      () =>
        new ConversationDispatchClient({
          address: "localhost:7233",
          namespace: "",
          taskQueue: "queue",
        }),
    ).toThrow(ConversationDispatchConfigurationError);
    expect(
      () =>
        new ConversationDispatchClient({
          address: "localhost:7233",
          namespace: "default",
          taskQueue: "",
        }),
    ).toThrow(ConversationDispatchConfigurationError);
  });
});
