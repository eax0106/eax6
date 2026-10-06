import { createEnvironmentValidators } from "@alterx/adapters";
import { isAbsolute } from "node:path";

const ALTER_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;

interface ModelGatewayEnvironmentBase {
  readonly alterEnvironment: (typeof ALTER_ENVIRONMENTS)[number];
  readonly serviceName: "model-gateway";
  readonly region: "ap-south-1";
  readonly runtimeMode: "real" | "mock";
  readonly httpPort: number;
  readonly grpcBindAddress: string;
  readonly costLedgerGrpcAddress: string;
  readonly localSmokePermitFile?: string;
}

export interface ModelGatewayAppConfigEnvironment
  extends ModelGatewayEnvironmentBase {
  readonly runtimeMode: "real";
  readonly configSource: "appconfig";
  readonly appConfigApplicationId: string;
  readonly appConfigEnvironmentId: string;
  readonly appConfigConfigurationProfileId: string;
  /** Optional direct-API failovers; Bedrock is the primary and needs no key. */
  readonly anthropicApiKeySecretReference?: string;
  readonly openaiApiKeySecretReference?: string;
  readonly presidioAnalyzerUrl: string;
  readonly presidioAnonymizerUrl: string;
  readonly cacheRedisHost: string;
  readonly cacheRedisPort: number;
  readonly platformAdminServiceTokenSecretReference: string;
  readonly providerControlParameterName: string;
  readonly modelPolicyOverrideParameterName: string;
  readonly bedrockRuntimeEndpoint?: string;
}

export interface ModelGatewayMockEnvironment
  extends ModelGatewayEnvironmentBase {
  readonly runtimeMode: "mock";
  readonly configSource: "appconfig" | "local-file";
  readonly embeddingProvider: "mock" | "titan";
  readonly bedrockRuntimeEndpoint?: string;
}

export type ModelGatewayEnvironment =
  | ModelGatewayAppConfigEnvironment
  | ModelGatewayMockEnvironment;

export class ModelGatewayConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid model-gateway environment field ${field}: ${reason}`);
    this.name = "ModelGatewayConfigurationError";
  }
}

const { requireValue, scopedValue, parsePort, parseRequiredPort, parseGrpcAddress, runtimeMode, configSource: readConfigSource } =
  createEnvironmentValidators((field, reason) => new ModelGatewayConfigurationError(field, reason));

/**
 * Non-empty-with-default, no address-format validation -- unlike
 * GRPC_BIND_ADDRESS (this process's own bind target, always a raw IPv4:port),
 * a cross-service target address is real-world commonly a hostname (k8s
 * service DNS, docker-compose service name), matching the base test fixture's
 * own pre-existing "localhost:50060" value. Defaults rather than throws when
 * absent because the real pricing lookup this feeds is fail-open by design
 * (ENGINE-FIX-16) -- an unreachable default degrades to the historical-
 * average fallback, it never breaks boot.
 */
function optionalAddress(value: string | undefined, defaultAddress: string): string {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : defaultAddress;
}

/**
 * A failover provider's secret reference, present only when configured. An
 * unset reference means "no such failover", so the environment must not
 * invent a name for a secret that does not exist.
 */
function optionalReference<K extends string>(
  environment: NodeJS.ProcessEnv,
  field: string,
  key: K,
): Partial<Record<K, string>> {
  const value = environment[field]?.trim();
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

export function loadModelGatewayEnvironment(
  environment: NodeJS.ProcessEnv,
): ModelGatewayEnvironment {
  const alterEnvironment = requireValue(environment, "ALTER_ENV");
  if (
    !ALTER_ENVIRONMENTS.includes(
      alterEnvironment as ModelGatewayEnvironment["alterEnvironment"],
    )
  ) {
    throw new ModelGatewayConfigurationError(
      "ALTER_ENV",
      `must be one of ${ALTER_ENVIRONMENTS.join(", ")}`,
    );
  }

  // Defaults to this service's own name: a shared env file can only carry
  // one value, and the service already knows which one it is. Still validated
  // when set, so a deployment naming the wrong service is still rejected.
  const serviceName = environment.ALTER_SERVICE_NAME?.trim() || "model-gateway";
  if (serviceName !== "model-gateway") {
    throw new ModelGatewayConfigurationError(
      "ALTER_SERVICE_NAME",
      "must equal model-gateway",
    );
  }

  const region = requireValue(environment, "ALTER_REGION");
  if (region !== "ap-south-1") {
    throw new ModelGatewayConfigurationError(
      "ALTER_REGION",
      "must equal ap-south-1",
    );
  }

  // Scoped first, for the same reason audit-service reads AUDIT_CONFIG_SOURCE:
  // one shared env file cannot hold two values, and this is the service that
  // needs "appconfig" while sandbox, provisioning and tool-gateway are still
  // running against the local mocks.
  const mode = runtimeMode(environment);
  const configSource = readConfigSource(environment);
  const localSmoke = environment.MODEL_GATEWAY_LOCAL_SMOKE;
  if (localSmoke !== undefined && (localSmoke !== "1" || alterEnvironment !== "local"
    || mode !== "real" || environment.AWS_MAX_ATTEMPTS !== "1")) {
    throw new ModelGatewayConfigurationError("MODEL_GATEWAY_LOCAL_SMOKE",
      "requires local real runtime and AWS_MAX_ATTEMPTS=1");
  }
  const permitFile = localSmoke === "1" ? requireValue(environment, "MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE") : undefined;
  if (permitFile && !isAbsolute(permitFile)) {
    throw new ModelGatewayConfigurationError("MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE", "must be an absolute local path");
  }
  if (mode === "real" && configSource !== "appconfig") {
    throw new ModelGatewayConfigurationError(
      "ALTER_CONFIG_SOURCE",
      "RUNTIME_MODE=real requires ALTER_CONFIG_SOURCE=appconfig",
    );
  }

  const configuredEmbeddingProvider =
    environment.MODEL_GATEWAY_EMBEDDING_PROVIDER?.trim() || "mock";
  if (
    configuredEmbeddingProvider !== "mock" &&
    configuredEmbeddingProvider !== "titan"
  ) {
    throw new ModelGatewayConfigurationError(
      "MODEL_GATEWAY_EMBEDDING_PROVIDER",
      "must be one of mock, titan",
    );
  }
  const embeddingProvider: "mock" | "titan" =
    configuredEmbeddingProvider === "titan" ? "titan" : "mock";
  const usesTitan = configSource === "appconfig" || embeddingProvider === "titan";
  const bedrockRuntimeEndpoint = environment.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim();
  if (usesTitan && environment.AWS_ENDPOINT_URL?.trim() && !bedrockRuntimeEndpoint) {
    throw new ModelGatewayConfigurationError(
      "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
      "is required when AWS_ENDPOINT_URL is set so Bedrock does not use that endpoint",
    );
  }
  if (bedrockRuntimeEndpoint) {
    try {
      new URL(bedrockRuntimeEndpoint);
    } catch {
      throw new ModelGatewayConfigurationError(
        "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
        "must be an absolute URL",
      );
    }
  }

  const baseEnvironment: ModelGatewayEnvironmentBase = {
    ...(permitFile ? { localSmokePermitFile: permitFile } : {}),
    alterEnvironment:
      alterEnvironment as ModelGatewayEnvironment["alterEnvironment"],
    serviceName,
    region,
    runtimeMode: mode,
    httpPort: parsePort(scopedValue(environment, "MODEL_GATEWAY_PORT", "PORT"), "MODEL_GATEWAY_PORT", 3023),
    grpcBindAddress: parseGrpcAddress(
      scopedValue(environment, "MODEL_GATEWAY_GRPC_BIND_ADDRESS", "GRPC_BIND_ADDRESS"),
      "MODEL_GATEWAY_GRPC_BIND_ADDRESS",
      "0.0.0.0:50051",
    ),
    // Matches cost-ledger-service's own bind default. The two disagreed
    // before -- this client assumed 50065 while the service bound 50060 --
    // and both of those belong to other services (blackboard and
    // memory-service). Real deployments override via
    // COST_LEDGER_GRPC_ADDRESS.
    costLedgerGrpcAddress: optionalAddress(
      environment.COST_LEDGER_GRPC_ADDRESS,
      "127.0.0.1:50069",
    ),
  };

  if (mode === "mock") {
    return {
      ...baseEnvironment,
      runtimeMode: "mock",
      configSource,
      embeddingProvider,
      ...(bedrockRuntimeEndpoint === undefined
        ? {}
        : { bedrockRuntimeEndpoint }),
    };
  }

  return {
    ...baseEnvironment,
    runtimeMode: "real",
    configSource: "appconfig",
    appConfigApplicationId: requireValue(
      environment,
      "APPCONFIG_APPLICATION_ID",
    ),
    appConfigEnvironmentId: requireValue(
      environment,
      "APPCONFIG_ENVIRONMENT_ID",
    ),
    appConfigConfigurationProfileId: requireValue(
      environment,
      "APPCONFIG_CONFIGURATION_PROFILE_ID",
    ),
    ...optionalReference(environment, "ANTHROPIC_API_KEY_SECRET_REF", "anthropicApiKeySecretReference"),
    ...optionalReference(environment, "OPENAI_API_KEY_SECRET_REF", "openaiApiKeySecretReference"),
    presidioAnalyzerUrl: requireValue(environment, "PRESIDIO_ANALYZER_URL"),
    presidioAnonymizerUrl: requireValue(
      environment,
      "PRESIDIO_ANONYMIZER_URL",
    ),
    cacheRedisHost: requireValue(environment, "CACHE_REDIS_HOST"),
    cacheRedisPort: parseRequiredPort(
      requireValue(environment, "CACHE_REDIS_PORT"),
      "CACHE_REDIS_PORT",
    ),
    platformAdminServiceTokenSecretReference: requireValue(
      environment,
      "PLATFORM_ADMIN_SERVICE_TOKEN_SECRET_REF",
    ),
    providerControlParameterName:
      environment.PROVIDER_CONTROL_PARAMETER_NAME?.trim() ||
      `/alter/${alterEnvironment}/model-gateway/provider-controls`,
    modelPolicyOverrideParameterName:
      environment.MODEL_POLICY_OVERRIDE_PARAMETER_NAME?.trim() ||
      `/alter/${alterEnvironment}/model-gateway/model-policy`,
    ...(bedrockRuntimeEndpoint === undefined
      ? {}
      : { bedrockRuntimeEndpoint }),
  };
}
