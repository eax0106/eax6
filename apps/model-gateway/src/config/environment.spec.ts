import { describe, expect, it } from "vitest";

import {
  ModelGatewayConfigurationError,
  loadModelGatewayEnvironment,
} from "./environment";

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged = {
    ALTER_ENV: "local",
    ALTER_SERVICE_NAME: "model-gateway",
    ALTER_REGION: "ap-south-1",
    RUNTIME_MODE: "mock",
    ALTER_CONFIG_SOURCE: "local-file",
    COST_LEDGER_GRPC_ADDRESS: "localhost:50060",
    ...overrides,
  };
  if (overrides.ALTER_CONFIG_SOURCE === "appconfig" && overrides.RUNTIME_MODE === undefined) {
    merged.RUNTIME_MODE = "real";
  }
  return merged;
}

describe("loadModelGatewayEnvironment", () => {
  it("validates and returns the documented local mock environment", () => {
    expect(loadModelGatewayEnvironment(environment())).toEqual({
      alterEnvironment: "local",
      serviceName: "model-gateway",
      region: "ap-south-1",
      runtimeMode: "mock",
      configSource: "local-file",
      embeddingProvider: "mock",
      httpPort: 3023,
      grpcBindAddress: "0.0.0.0:50051",
      costLedgerGrpcAddress: "localhost:50060",
    });
  });

  it("returns AppConfig and secret-reference binding fields for deployed environments", () => {
    expect(
      loadModelGatewayEnvironment(
        environment({
          ALTER_ENV: "prod",
          ALTER_CONFIG_SOURCE: "appconfig",
          APPCONFIG_APPLICATION_ID: "app-1",
          APPCONFIG_ENVIRONMENT_ID: "env-1",
          APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
          ANTHROPIC_API_KEY_SECRET_REF: "/alter/prod/model-gateway/system/anthropic_api_key",
          OPENAI_API_KEY_SECRET_REF: "/alter/prod/model-gateway/system/openai_api_key",
          PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "/alter/prod/model-gateway/platform-admin-token",
          PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
          PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
          CACHE_REDIS_HOST: "cache.model-gateway.local",
          CACHE_REDIS_PORT: "6379",
          AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
            "https://bedrock-runtime.ap-south-1.amazonaws.com",
        }),
      ),
    ).toMatchObject({
      configSource: "appconfig",
      appConfigApplicationId: "app-1",
      appConfigEnvironmentId: "env-1",
      appConfigConfigurationProfileId: "profile-1",
      anthropicApiKeySecretReference:
        "/alter/prod/model-gateway/system/anthropic_api_key",
      openaiApiKeySecretReference:
        "/alter/prod/model-gateway/system/openai_api_key",
      platformAdminServiceTokenSecretReference:
        "/alter/prod/model-gateway/platform-admin-token",
      providerControlParameterName:
        "/alter/prod/model-gateway/provider-controls",
      modelPolicyOverrideParameterName:
        "/alter/prod/model-gateway/model-policy",
      presidioAnalyzerUrl: "http://presidio-analyzer.local:5001",
      presidioAnonymizerUrl: "http://presidio-anonymizer.local:5002",
      cacheRedisHost: "cache.model-gateway.local",
      cacheRedisPort: 6379,
      bedrockRuntimeEndpoint: "https://bedrock-runtime.ap-south-1.amazonaws.com",
      costLedgerGrpcAddress: "localhost:50060",
    });
  });

  it("rejects the retired mock config source", () => {
    expect(() =>
      loadModelGatewayEnvironment(environment({ ALTER_CONFIG_SOURCE: "mock" })),
    ).toThrow(/must be one of appconfig, local-file/);
  });

  it("requires an explicit Bedrock endpoint when AWS has a global endpoint override", () => {
    const appConfig = {
      ALTER_ENV: "dev",
      ALTER_CONFIG_SOURCE: "appconfig",
      APPCONFIG_APPLICATION_ID: "app-1",
      APPCONFIG_ENVIRONMENT_ID: "env-1",
      APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
      ANTHROPIC_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/anthropic_api_key",
      OPENAI_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/openai_api_key",
      PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "/alter/dev/model-gateway/platform-admin-token",
      PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
      PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
      CACHE_REDIS_HOST: "cache.model-gateway.local",
      CACHE_REDIS_PORT: "6379",
      AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
    };
    expect(() => loadModelGatewayEnvironment(environment(appConfig))).toThrow(
      /AWS_ENDPOINT_URL_BEDROCK_RUNTIME/,
    );
    expect(
      loadModelGatewayEnvironment(
        environment({
          ...appConfig,
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
            "https://bedrock-runtime.ap-south-1.amazonaws.com",
        }),
      ),
    ).toMatchObject({
      bedrockRuntimeEndpoint: "https://bedrock-runtime.ap-south-1.amazonaws.com",
    });
  });

  it("allows Titan only as an explicit local embedding opt-in", () => {
    expect(
      loadModelGatewayEnvironment(
        environment({
          MODEL_GATEWAY_EMBEDDING_PROVIDER: "titan",
          AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
            "https://bedrock-runtime.ap-south-1.amazonaws.com",
        }),
      ),
    ).toMatchObject({
      configSource: "local-file",
      runtimeMode: "mock",
      embeddingProvider: "titan",
      bedrockRuntimeEndpoint: "https://bedrock-runtime.ap-south-1.amazonaws.com",
    });
    expect(() =>
      loadModelGatewayEnvironment(
        environment({ MODEL_GATEWAY_EMBEDDING_PROVIDER: "other" }),
      ),
    ).toThrow(/MODEL_GATEWAY_EMBEDDING_PROVIDER/);
  });

  it("starts on Bedrock alone when no failover provider is configured", () => {
    const loaded = loadModelGatewayEnvironment(
      environment({
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "app-1",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "secret",
        PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
        CACHE_REDIS_HOST: "cache.model-gateway.local",
        CACHE_REDIS_PORT: "6379",
        ANTHROPIC_API_KEY_SECRET_REF: "  ",
      }),
    );
    expect(loaded).toMatchObject({ runtimeMode: "real", configSource: "appconfig" });
    expect(loaded).not.toHaveProperty("anthropicApiKeySecretReference");
    expect(loaded).not.toHaveProperty("openaiApiKeySecretReference");
  });

  it("still requires the platform admin token reference, which is not a failover", () => {
    expect(() =>
      loadModelGatewayEnvironment(
        environment({
          ALTER_CONFIG_SOURCE: "appconfig",
          APPCONFIG_APPLICATION_ID: "app-1",
          APPCONFIG_ENVIRONMENT_ID: "env-1",
          APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
          PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
          PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
          CACHE_REDIS_HOST: "cache.model-gateway.local",
          CACHE_REDIS_PORT: "6379",
        }),
      ),
    ).toThrow(/PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF/);
  });

  it("ignores the local embedding-provider flag in AppConfig mode", () => {
    const appConfigInput = {
      ALTER_ENV: "dev",
      ALTER_CONFIG_SOURCE: "appconfig",
      MODEL_GATEWAY_EMBEDDING_PROVIDER: "mock",
      APPCONFIG_APPLICATION_ID: "app-1",
      APPCONFIG_ENVIRONMENT_ID: "env-1",
      APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
      ANTHROPIC_API_KEY_SECRET_REF: "secret",
      OPENAI_API_KEY_SECRET_REF: "secret",
      PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "secret",
      PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
      PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
      CACHE_REDIS_HOST: "cache.model-gateway.local",
      CACHE_REDIS_PORT: "6379",
    };
    const appConfig = loadModelGatewayEnvironment(
      environment(appConfigInput),
    );
    expect(appConfig).toMatchObject({ configSource: "appconfig" });
    expect(appConfig).not.toHaveProperty("embeddingProvider");
    expect(() =>
      loadModelGatewayEnvironment(
        environment({
          ...appConfigInput,
          MODEL_GATEWAY_EMBEDDING_PROVIDER: "other",
        }),
      ),
    ).toThrow(/MODEL_GATEWAY_EMBEDDING_PROVIDER/);
  });

  it("rejects mock runtime mode when NODE_ENV is production", () => {
    expect(() =>
      loadModelGatewayEnvironment(
        environment({ NODE_ENV: "production" }),
      ),
    ).toThrow(/mock is not allowed when NODE_ENV is production/);
  });

  it.each([undefined, "test", "development"])(
    "allows local mock config when NODE_ENV is %s",
    (nodeEnvironment) => {
      expect(
        loadModelGatewayEnvironment(
          environment({ NODE_ENV: nodeEnvironment }),
        ),
      ).toMatchObject({ configSource: "local-file", runtimeMode: "mock" });
    },
  );

  it("accepts validated custom bind ports", () => {
    expect(
      loadModelGatewayEnvironment(
        environment({ PORT: "3100", GRPC_BIND_ADDRESS: "127.0.0.1:51051", COST_LEDGER_GRPC_ADDRESS: "localhost:50061" }),
      ),
    ).toMatchObject({ httpPort: 3100, grpcBindAddress: "127.0.0.1:51051", costLedgerGrpcAddress: "localhost:50061" });
  });

  it.each([
    ["ALTER_ENV", { ALTER_ENV: "qa" }],
    ["ALTER_SERVICE_NAME", { ALTER_SERVICE_NAME: "model-gw" }],
    ["ALTER_REGION", { ALTER_REGION: "us-east-1" }],
    ["ALTER_CONFIG_SOURCE", { ALTER_CONFIG_SOURCE: "environment" }],
    ["PORT", { PORT: "0" }],
    ["GRPC_BIND_ADDRESS", { GRPC_BIND_ADDRESS: "localhost:50051" }],
    ["GRPC_BIND_ADDRESS", { GRPC_BIND_ADDRESS: "127.0.0.1:70000" }],
    [
      "APPCONFIG_APPLICATION_ID",
      {
        ALTER_ENV: "dev",
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
      },
    ],
    [
      "PRESIDIO_ANALYZER_URL",
      {
        ALTER_ENV: "dev",
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "app-1",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        ANTHROPIC_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/anthropic_api_key",
        OPENAI_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/openai_api_key",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
      },
    ],
    [
      "PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF",
      {
        ALTER_ENV: "dev",
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "app-1",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        ANTHROPIC_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/anthropic_api_key",
        OPENAI_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/openai_api_key",
        PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
        CACHE_REDIS_HOST: "cache.model-gateway.local",
        CACHE_REDIS_PORT: "6379",
        PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "",
      },
    ],
    [
      "CACHE_REDIS_HOST",
      {
        ALTER_ENV: "dev",
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "app-1",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        ANTHROPIC_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/anthropic_api_key",
        OPENAI_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/openai_api_key",
        PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
        CACHE_REDIS_HOST: "",
        CACHE_REDIS_PORT: "6379",
      },
    ],
    [
      "CACHE_REDIS_PORT",
      {
        ALTER_ENV: "dev",
        ALTER_CONFIG_SOURCE: "appconfig",
        APPCONFIG_APPLICATION_ID: "app-1",
        APPCONFIG_ENVIRONMENT_ID: "env-1",
        APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
        ANTHROPIC_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/anthropic_api_key",
        OPENAI_API_KEY_SECRET_REF: "/alter/dev/model-gateway/system/openai_api_key",
        PRESIDIO_ANALYZER_URL: "http://presidio-analyzer.local:5001",
        PRESIDIO_ANONYMIZER_URL: "http://presidio-anonymizer.local:5002",
        CACHE_REDIS_HOST: "cache.model-gateway.local",
        CACHE_REDIS_PORT: "0",
      },
    ],
  ])("rejects invalid %s", (field, override) => {
    expect(() => loadModelGatewayEnvironment(environment(override))).toThrow(
      ModelGatewayConfigurationError,
    );
    expect(() => loadModelGatewayEnvironment(environment(override))).toThrow(
      field,
    );
  });

  // One shared env file cannot hold two values for ALTER_CONFIG_SOURCE, and
  // this is the service that has to say "appconfig" while sandbox,
  // provisioning and tool-gateway are still on the local mocks.
  const appConfigOverrides = {
    ALTER_CONFIG_SOURCE: "appconfig",
    RUNTIME_MODE: "real",
    MODEL_GATEWAY_CONFIG_SOURCE: "appconfig",
    APPCONFIG_APPLICATION_ID: "app-1",
    APPCONFIG_ENVIRONMENT_ID: "env-1",
    APPCONFIG_CONFIGURATION_PROFILE_ID: "profile-1",
    ANTHROPIC_API_KEY_SECRET_REF: "/alter/local/model-gateway/anthropic-api-key",
    OPENAI_API_KEY_SECRET_REF: "/alter/local/model-gateway/openai-api-key",
    PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF: "/alter/local/model-gateway/platform-admin-token",
    PRESIDIO_ANALYZER_URL: "http://127.0.0.1:5001",
    PRESIDIO_ANONYMIZER_URL: "http://127.0.0.1:5002",
    CACHE_REDIS_HOST: "127.0.0.1",
    CACHE_REDIS_PORT: "6379",
  } as const;

  it("enables bounded smoke only in local real mode with SDK retries disabled", () => {
    expect(loadModelGatewayEnvironment(environment({ ...appConfigOverrides,
      MODEL_GATEWAY_LOCAL_SMOKE: "1", AWS_MAX_ATTEMPTS: "1",
      MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE: "/tmp/local-smoke-permit" }))).toHaveProperty("localSmokePermitFile", "/tmp/local-smoke-permit");
    for (const override of [{ ALTER_ENV: "prod" }, { AWS_MAX_ATTEMPTS: "3" },
      { MODEL_GATEWAY_LOCAL_SMOKE: "0" }, { RUNTIME_MODE: "mock" }]) {
      expect(() => loadModelGatewayEnvironment(environment({ ...appConfigOverrides,
        MODEL_GATEWAY_LOCAL_SMOKE: "1", AWS_MAX_ATTEMPTS: "1",
        MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE: "/tmp/local-smoke-permit", ...override }))).toThrow(/MODEL_GATEWAY_LOCAL_SMOKE/);
    }
    for (const path of [undefined, "relative-file"]) expect(() => loadModelGatewayEnvironment(environment({ ...appConfigOverrides,
      MODEL_GATEWAY_LOCAL_SMOKE: "1", AWS_MAX_ATTEMPTS: "1", MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE: path }))).toThrow(/MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE/);
  });

  it("ignores retired MODEL_GATEWAY_CONFIG_SOURCE overrides", () => {
    expect(
      loadModelGatewayEnvironment(
        environment({
          ALTER_CONFIG_SOURCE: "local-file",
          RUNTIME_MODE: "mock",
          MODEL_GATEWAY_CONFIG_SOURCE: "appconfig",
        }),
      ),
    ).toMatchObject({ configSource: "local-file", runtimeMode: "mock" });
  });

  it("still reads ALTER_CONFIG_SOURCE when the scoped name is absent", () => {
    expect(loadModelGatewayEnvironment(environment())).toMatchObject({
      configSource: "local-file",
      runtimeMode: "mock",
    });
  });

  // The parameter names are deliberately left unset in .env.local: they
  // default under /alter/<env>/, which is what an IAM policy scopes to, and
  // neither parameter has to exist before the service writes it.
  it("defaults both SSM parameter names under the /alter prefix", () => {
    expect(
      loadModelGatewayEnvironment(environment(appConfigOverrides)),
    ).toMatchObject({
      providerControlParameterName: "/alter/local/model-gateway/provider-controls",
      modelPolicyOverrideParameterName: "/alter/local/model-gateway/model-policy",
    });
  });
});
