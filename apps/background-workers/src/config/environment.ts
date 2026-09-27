import { createEnvironmentValidators } from "@alterx/adapters";

import {
  loadTemporalWorkerHardeningEnvironment,
  type TemporalWorkerDeploymentEnvironment,
} from "./temporal-worker-hardening-environment";

// Config for the Executor worker (EXEC-6). Kept in its own file, same
// reasoning as every other per-ticket environment loader in this monorepo:
// this ticket must not perturb any other ticket's wiring.

export interface ExecutorWorkerEnvironment {
  readonly runtimeMode: "real" | "mock";
  readonly configSource: "appconfig" | "local-file";
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly temporalApiKey: string | undefined;
  readonly taskQueue: string;
  readonly conversationTaskQueue: string;
  readonly workerDeployment: TemporalWorkerDeploymentEnvironment | undefined;
  readonly minimumRetentionDays: number | undefined;
  readonly nodeexecAddress: string;
  readonly blackboardAddress: string;
}

export class ExecutorWorkerConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid Executor worker environment field ${field}: ${reason}`);
    this.name = "ExecutorWorkerConfigurationError";
  }
}

const { requireValue, runtimeMode, configSource: readConfigSource } = createEnvironmentValidators(
  (field, reason) => new ExecutorWorkerConfigurationError(field, reason),
);

export function loadExecutorWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): ExecutorWorkerEnvironment {
  const mode = runtimeMode(environment);
  const temporalApiKey = environment.TEMPORAL_API_KEY?.trim() || undefined;
  const hardening = loadTemporalWorkerHardeningEnvironment(
    environment,
    temporalApiKey,
    {
      deploymentName: "TEMPORAL_WORKER_DEPLOYMENT_NAME",
      minimumRetentionDays: "TEMPORAL_MINIMUM_RETENTION_DAYS",
    },
    (field, reason) => new ExecutorWorkerConfigurationError(field, reason),
  );
  return {
    runtimeMode: mode,
    configSource: readConfigSource(environment),
    temporalAddress: requireValue(environment, "TEMPORAL_ADDRESS"),
    temporalNamespace: requireValue(environment, "TEMPORAL_NAMESPACE"),
    temporalApiKey,
    taskQueue: requireValue(environment, "EXECUTOR_TASK_QUEUE"),
    conversationTaskQueue: requireValue(
      environment,
      "CONVERSATION_LIFECYCLE_TASK_QUEUE",
    ),
    ...hardening,
    nodeexecAddress: requireValue(environment, "NODEEXEC_ADDRESS"),
    blackboardAddress: requireValue(environment, "BLACKBOARD_ADDRESS"),
  };
}
