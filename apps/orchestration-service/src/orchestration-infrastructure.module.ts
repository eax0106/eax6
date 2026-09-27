import { Module } from "@nestjs/common";
import {
  PostgresOrchestrationStoreProvider,
  sharedOrchestrationPoolFactory,
} from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";
import { ORCHESTRATION_MIGRATIONS_PATH } from "./database/migrations-path";
import { RunOutcomeService } from "./runs/run-outcome.service";

export interface SessionGatewayEnvironment {
  readonly auth0Domain: string;
  readonly apiAudience: string;
  readonly actorTokenIssuer: string;
  readonly actorTokenAudience: string;
  readonly actorTokenJwksUrl: string;
  readonly redisUrl: string;
  readonly databaseAuthentication: "static" | "iam";
  readonly databaseConnectionString: string;
  readonly databaseHost: string;
  readonly databasePort: number;
  readonly databaseName: string;
  readonly databaseUser: string;
  readonly awsRegion: string;
  readonly artifactsBucketParameter: string;
  readonly selectionBindingFailClosedParameter: string;
  readonly auth0JwksUrl?: string;
}

/**
 * Composition-only infrastructure shared by the feature modules. Store
 * construction deliberately remains a factory: the legacy composition root
 * creates independent provider objects per feature while sharing the pool
 * factory beneath them.
 */
@Module({})
export class OrchestrationInfrastructureModule {}

export function orchestrationStore(
  env: SessionGatewayEnvironment,
  userOverride?: string,
): PostgresOrchestrationStoreProvider {
  return new PostgresOrchestrationStoreProvider(
    orchestrationStoreConfig(env, userOverride),
    { poolFactory: sharedOrchestrationPoolFactory },
  );
}

export function sessionGatewayEnvironment(
  env: NodeJS.ProcessEnv,
): SessionGatewayEnvironment {
  assertProductionSessionGatewayConfiguration(env);

  const base = {
    auth0Domain: requiredEnvironment(env, "AUTH0_DOMAIN"),
    apiAudience: requiredEnvironment(env, "AUTH0_API_AUDIENCE"),
    actorTokenIssuer: requiredEnvironment(env, "ACTOR_TOKEN_ISSUER"),
    actorTokenAudience: requiredEnvironment(env, "ACTOR_TOKEN_AUDIENCE"),
    actorTokenJwksUrl: requiredEnvironment(env, "ACTOR_TOKEN_JWKS_URL"),
    redisUrl: requiredEnvironment(env, "REDIS_ENDPOINT"),
    awsRegion: requiredEnvironment(env, "AWS_REGION"),
    artifactsBucketParameter: requiredEnvironment(env, "ALTER_ARTIFACTS_BUCKET_PARAM"),
    selectionBindingFailClosedParameter:
      env.SELECTION_BINDING_FAIL_CLOSED_PARAM ??
      "/alterx/orchestration-service/selection-binding-fail-closed",
    ...(env.AUTH0_JWKS_URL ? { auth0JwksUrl: env.AUTH0_JWKS_URL } : {}),
  };

  if (resolveDatabaseAuthentication(env) === "static") {
    return {
      ...base,
      databaseAuthentication: "static",
      databaseConnectionString: requiredEnvironment(env, "ORCHESTRATION_DATABASE_URL"),
      databaseHost: "",
      databasePort: 0,
      databaseName: "",
      databaseUser: "",
    };
  }

  return {
    ...base,
    databaseAuthentication: "iam",
    databaseConnectionString: "",
    databaseHost: requiredEnvironment(env, "ORCHESTRATION_DATABASE_HOST"),
    databasePort: requiredPort(env, "ORCHESTRATION_DATABASE_PORT"),
    databaseName: requiredEnvironment(env, "ORCHESTRATION_DATABASE_NAME"),
    databaseUser: requiredEnvironment(env, "ORCHESTRATION_DATABASE_USER"),
  };
}

/**
 * Which database authentication this deployment uses.
 *
 * IAM stays the default outside local, so an Aurora deployment keeps its
 * keyless connection. Managed Postgres with no AWS IAM (Neon) is reached with
 * a password from ORCHESTRATION_DATABASE_URL, which a deployment asks for by
 * setting ORCHESTRATION_DATABASE_AUTHENTICATION (or DATABASE_AUTHENTICATION)
 * to "static". The store then requires that URL to ask for TLS, because the
 * password travels with it -- see staticPoolConfig in @alterx/adapters.
 */
export function resolveDatabaseAuthentication(
  env: NodeJS.ProcessEnv,
): "static" | "iam" {
  const requested = (
    env.ORCHESTRATION_DATABASE_AUTHENTICATION ?? env.DATABASE_AUTHENTICATION
  )?.trim();
  if (requested !== undefined && requested !== "" && requested !== "static" && requested !== "iam") {
    throw new Error(
      "Invalid Session Gateway configuration: DATABASE_AUTHENTICATION must be static or iam",
    );
  }
  if (env.ALTER_ENV?.trim() === "local") {
    if (requested === "iam") {
      throw new Error(
        "Invalid Session Gateway configuration: DATABASE_AUTHENTICATION cannot be iam in the local environment",
      );
    }
    return "static";
  }
  return requested === "static" ? "static" : "iam";
}

export function internalM2mTokenProvider() {
  return lazyAuth0M2mTokenProviderFromEnvironment(process.env);
}

/**
 * HEAL-8: NodeexecService, RunLauncherService, and RunsController (via its
 * own RunOutcomeService provider) all need a RunOutcomeService -- the real
 * writer for the VACR/VADR metric ledger, and the reader behind
 * GET /runs/{id}/outcome. Each caller gets its own store instance, same
 * fresh-instance rule as orchestrationStore itself.
 */
export function buildRunOutcomeService(): RunOutcomeService {
  const dbConfig = sessionGatewayEnvironment(process.env);
  const store = orchestrationStore(dbConfig);
  return new RunOutcomeService(store);
}

function orchestrationStoreConfig(
  env: SessionGatewayEnvironment,
  userOverride?: string,
): import("@alterx/adapters").PostgresOrchestrationStoreConfig {
  if (env.databaseAuthentication === "static") {
    return {
      authentication: "static",
      connectionString: env.databaseConnectionString,
      migrationsFolder: ORCHESTRATION_MIGRATIONS_PATH,
    };
  }
  return {
    authentication: "iam",
    host: env.databaseHost,
    port: env.databasePort,
    database: env.databaseName,
    user: userOverride ?? env.databaseUser,
    region: env.awsRegion,
    migrationsFolder: ORCHESTRATION_MIGRATIONS_PATH,
  };
}

function assertProductionSessionGatewayConfiguration(
  env: NodeJS.ProcessEnv,
): void {
  if (env.NODE_ENV !== "production") return;
  if (env.INGRESS_SESSION_GATEWAY_CORE_ENABLED !== "true") {
    throw new Error(
      "Production Session Gateway requires feature flag ingress.sessionGatewayCore",
    );
  }
  if (env.ACTOR_TOKEN_TEST_SIGNER_ENABLED === "true") {
    throw new Error("Actor-token test signer cannot be enabled in production");
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Session Gateway configuration: ${name}`);
  }
  return value;
}

function requiredPort(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnvironment(env, name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `Invalid Session Gateway configuration: ${name} must be a port`,
    );
  }
  return value;
}
