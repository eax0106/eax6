import { createEnvironmentValidators } from "@alterx/adapters";

const ALTER_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;

interface ToolGatewayEnvironmentBase {
  readonly alterEnvironment: (typeof ALTER_ENVIRONMENTS)[number];
  readonly serviceName: "tool-gateway";
  readonly region: "ap-south-1";
  readonly runtimeMode: "real" | "mock";
  readonly httpPort: number;
  readonly grpcBindAddress: string;
  readonly engineBaseUrl: string;
  readonly internalServiceToken: string;
  /** ADS Q gRPC, for knowledge.search. */
  readonly adsqGrpcTarget: string;
}

export interface ToolGatewayAppConfigEnvironment
  extends ToolGatewayEnvironmentBase {
  readonly runtimeMode: "real";
  readonly configSource: "appconfig";
  readonly appConfigApplicationId: string;
  readonly appConfigEnvironmentId: string;
  readonly appConfigConfigurationProfileId: string;
  readonly tavilyApiKeySecretRef: string;
  readonly auditServiceGrpcAddress: string;
  readonly cacheRedisHost: string;
  readonly cacheRedisPort: number;
  // ENGINE-RESTRUCTURE-P4-1b: same fields/env vars sandbox-service's
  // createBrowserProvider consumed before the browser tools moved here.
  readonly browserbaseApiKeyReference: string;
  readonly browserbaseProjectId: string;
}

export interface ToolGatewayMockEnvironment
  extends ToolGatewayEnvironmentBase {
  readonly runtimeMode: "mock";
  readonly configSource: "appconfig" | "local-file";
}

export type ToolGatewayEnvironment =
  | ToolGatewayAppConfigEnvironment
  | ToolGatewayMockEnvironment;

export class ToolGatewayConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid tool-gateway environment field ${field}: ${reason}`);
    this.name = "ToolGatewayConfigurationError";
  }
}

const { requireValue, scopedValue, parsePort, parseRequiredPort, parseGrpcAddress, runtimeMode, configSource: readConfigSource } =
  createEnvironmentValidators((field, reason) => new ToolGatewayConfigurationError(field, reason));

export function loadToolGatewayEnvironment(
  environment: NodeJS.ProcessEnv,
): ToolGatewayEnvironment {
  const alterEnvironment = requireValue(environment, "ALTER_ENV");
  if (
    !ALTER_ENVIRONMENTS.includes(
      alterEnvironment as ToolGatewayEnvironment["alterEnvironment"],
    )
  ) {
    throw new ToolGatewayConfigurationError(
      "ALTER_ENV",
      `must be one of ${ALTER_ENVIRONMENTS.join(", ")}`,
    );
  }

  // Defaults to this service's own name: a shared env file can only carry
  // one value, and the service already knows which one it is. Still validated
  // when set, so a deployment naming the wrong service is still rejected.
  const serviceName = environment.ALTER_SERVICE_NAME?.trim() || "tool-gateway";
  if (serviceName !== "tool-gateway") {
    throw new ToolGatewayConfigurationError(
      "ALTER_SERVICE_NAME",
      "must equal tool-gateway",
    );
  }

  const region = requireValue(environment, "ALTER_REGION");
  if (region !== "ap-south-1") {
    throw new ToolGatewayConfigurationError(
      "ALTER_REGION",
      "must equal ap-south-1",
    );
  }

  const mode = runtimeMode(environment);
  const configSource = readConfigSource(environment);
  if (mode === "real" && configSource !== "appconfig") {
    throw new ToolGatewayConfigurationError(
      "ALTER_CONFIG_SOURCE",
      "RUNTIME_MODE=real requires ALTER_CONFIG_SOURCE=appconfig",
    );
  }

  let engineUrl: URL;
  try { engineUrl = new URL(requireValue(environment, "ENGINE_BASE_URL")); }
  catch { throw new ToolGatewayConfigurationError("ENGINE_BASE_URL", "an HTTP service URL is required"); }
  if (!["http:", "https:"].includes(engineUrl.protocol) || engineUrl.username || engineUrl.password || engineUrl.search || engineUrl.hash || engineUrl.pathname !== "/") throw new ToolGatewayConfigurationError("ENGINE_BASE_URL", "an HTTP service origin is required");
  const baseEnvironment: ToolGatewayEnvironmentBase = {
    engineBaseUrl: engineUrl.origin,
    internalServiceToken: requireValue(environment, "INTERNAL_SERVICE_TOKEN"),
    adsqGrpcTarget: parseGrpcAddress(environment["ADSQ_GRPC_TARGET"], "ADSQ_GRPC_TARGET", "127.0.0.1:50050"),
    alterEnvironment:
      alterEnvironment as ToolGatewayEnvironment["alterEnvironment"],
    serviceName,
    region,
    runtimeMode: mode,
    httpPort: parsePort(scopedValue(environment, "TOOL_GATEWAY_PORT", "PORT"), "TOOL_GATEWAY_PORT", 3024),
    // 50053 is the address every consumer is configured to reach
    // (TOOL_GATEWAY_ADDRESS); the previous default of 50052 was the
    // Conversation Manager's port.
    grpcBindAddress: parseGrpcAddress(
      scopedValue(environment, "TOOL_GATEWAY_GRPC_BIND_ADDRESS", "GRPC_BIND_ADDRESS"),
      "TOOL_GATEWAY_GRPC_BIND_ADDRESS",
      "0.0.0.0:50053",
    ),
  };

  if (mode === "mock") {
    return { ...baseEnvironment, runtimeMode: "mock", configSource };
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
    tavilyApiKeySecretRef: requireValue(environment, "TAVILY_API_KEY_SECRET_REF"),
    auditServiceGrpcAddress: requireValue(
      environment,
      "AUDIT_SERVICE_GRPC_ADDRESS",
    ),
    cacheRedisHost: requireValue(environment, "CACHE_REDIS_HOST"),
    cacheRedisPort: parseRequiredPort(
      requireValue(environment, "CACHE_REDIS_PORT"),
      "CACHE_REDIS_PORT",
    ),
    browserbaseApiKeyReference: requireValue(
      environment,
      "BROWSERBASE_API_KEY_REF",
    ),
    browserbaseProjectId: requireValue(environment, "BROWSERBASE_PROJECT_ID"),
  };
}
