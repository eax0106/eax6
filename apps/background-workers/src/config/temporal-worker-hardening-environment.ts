export interface TemporalWorkerDeploymentEnvironment {
  readonly deploymentName: string;
  readonly buildId: string;
}

export interface TemporalWorkerHardeningEnvironment {
  readonly workerDeployment: TemporalWorkerDeploymentEnvironment | undefined;
  readonly minimumRetentionDays: number | undefined;
}

interface TemporalWorkerHardeningFields {
  readonly deploymentName: string;
  readonly minimumRetentionDays: string;
}

type ConfigurationErrorFactory = (field: string, reason: string) => Error;

const DEFAULT_CLOUD_MINIMUM_RETENTION_DAYS = 7;

export function loadTemporalWorkerHardeningEnvironment(
  environment: NodeJS.ProcessEnv,
  cloudApiKey: string | undefined,
  fields: TemporalWorkerHardeningFields,
  error: ConfigurationErrorFactory,
): TemporalWorkerHardeningEnvironment {
  const deploymentName = environment[fields.deploymentName]?.trim() || undefined;
  const buildId = environment.TEMPORAL_WORKER_BUILD_ID?.trim() || undefined;

  if (
    (deploymentName === undefined) !== (buildId === undefined) ||
    (cloudApiKey !== undefined && deploymentName === undefined)
  ) {
    throw error(
      fields.deploymentName,
      `must be set with TEMPORAL_WORKER_BUILD_ID${
        cloudApiKey === undefined ? "" : " when TEMPORAL_API_KEY is configured"
      }`,
    );
  }

  const retentionValue = environment[fields.minimumRetentionDays]?.trim();
  let minimumRetentionDays: number | undefined;
  if (retentionValue === undefined || retentionValue.length === 0) {
    minimumRetentionDays =
      cloudApiKey === undefined
        ? undefined
        : DEFAULT_CLOUD_MINIMUM_RETENTION_DAYS;
  } else {
    const parsed = Number(retentionValue);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw error(fields.minimumRetentionDays, "must be a positive integer");
    }
    minimumRetentionDays = parsed;
  }

  return {
    workerDeployment:
      deploymentName === undefined || buildId === undefined
        ? undefined
        : { deploymentName, buildId },
    minimumRetentionDays,
  };
}
