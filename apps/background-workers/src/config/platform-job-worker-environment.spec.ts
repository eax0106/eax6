import { describe, expect, it } from "vitest";

import {
  PlatformJobWorkerConfigurationError,
  loadPlatformJobWorkerEnvironment,
} from "./platform-job-worker-environment";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TEMPORAL_ADDRESS: "temporal.internal:7233",
    PLATFORM_TEMPORAL_NAMESPACE: "platform",
    PLATFORM_JOBS_TASK_QUEUE: "platform-jobs",
    ...overrides,
  };
}

describe("loadPlatformJobWorkerEnvironment", () => {
  it("validates and returns the documented environment", () => {
    expect(loadPlatformJobWorkerEnvironment(environment())).toEqual({
      temporalAddress: "temporal.internal:7233",
      temporalNamespace: "platform",
      temporalApiKey: undefined,
      taskQueue: "platform-jobs",
      workerDeployment: undefined,
      minimumRetentionDays: undefined,
    });
  });

  it("includes a trimmed API key when present", () => {
    expect(
      loadPlatformJobWorkerEnvironment(
        environment({
          TEMPORAL_API_KEY: "  secret-key  ",
          PLATFORM_TEMPORAL_WORKER_DEPLOYMENT_NAME: " platform-workers ",
          TEMPORAL_WORKER_BUILD_ID: " git-sha-123 ",
        }),
      ).temporalApiKey,
    ).toBe("secret-key");
  });

  it("uses a versioned deployment and validates retention for Temporal Cloud", () => {
    expect(
      loadPlatformJobWorkerEnvironment(
        environment({
          TEMPORAL_API_KEY: "secret-key",
          PLATFORM_TEMPORAL_WORKER_DEPLOYMENT_NAME: "platform-workers",
          TEMPORAL_WORKER_BUILD_ID: "git-sha-123",
          PLATFORM_TEMPORAL_MINIMUM_RETENTION_DAYS: "30",
        }),
      ),
    ).toMatchObject({
      workerDeployment: {
        deploymentName: "platform-workers",
        buildId: "git-sha-123",
      },
      minimumRetentionDays: 30,
    });
  });

  it("refuses Cloud startup without deployment identity", () => {
    expect(() =>
      loadPlatformJobWorkerEnvironment(
        environment({ TEMPORAL_API_KEY: "secret-key" }),
      ),
    ).toThrow(PlatformJobWorkerConfigurationError);
  });

  it("throws PlatformJobWorkerConfigurationError when a required field is missing", () => {
    expect(() =>
      loadPlatformJobWorkerEnvironment(
        environment({ PLATFORM_TEMPORAL_NAMESPACE: "" }),
      ),
    ).toThrow(PlatformJobWorkerConfigurationError);
  });

  it("uses its own real namespace/task-queue variables, not the Executor worker's", () => {
    expect(
      loadPlatformJobWorkerEnvironment(
        environment({
          TEMPORAL_NAMESPACE: "engine",
          EXECUTOR_TASK_QUEUE: "executor",
        }),
      ),
    ).toEqual({
      temporalAddress: "temporal.internal:7233",
      temporalNamespace: "platform",
      temporalApiKey: undefined,
      taskQueue: "platform-jobs",
      workerDeployment: undefined,
      minimumRetentionDays: undefined,
    });
  });
});
