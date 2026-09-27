import { describe, expect, it } from "vitest";

import {
  ExecutorWorkerConfigurationError,
  loadExecutorWorkerEnvironment,
} from "./environment";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TEMPORAL_ADDRESS: "temporal.internal:7233",
    TEMPORAL_NAMESPACE: "engine",
    EXECUTOR_TASK_QUEUE: "executor",
    CONVERSATION_LIFECYCLE_TASK_QUEUE: "conversation-lifecycle",
    NODEEXEC_ADDRESS: "nodeexec.internal:50064",
    BLACKBOARD_ADDRESS: "blackboard.internal:50065",
    ...overrides,
  };
}

describe("loadExecutorWorkerEnvironment", () => {
  it("keeps local Temporal unversioned without Cloud credentials", () => {
    expect(loadExecutorWorkerEnvironment(environment())).toEqual({
      temporalAddress: "temporal.internal:7233",
      temporalNamespace: "engine",
      temporalApiKey: undefined,
      taskQueue: "executor",
      conversationTaskQueue: "conversation-lifecycle",
      workerDeployment: undefined,
      minimumRetentionDays: undefined,
      nodeexecAddress: "nodeexec.internal:50064",
      blackboardAddress: "blackboard.internal:50065",
    });
  });

  it("requires a versioned deployment and validates retention for Temporal Cloud", () => {
    expect(
      loadExecutorWorkerEnvironment(
        environment({
          TEMPORAL_API_KEY: " cloud-key ",
          TEMPORAL_WORKER_DEPLOYMENT_NAME: " engine-workers ",
          TEMPORAL_WORKER_BUILD_ID: " git-sha-123 ",
          TEMPORAL_MINIMUM_RETENTION_DAYS: "14",
        }),
      ),
    ).toMatchObject({
      temporalApiKey: "cloud-key",
      workerDeployment: {
        deploymentName: "engine-workers",
        buildId: "git-sha-123",
      },
      minimumRetentionDays: 14,
    });
  });

  it("refuses Cloud startup without deployment identity", () => {
    expect(() =>
      loadExecutorWorkerEnvironment(
        environment({ TEMPORAL_API_KEY: "cloud-key" }),
      ),
    ).toThrow(ExecutorWorkerConfigurationError);
  });

  it("requires the conversation worker task queue", () => {
    expect(() =>
      loadExecutorWorkerEnvironment(
        environment({ CONVERSATION_LIFECYCLE_TASK_QUEUE: "" }),
      ),
    ).toThrow(ExecutorWorkerConfigurationError);
  });
});
