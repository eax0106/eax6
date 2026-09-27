import { createEnvironmentValidators } from "@alterx/adapters";

// Config for the Platform Jobs handlers + digest scheduler runner
// (Engagement Phase, doc 12). Own file, same reasoning as every other
// per-ticket environment loader in this monorepo.

export interface PlatformJobsEnvironment {
  readonly platformApiInternalBaseUrl: string;
  readonly notificationDigestServiceTokenRef: string;
  readonly notificationDigestIntervalMs: number;
  readonly connectorHealthSweepServiceTokenRef: string;
  readonly connectorHealthSweepIntervalMs: number;
  readonly adsCoreInternalBaseUrl: string;
  readonly retentionSweepServiceTokenRef: string;
  readonly retentionSweepIntervalMs: number;
  readonly orchestrationServiceInternalBaseUrl: string;
  readonly orchestrationRetentionSweepServiceTokenRef: string;
  readonly orchestrationRetentionSweepIntervalMs: number;
  readonly evalFacadeServiceTokenRef: string;
  readonly benchmarkSweepIntervalMs: number;
  readonly intelligenceServiceInternalBaseUrl: string;
  readonly memoryServiceInternalBaseUrl: string;
  readonly driftSweepServiceTokenRef: string;
  readonly driftSweepIntervalMs: number;
  readonly driftSweepMinimumObservations: number;
  readonly auditServiceInternalBaseUrl: string;
  readonly auditChainVerifyServiceTokenRef: string;
  readonly auditChainVerifyIntervalMs: number;
  readonly auditChainFullVerifyIntervalMs: number;
}

export class PlatformJobsConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid Platform Jobs environment field ${field}: ${reason}`);
    this.name = "PlatformJobsConfigurationError";
  }
}

const { requireValue } = createEnvironmentValidators(
  (field, reason) => new PlatformJobsConfigurationError(field, reason),
);

const DEFAULT_DIGEST_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_CONNECTOR_HEALTH_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_ORCHESTRATION_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_BENCHMARK_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_DRIFT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DEFAULT_DRIFT_SWEEP_MINIMUM_OBSERVATIONS = 40; // 2 * memory-service's default window size
const DEFAULT_AUDIT_CHAIN_VERIFY_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const DEFAULT_AUDIT_CHAIN_FULL_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

function parseIntervalMs(
  environment: NodeJS.ProcessEnv,
  field: string,
  defaultMs: number,
): number {
  const raw = environment[field]?.trim();
  const intervalMs = raw ? Number(raw) : defaultMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new PlatformJobsConfigurationError(field, "must be a positive number when set");
  }
  return intervalMs;
}

function parsePositiveInteger(
  environment: NodeJS.ProcessEnv,
  field: string,
  defaultValue: number,
): number {
  const raw = environment[field]?.trim();
  const value = raw ? Number(raw) : defaultValue;
  if (!Number.isInteger(value) || value <= 0) {
    throw new PlatformJobsConfigurationError(field, "must be a positive integer when set");
  }
  return value;
}

export function loadPlatformJobsEnvironment(
  environment: NodeJS.ProcessEnv,
): PlatformJobsEnvironment {
  return {
    platformApiInternalBaseUrl: requireValue(environment, "PLATFORM_API_INTERNAL_BASE_URL"),
    notificationDigestServiceTokenRef: requireValue(
      environment,
      "NOTIFICATION_DIGEST_SERVICE_TOKEN_REF",
    ),
    notificationDigestIntervalMs: parseIntervalMs(
      environment,
      "NOTIFICATION_DIGEST_INTERVAL_MS",
      DEFAULT_DIGEST_INTERVAL_MS,
    ),
    connectorHealthSweepServiceTokenRef: requireValue(
      environment,
      "CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF",
    ),
    connectorHealthSweepIntervalMs: parseIntervalMs(
      environment,
      "CONNECTOR_HEALTH_SWEEP_INTERVAL_MS",
      DEFAULT_CONNECTOR_HEALTH_SWEEP_INTERVAL_MS,
    ),
    adsCoreInternalBaseUrl: requireValue(environment, "ADS_CORE_INTERNAL_BASE_URL"),
    retentionSweepServiceTokenRef: requireValue(
      environment,
      "RETENTION_SWEEP_SERVICE_TOKEN_REF",
    ),
    retentionSweepIntervalMs: parseIntervalMs(
      environment,
      "RETENTION_SWEEP_INTERVAL_MS",
      DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
    ),
    orchestrationServiceInternalBaseUrl: requireValue(
      environment,
      "ORCHESTRATION_SERVICE_INTERNAL_BASE_URL",
    ),
    orchestrationRetentionSweepServiceTokenRef: requireValue(
      environment,
      "ORCHESTRATION_RETENTION_SWEEP_SERVICE_TOKEN_REF",
    ),
    orchestrationRetentionSweepIntervalMs: parseIntervalMs(
      environment,
      "ORCHESTRATION_RETENTION_SWEEP_INTERVAL_MS",
      DEFAULT_ORCHESTRATION_RETENTION_SWEEP_INTERVAL_MS,
    ),
    evalFacadeServiceTokenRef: requireValue(environment, "EVAL_FACADE_SERVICE_TOKEN_REF"),
    benchmarkSweepIntervalMs: parseIntervalMs(
      environment,
      "BENCHMARK_SWEEP_INTERVAL_MS",
      DEFAULT_BENCHMARK_SWEEP_INTERVAL_MS,
    ),
    intelligenceServiceInternalBaseUrl: requireValue(
      environment,
      "INTELLIGENCE_SERVICE_INTERNAL_BASE_URL",
    ),
    memoryServiceInternalBaseUrl: requireValue(environment, "MEMORY_SERVICE_INTERNAL_BASE_URL"),
    driftSweepServiceTokenRef: requireValue(environment, "DRIFT_SWEEP_SERVICE_TOKEN_REF"),
    driftSweepIntervalMs: parseIntervalMs(
      environment,
      "DRIFT_SWEEP_INTERVAL_MS",
      DEFAULT_DRIFT_SWEEP_INTERVAL_MS,
    ),
    driftSweepMinimumObservations: parsePositiveInteger(
      environment,
      "DRIFT_SWEEP_MINIMUM_OBSERVATIONS",
      DEFAULT_DRIFT_SWEEP_MINIMUM_OBSERVATIONS,
    ),
    auditServiceInternalBaseUrl: requireValue(environment, "AUDIT_SERVICE_INTERNAL_BASE_URL"),
    auditChainVerifyServiceTokenRef: requireValue(
      environment,
      "AUDIT_CHAIN_VERIFY_SERVICE_TOKEN_REF",
    ),
    auditChainVerifyIntervalMs: parseIntervalMs(
      environment,
      "AUDIT_CHAIN_VERIFY_INTERVAL_MS",
      DEFAULT_AUDIT_CHAIN_VERIFY_INTERVAL_MS,
    ),
    auditChainFullVerifyIntervalMs: parseIntervalMs(
      environment,
      "AUDIT_CHAIN_FULL_VERIFY_INTERVAL_MS",
      DEFAULT_AUDIT_CHAIN_FULL_VERIFY_INTERVAL_MS,
    ),
  };
}

/** Mirrors platform-api's own resolveRuntimeSecret shape exactly (apps
 * don't import each other's internals in this monorepo -- duplicated
 * on purpose, same real behavior). */
export async function resolveRuntimeSecret(reference: string): Promise<string> {
  const environmentKey = reference.startsWith("env:") ? reference.slice("env:".length) : reference;
  const value = process.env[environmentKey];
  if (!value) {
    throw new Error(`Secret reference unavailable: ${reference}`);
  }
  return value;
}
