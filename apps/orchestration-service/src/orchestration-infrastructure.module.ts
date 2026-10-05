import { Module } from "@nestjs/common";
import { EngineBillingAccountService } from "./billing/billing-account.service";
import { createMockConfigProvider } from "@alterx/shared-clients";
import {
  AwsAppConfigConfigProvider,
  CostClient,
  PostgresOrchestrationStoreProvider,
  sharedOrchestrationPoolFactory,
} from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";
import { ORCHESTRATION_MIGRATIONS_PATH } from "./database/migrations-path";
import { RunOutcomeService, type RunVerdictSink } from "./runs/run-outcome.service";
import { EngineBudgetService } from "./budgets/budget.service";
import { ConfigModelPolicy } from "./budgets/config-model-policy";
import { HttpRunCostReader } from "./budgets/http-run-cost-reader";
import { HttpRunEstimatesLedger } from "./budgets/http-run-estimates-ledger";
import { RunBudgetGate, type RunCostReader } from "./budgets/run-budget-gate";
import { RunEstimateService, type RunPreviewSource } from "./budgets/run-estimate.service";
import { WorstCaseRunCostEstimator, type ModelPolicyReader, type RunEstimatesLedger } from "./budgets/worst-case-run-cost-estimator";
import { COST_CLIENT_PROTO_PATH } from "./registry/nodeexec-grpc.constants";

export interface IdentityTenantGatewayEnvironment {
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
  env: IdentityTenantGatewayEnvironment,
  userOverride?: string,
): PostgresOrchestrationStoreProvider {
  return new PostgresOrchestrationStoreProvider(
    orchestrationStoreConfig(env, userOverride),
    { poolFactory: sharedOrchestrationPoolFactory },
  );
}

export function identityTenantGatewayEnvironment(
  env: NodeJS.ProcessEnv,
): IdentityTenantGatewayEnvironment {
  assertProductionIdentityTenantGatewayConfiguration(env);

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
 * keyless connection. A Postgres reached with a password -- a container on EC2,
 * or a provider with no AWS IAM -- takes its credential from
 * ORCHESTRATION_DATABASE_URL, and a deployment asks for it by setting
 * ORCHESTRATION_DATABASE_AUTHENTICATION (or DATABASE_AUTHENTICATION) to
 * "static". The store then requires that URL to ask for TLS, because the
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
      "Invalid Identity & Tenant Gateway configuration: DATABASE_AUTHENTICATION must be static or iam",
    );
  }
  if (env.ALTER_ENV?.trim() === "local") {
    if (requested === "iam") {
      throw new Error(
        "Invalid Identity & Tenant Gateway configuration: DATABASE_AUTHENTICATION cannot be iam in the local environment",
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
  const dbConfig = identityTenantGatewayEnvironment(process.env);
  const store = orchestrationStore(dbConfig);
  return new RunOutcomeService(store, runVerdictSink(process.env), buildRunBudgetGate(process.env), new EngineBillingAccountService(store));
}

/**
 * D3: budgets live in the Engine's own database; the run's real cost comes
 * from the Cost Ledger. A mock runtime has no ledger, so nothing is ever
 * billed and a run settles at zero.
 */
export function buildRunBudgetGate(environment: NodeJS.ProcessEnv): RunBudgetGate {
  const store = orchestrationStore(identityTenantGatewayEnvironment(environment));
  const baseUrl = environment.COST_LEDGER_BASE_URL?.trim();
  const reader: RunCostReader =
    (environment.RUNTIME_MODE?.trim() || "mock") === "real" && baseUrl
      ? new HttpRunCostReader(baseUrl, internalM2mTokenProvider())
      : { billableMinor: async () => 0 };
  return new RunBudgetGate(new EngineBudgetService(store), reader, buildWorstCaseEstimator(environment));
}

/**
 * D4: the worst-case bound a run reserves, and the figure shown before it
 * starts. The model policy comes from the same AppConfig profile the gateway
 * reads and prices come from the Cost Ledger. A mock runtime has neither, so
 * every bound is zero there, as every cost is.
 */
export function buildWorstCaseEstimator(environment: NodeJS.ProcessEnv): WorstCaseRunCostEstimator {
  return new WorstCaseRunCostEstimator(...runEstimationPorts(environment));
}

export function buildRunEstimateService(environment: NodeJS.ProcessEnv, source: RunPreviewSource): RunEstimateService {
  const store = orchestrationStore(identityTenantGatewayEnvironment(environment));
  const [, ledger] = runEstimationPorts(environment);
  return new RunEstimateService(store, source, buildWorstCaseEstimator(environment), ledger);
}

function runEstimationPorts(environment: NodeJS.ProcessEnv): [ModelPolicyReader, RunEstimatesLedger] {
  const baseUrl = environment.COST_LEDGER_BASE_URL?.trim();
  const applicationId = environment.APPCONFIG_APPLICATION_ID?.trim();
  const environmentId = environment.APPCONFIG_ENVIRONMENT_ID?.trim();
  const profileId = environment.APPCONFIG_CONFIGURATION_PROFILE_ID?.trim();
  if ((environment.RUNTIME_MODE?.trim() || "mock") === "real") {
    if (!baseUrl || !applicationId || !environmentId || !profileId) {
      throw new Error(
        "Pre-run cost estimates need COST_LEDGER_BASE_URL and the APPCONFIG_APPLICATION_ID, APPCONFIG_ENVIRONMENT_ID and APPCONFIG_CONFIGURATION_PROFILE_ID the model gateway reads",
      );
    }
    return [
      new ConfigModelPolicy(
        new AwsAppConfigConfigProvider({
          region: requiredEnvironment(environment, "AWS_REGION"),
          applicationIdentifier: applicationId,
          environmentIdentifier: environmentId,
          configurationProfileIdentifier: profileId,
        }),
      ),
      new HttpRunEstimatesLedger(baseUrl, internalM2mTokenProvider()),
    ];
  }
  return [
    new ConfigModelPolicy(createMockConfigProvider()),
    {
      worstCase: async ({ lines }) => ({ billableMinor: 0, unpricedLines: lines.length }),
      // A mock runtime has no ledger, so no run has any cost history.
      runsAverage: /* @constant */ async () => ({ averageBillableMinor: null, runCount: 0 }),
    },
  ];
}

/**
 * Design log §21: each run's verdict goes to the Cost Ledger. A mock runtime
 * has no ledger to reach; a real one uses the same address model-gateway's
 * cost client does.
 */
export function runVerdictSink(environment: NodeJS.ProcessEnv): RunVerdictSink | undefined {
  if ((environment.RUNTIME_MODE?.trim() || "mock") !== "real") return undefined;
  return new CostClient({
    address: environment.COST_LEDGER_GRPC_ADDRESS?.trim() || "127.0.0.1:50069",
    protoPath: COST_CLIENT_PROTO_PATH,
    accessTokenProvider: internalM2mTokenProvider(),
  });
}

function orchestrationStoreConfig(
  env: IdentityTenantGatewayEnvironment,
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

function assertProductionIdentityTenantGatewayConfiguration(
  env: NodeJS.ProcessEnv,
): void {
  if (env.NODE_ENV !== "production") return;
  if (env.INGRESS_SESSION_GATEWAY_CORE_ENABLED !== "true") {
    throw new Error(
      "Production Identity & Tenant Gateway requires the core ingress feature flag",
    );
  }
  if (env.ACTOR_TOKEN_TEST_SIGNER_ENABLED === "true") {
    throw new Error("Actor-token test signer cannot be enabled in production");
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Identity & Tenant Gateway configuration: ${name}`);
  }
  return value;
}

function requiredPort(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnvironment(env, name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `Invalid Identity & Tenant Gateway configuration: ${name} must be a port`,
    );
  }
  return value;
}
