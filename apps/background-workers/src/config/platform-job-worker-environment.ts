import { createEnvironmentValidators } from "@alterx/adapters";

import {
  loadTemporalWorkerHardeningEnvironment,
  type TemporalWorkerDeploymentEnvironment,
} from "./temporal-worker-hardening-environment";

// Config for the Platform Jobs worker (Engagement Phase, doc 12). Own file,
// same reasoning as every other per-ticket environment loader in this
// monorepo: this ticket must not perturb any other ticket's wiring.

export interface PlatformJobWorkerEnvironment {
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly temporalApiKey: string | undefined;
  readonly taskQueue: string;
  readonly workerDeployment: TemporalWorkerDeploymentEnvironment | undefined;
  readonly minimumRetentionDays: number | undefined;
}

export class PlatformJobWorkerConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(
      `Invalid Platform Job worker environment field ${field}: ${reason}`,
    );
    this.name = "PlatformJobWorkerConfigurationError";
  }
}

const { requireValue } = createEnvironmentValidators(
  (field, reason) => new PlatformJobWorkerConfigurationError(field, reason),
);

export function loadPlatformJobWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): PlatformJobWorkerEnvironment {
  const temporalApiKey = environment.TEMPORAL_API_KEY?.trim() || undefined;
  const hardening = loadTemporalWorkerHardeningEnvironment(
    environment,
    temporalApiKey,
    {
      deploymentName: "PLATFORM_TEMPORAL_WORKER_DEPLOYMENT_NAME",
      minimumRetentionDays: "PLATFORM_TEMPORAL_MINIMUM_RETENTION_DAYS",
    },
    (field, reason) => new PlatformJobWorkerConfigurationError(field, reason),
  );
  return {
    temporalAddress: requireValue(environment, "TEMPORAL_ADDRESS"),
    temporalNamespace: requireValue(environment, "PLATFORM_TEMPORAL_NAMESPACE"),
    temporalApiKey,
    taskQueue: requireValue(environment, "PLATFORM_JOBS_TASK_QUEUE"),
    ...hardening,
  };
}
