import { describe, expect, it } from "vitest";
import {
  PlatformJobsConfigurationError,
  loadPlatformJobsEnvironment,
  resolveRuntimeSecret,
} from "./platform-jobs-environment";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PLATFORM_API_INTERNAL_BASE_URL: "http://platform-api.internal",
    NOTIFICATION_DIGEST_SERVICE_TOKEN_REF: "env:NOTIFICATION_DIGEST_TOKEN",
    CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF: "env:CONNECTOR_HEALTH_SWEEP_TOKEN",
    ADS_CORE_INTERNAL_BASE_URL: "http://ads-core.internal",
    RETENTION_SWEEP_SERVICE_TOKEN_REF: "env:RETENTION_SWEEP_TOKEN",
    ORCHESTRATION_SERVICE_INTERNAL_BASE_URL: "http://orchestration-service.internal",
    ORCHESTRATION_RETENTION_SWEEP_SERVICE_TOKEN_REF: "env:ORCHESTRATION_RETENTION_SWEEP_TOKEN",
    EVAL_FACADE_SERVICE_TOKEN_REF: "env:EVAL_FACADE_SERVICE_TOKEN",
    INTELLIGENCE_SERVICE_INTERNAL_BASE_URL: "http://intelligence-service.internal",
    MEMORY_SERVICE_INTERNAL_BASE_URL: "http://memory-service.internal",
    DRIFT_SWEEP_SERVICE_TOKEN_REF: "env:DRIFT_SWEEP_SERVICE_TOKEN",
    AUDIT_SERVICE_INTERNAL_BASE_URL: "http://audit-service.internal",
    AUDIT_CHAIN_VERIFY_SERVICE_TOKEN_REF: "env:AUDIT_CHAIN_VERIFY_SERVICE_TOKEN",
    ...overrides,
  };
}

describe("loadPlatformJobsEnvironment", () => {
  it("validates and returns the documented environment with real default intervals", () => {
    expect(loadPlatformJobsEnvironment(environment())).toEqual({
      platformApiInternalBaseUrl: "http://platform-api.internal",
      notificationDigestServiceTokenRef: "env:NOTIFICATION_DIGEST_TOKEN",
      notificationDigestIntervalMs: 60 * 60 * 1000,
      connectorHealthSweepServiceTokenRef: "env:CONNECTOR_HEALTH_SWEEP_TOKEN",
      connectorHealthSweepIntervalMs: 60 * 60 * 1000,
      adsCoreInternalBaseUrl: "http://ads-core.internal",
      retentionSweepServiceTokenRef: "env:RETENTION_SWEEP_TOKEN",
      retentionSweepIntervalMs: 24 * 60 * 60 * 1000,
      orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
      orchestrationRetentionSweepServiceTokenRef: "env:ORCHESTRATION_RETENTION_SWEEP_TOKEN",
      orchestrationRetentionSweepIntervalMs: 24 * 60 * 60 * 1000,
      evalFacadeServiceTokenRef: "env:EVAL_FACADE_SERVICE_TOKEN",
      benchmarkSweepIntervalMs: 24 * 60 * 60 * 1000,
      intelligenceServiceInternalBaseUrl: "http://intelligence-service.internal",
      memoryServiceInternalBaseUrl: "http://memory-service.internal",
      driftSweepServiceTokenRef: "env:DRIFT_SWEEP_SERVICE_TOKEN",
      driftSweepIntervalMs: 60 * 60 * 1000,
      driftSweepMinimumObservations: 40,
      auditServiceInternalBaseUrl: "http://audit-service.internal",
      auditChainVerifyServiceTokenRef: "env:AUDIT_CHAIN_VERIFY_SERVICE_TOKEN",
      auditChainVerifyIntervalMs: 15 * 60 * 1000,
      auditChainFullVerifyIntervalMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it("accepts a real custom interval", () => {
    expect(
      loadPlatformJobsEnvironment(
        environment({ NOTIFICATION_DIGEST_INTERVAL_MS: "5000" }),
      ).notificationDigestIntervalMs,
    ).toBe(5000);
  });

  it("throws PlatformJobsConfigurationError for a non-positive interval", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ NOTIFICATION_DIGEST_INTERVAL_MS: "0" })),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("throws PlatformJobsConfigurationError when a required field is missing", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ PLATFORM_API_INTERNAL_BASE_URL: "" })),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("accepts a real custom connector health sweep interval", () => {
    expect(
      loadPlatformJobsEnvironment(
        environment({ CONNECTOR_HEALTH_SWEEP_INTERVAL_MS: "5000" }),
      ).connectorHealthSweepIntervalMs,
    ).toBe(5000);
  });

  it("throws PlatformJobsConfigurationError when ADS_CORE_INTERNAL_BASE_URL is missing", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ ADS_CORE_INTERNAL_BASE_URL: "" })),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("accepts a real custom retention sweep interval", () => {
    expect(
      loadPlatformJobsEnvironment(
        environment({ RETENTION_SWEEP_INTERVAL_MS: "5000" }),
      ).retentionSweepIntervalMs,
    ).toBe(5000);
  });

  it("throws PlatformJobsConfigurationError when ORCHESTRATION_SERVICE_INTERNAL_BASE_URL is missing", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ ORCHESTRATION_SERVICE_INTERNAL_BASE_URL: "" })),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("throws PlatformJobsConfigurationError when ORCHESTRATION_RETENTION_SWEEP_SERVICE_TOKEN_REF is missing", () => {
    expect(() =>
      loadPlatformJobsEnvironment(
        environment({ ORCHESTRATION_RETENTION_SWEEP_SERVICE_TOKEN_REF: "" }),
      ),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("accepts a real custom orchestration retention sweep interval", () => {
    expect(
      loadPlatformJobsEnvironment(
        environment({ ORCHESTRATION_RETENTION_SWEEP_INTERVAL_MS: "5000" }),
      ).orchestrationRetentionSweepIntervalMs,
    ).toBe(5000);
  });

  it("accepts a real custom benchmark sweep interval", () => {
    expect(
      loadPlatformJobsEnvironment(
        environment({ BENCHMARK_SWEEP_INTERVAL_MS: "5000" }),
      ).benchmarkSweepIntervalMs,
    ).toBe(5000);
  });

  it("accepts a real custom drift sweep interval", () => {
    expect(
      loadPlatformJobsEnvironment(environment({ DRIFT_SWEEP_INTERVAL_MS: "5000" }))
        .driftSweepIntervalMs,
    ).toBe(5000);
  });

  it("rejects a non-integer drift candidate threshold", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ DRIFT_SWEEP_MINIMUM_OBSERVATIONS: "4.5" })),
    ).toThrow(PlatformJobsConfigurationError);
  });

  it("accepts a real custom audit chain verify interval", () => {
    expect(
      loadPlatformJobsEnvironment(environment({ AUDIT_CHAIN_VERIFY_INTERVAL_MS: "5000" }))
        .auditChainVerifyIntervalMs,
    ).toBe(5000);
  });

  it("accepts a real custom full audit chain verify interval", () => {
    expect(
      loadPlatformJobsEnvironment(environment({ AUDIT_CHAIN_FULL_VERIFY_INTERVAL_MS: "5000" }))
        .auditChainFullVerifyIntervalMs,
    ).toBe(5000);
  });

  it("throws PlatformJobsConfigurationError when AUDIT_SERVICE_INTERNAL_BASE_URL is missing", () => {
    expect(() =>
      loadPlatformJobsEnvironment(environment({ AUDIT_SERVICE_INTERNAL_BASE_URL: "" })),
    ).toThrow(PlatformJobsConfigurationError);
  });
});

describe("resolveRuntimeSecret", () => {
  it("resolves an env:-prefixed reference from process.env", async () => {
    process.env.NOTIFICATION_DIGEST_TOKEN = "real-token-value";
    await expect(resolveRuntimeSecret("env:NOTIFICATION_DIGEST_TOKEN")).resolves.toBe(
      "real-token-value",
    );
    delete process.env.NOTIFICATION_DIGEST_TOKEN;
  });

  it("throws when the referenced secret is unavailable", async () => {
    await expect(resolveRuntimeSecret("env:DOES_NOT_EXIST")).rejects.toThrow(
      /unavailable/,
    );
  });
});
