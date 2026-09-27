import { createEnvironmentValidators } from "@alterx/adapters";

const ALTER_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;
const CONFIG_SOURCES = ["appconfig", "local-file"] as const;

interface AuditEnvironmentBase {
  readonly alterEnvironment: (typeof ALTER_ENVIRONMENTS)[number];
  readonly serviceName: "audit-service";
  readonly region: "ap-south-1";
  readonly configSource: (typeof CONFIG_SOURCES)[number];
  readonly auditArchiveBucketParameter: string;
  readonly httpPort: number;
  readonly grpcBindAddress: string;
  readonly adsDeletionBaseUrl: string;
  readonly orchestrationDeletionBaseUrl: string;
  readonly deletionPseudonymKeyReference: string;
  readonly deletionServiceTokenReference: string;
}

export interface AuditIamEnvironment extends AuditEnvironmentBase {
  readonly databaseAuthentication: "iam";
  readonly databaseHost: string;
  readonly databasePort: number;
  readonly databaseName: string;
  readonly databaseUser: string;
}

export interface AuditStaticEnvironment extends AuditEnvironmentBase {
  readonly databaseAuthentication: "static";
  readonly databaseSecretReference: string;
}

export type AuditEnvironment = AuditIamEnvironment | AuditStaticEnvironment;

export class AuditConfigurationError extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid audit-service environment field ${field}: ${reason}`);
    this.name = "AuditConfigurationError";
  }
}

const { requireValue, scopedValue, requireScopedValue, parsePort, parseRequiredPort, parseGrpcAddress } =
  createEnvironmentValidators((field, reason) => new AuditConfigurationError(field, reason));

// Distinct from every other service's default, so the whole stack can start
// with none of these set. The previous default collided with model-gateway,
// which owns 50051 (MODEL_GATEWAY_ADDRESS).
const DEFAULT_GRPC_BIND_ADDRESS = "0.0.0.0:50068";
const DEFAULT_HTTP_PORT = 3021;

export function loadAuditEnvironment(
  environment: NodeJS.ProcessEnv,
): AuditEnvironment {
  const alterEnvironment = requireValue(environment, "ALTER_ENV");
  if (!ALTER_ENVIRONMENTS.includes(alterEnvironment as AuditEnvironment["alterEnvironment"])) {
    throw new AuditConfigurationError(
      "ALTER_ENV",
      `must be one of ${ALTER_ENVIRONMENTS.join(", ")}`,
    );
  }
  if (
    alterEnvironment === "local" &&
    environment.NODE_ENV === "production"
  ) {
    throw new AuditConfigurationError(
      "ALTER_ENV",
      "local cannot select static database authentication when NODE_ENV is production",
    );
  }

  // Defaults to this service's own name: a shared env file can only carry
  // one value, and the service already knows which one it is. Still validated
  // when set, so a deployment naming the wrong service is still rejected.
  const serviceName = environment.ALTER_SERVICE_NAME?.trim() || "audit-service";
  if (serviceName !== "audit-service") {
    throw new AuditConfigurationError(
      "ALTER_SERVICE_NAME",
      "must equal audit-service",
    );
  }

  const region = requireValue(environment, "ALTER_REGION");
  if (region !== "ap-south-1") {
    throw new AuditConfigurationError(
      "ALTER_REGION",
      "must equal ap-south-1",
    );
  }

  // audit-service is the only service reading "local-file" here; the others
  // accept appconfig|mock, so one shared value cannot satisfy both.
  const configSource = requireScopedValue(environment, "AUDIT_CONFIG_SOURCE", "ALTER_CONFIG_SOURCE");
  if (!CONFIG_SOURCES.includes(configSource as AuditEnvironment["configSource"])) {
    throw new AuditConfigurationError(
      "ALTER_CONFIG_SOURCE",
      `must be one of ${CONFIG_SOURCES.join(", ")}`,
    );
  }

  const baseEnvironment: AuditEnvironmentBase = {
    alterEnvironment:
      alterEnvironment as AuditEnvironment["alterEnvironment"],
    serviceName,
    region,
    configSource: configSource as AuditEnvironment["configSource"],
    auditArchiveBucketParameter: requireValue(
      environment,
      "AUDIT_ARCHIVE_BUCKET_PARAM",
    ),
    httpPort: parsePort(scopedValue(environment, "AUDIT_PORT", "PORT"), "AUDIT_PORT", DEFAULT_HTTP_PORT),
    grpcBindAddress: parseGrpcAddress(
      scopedValue(environment, "AUDIT_GRPC_BIND_ADDRESS", "GRPC_BIND_ADDRESS"),
      "AUDIT_GRPC_BIND_ADDRESS",
      DEFAULT_GRPC_BIND_ADDRESS,
    ),
    adsDeletionBaseUrl: requireValue(environment, "ADS_DELETION_BASE_URL"),
    orchestrationDeletionBaseUrl: requireValue(environment, "ORCHESTRATION_DELETION_BASE_URL"),
    deletionPseudonymKeyReference: requireValue(environment, "DELETION_PSEUDONYM_KEY_REF"),
    deletionServiceTokenReference: requireValue(environment, "DELETION_SERVICE_TOKEN_REF"),
  };

  if (resolveDatabaseAuthentication(environment, alterEnvironment) === "static") {
    return {
      ...baseEnvironment,
      databaseAuthentication: "static",
      databaseSecretReference: requireScopedValue(environment, "AUDIT_DATABASE_SECRET_REF", "DATABASE_SECRET_REF"),
    };
  }

  return {
    ...baseEnvironment,
    databaseAuthentication: "iam",
    databaseHost: requireValue(environment, "DATABASE_HOST"),
    databasePort: parseRequiredPort(requireValue(environment, "DATABASE_PORT"), "DATABASE_PORT"),
    databaseName: requireValue(environment, "DATABASE_NAME"),
    databaseUser: requireValue(environment, "DATABASE_USER"),
  };
}

/**
 * Which database authentication a deployment uses.
 *
 * IAM stays the default outside local, so every existing Aurora deployment
 * keeps its keyless connection. A Postgres reached with a password instead --
 * a container on EC2, or a provider with no AWS IAM -- is asked for by setting
 * DATABASE_AUTHENTICATION=static -- never by inference, so an
 * environment that means to use IAM can never silently fall back to a
 * password. Local is static because that is the only mode it has.
 */
function resolveDatabaseAuthentication(
  environment: NodeJS.ProcessEnv,
  alterEnvironment: string,
): "static" | "iam" {
  const requested = scopedValue(
    environment,
    "AUDIT_DATABASE_AUTHENTICATION",
    "DATABASE_AUTHENTICATION",
  )?.trim();
  if (requested !== undefined && requested !== "" && requested !== "static" && requested !== "iam") {
    throw new AuditConfigurationError(
      "DATABASE_AUTHENTICATION",
      "must be static or iam",
    );
  }
  if (alterEnvironment === "local") {
    if (requested === "iam") {
      throw new AuditConfigurationError(
        "DATABASE_AUTHENTICATION",
        "cannot be iam in the local environment",
      );
    }
    return "static";
  }
  return requested === "static" ? "static" : "iam";
}
