import "reflect-metadata";
import { randomUUID } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AnthropicModelProvider,
  AwsAppConfigConfigProvider,
  AwsBedrockModelProvider,
  AwsSecretsManagerProvider,
  AwsSsmParameterProvider,
  FailoverModelProvider,
  OpenAiModelProvider,
  PresidioPIIRedactionProvider,
  RedisCacheProvider,
  SqsQueueProvider,
  TitanEmbeddingProvider,
  startModelgwGrpcTransport,
} from "@alterx/adapters";
import {
  createMockCacheProvider,
  createMockConfigProvider,
  createMockEmbeddingProvider,
  createMockMutableParameterStoreProvider,
  createMockModelProvider,
  createMockPIIRedactionProvider,
  createMockQueueProvider,
  type CacheProvider,
  type ConfigProvider,
  type EmbeddingProvider,
  type MutableParameterStoreProvider,
  type PIIRedactionProvider,
  type QueueProvider,
} from "@alterx/shared-clients";
import { CostClient } from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";

import { AppModule } from "./app.module";
import {
  loadModelGatewayEnvironment,
  type ModelGatewayAppConfigEnvironment,
} from "./config/environment";
import { MODELGW_PROTO_PATH } from "./gateway/grpc.constants";
import { resolve } from "node:path";
import { OperationalConfigProvider } from "./operations/operational-config-provider";
import { LocalSmokeBudget, LOCAL_SMOKE_CEILING_USD, localSmokePermitted } from "./gateway/local-smoke-budget";

function createConfigProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
  store: MutableParameterStoreProvider,
): OperationalConfigProvider {
  const baseline: ConfigProvider = environment.runtimeMode === "mock"
    ? createMockConfigProvider()
    : new AwsAppConfigConfigProvider({
        region: environment.region,
        applicationIdentifier: environment.appConfigApplicationId,
        environmentIdentifier: environment.appConfigEnvironmentId,
        configurationProfileIdentifier: environment.appConfigConfigurationProfileId,
      });
  return new OperationalConfigProvider(
    baseline,
    store,
    modelPolicyParameterName(environment),
  );
}

async function getSecretOrUndefined(
  secretsProvider: AwsSecretsManagerProvider,
  referenceId: string | undefined,
): Promise<string | undefined> {
  if (referenceId === undefined) return undefined;
  try {
    return await secretsProvider.getSecret(referenceId);
  } catch {
    return undefined;
  }
}

async function createModelProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
  store: MutableParameterStoreProvider,
): Promise<FailoverModelProvider> {
  if (environment.runtimeMode === "mock") {
    return new FailoverModelProvider(createMockModelProvider(), {}, {
      store,
      parameterName: providerControlParameterName(environment),
    });
  }

  const appConfigEnvironment: ModelGatewayAppConfigEnvironment = environment;
  if (environment.localSmokePermitFile) {
    return new FailoverModelProvider(new AwsBedrockModelProvider({ region: environment.region }), {}, {
      store, parameterName: providerControlParameterName(environment),
    });
  }
  const secretsProvider = new AwsSecretsManagerProvider({
    region: environment.region,
  });
  try {
    // Bedrock is the real primary and needs no secret (IAM/AWS creds only).
    // Anthropic/OpenAI are optional direct-API failovers whose keys are
    // deliberately not provisioned yet -- a missing failover secret must not
    // take down the whole service when the primary provider is fine.
    const [anthropicApiKey, openaiApiKey] = await Promise.all([
      getSecretOrUndefined(secretsProvider, appConfigEnvironment.anthropicApiKeySecretReference),
      getSecretOrUndefined(secretsProvider, appConfigEnvironment.openaiApiKeySecretReference),
    ]);

    const primary = new AwsBedrockModelProvider({ region: environment.region });
    const anthropic = anthropicApiKey ? new AnthropicModelProvider({ apiKey: anthropicApiKey }) : undefined;
    const openai = openaiApiKey ? new OpenAiModelProvider({ apiKey: openaiApiKey }) : undefined;

    return new FailoverModelProvider(
      primary,
      { ...(anthropic ? { anthropic } : {}), ...(openai ? { openai } : {}) },
      {
        store,
        parameterName: providerControlParameterName(environment),
      },
    );
  } finally {
    secretsProvider.close();
  }
}

function createParameterStore(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): MutableParameterStoreProvider {
  return environment.runtimeMode === "mock"
    ? createMockMutableParameterStoreProvider()
    : new AwsSsmParameterProvider({ region: environment.region });
}

async function resolveAdminServiceToken(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): Promise<string> {
  if (environment.runtimeMode === "mock") return randomUUID();
  const secrets = new AwsSecretsManagerProvider({ region: environment.region });
  try {
    return await secrets.getSecret(
      environment.platformAdminServiceTokenSecretReference,
    );
  } finally {
    secrets.close();
  }
}

function providerControlParameterName(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): string {
  return environment.runtimeMode === "mock"
    ? "/alter/local/model-gateway/provider-controls"
    : environment.providerControlParameterName;
}

function modelPolicyParameterName(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): string {
  return environment.runtimeMode === "mock"
    ? "/alter/local/model-gateway/model-policy"
    : environment.modelPolicyOverrideParameterName;
}

function createPIIRedactionProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): PIIRedactionProvider {
  if (environment.runtimeMode === "mock") {
    return createMockPIIRedactionProvider();
  }
  return new PresidioPIIRedactionProvider({
    analyzerBaseUrl: environment.presidioAnalyzerUrl,
    anonymizerBaseUrl: environment.presidioAnonymizerUrl,
  });
}

function createEmbeddingProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): EmbeddingProvider {
  if (
    environment.runtimeMode === "mock" &&
    environment.embeddingProvider === "mock"
  ) {
    return createMockEmbeddingProvider();
  }
  return new TitanEmbeddingProvider({
    region: environment.region,
    ...(environment.bedrockRuntimeEndpoint === undefined
      ? {}
      : { endpoint: environment.bedrockRuntimeEndpoint }),
  });
}

function embeddingProviderLogMessage(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): string {
  if (environment.runtimeMode === "real") return "Embedding provider: Titan";
  return environment.embeddingProvider === "titan"
    ? "Embedding provider: Titan (local opt-in)"
    : "Embedding provider: mock";
}

function createCacheProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): CacheProvider {
  if (environment.runtimeMode === "mock") {
    return createMockCacheProvider();
  }
  return new RedisCacheProvider({
    host: environment.cacheRedisHost,
    port: environment.cacheRedisPort,
  });
}

function createQueueProvider(
  environment: ReturnType<typeof loadModelGatewayEnvironment>,
): QueueProvider {
  if (environment.runtimeMode === "mock") {
    return createMockQueueProvider();
  }
  return new SqsQueueProvider({
    region: environment.region,
    ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false } : {}),
  });
}

async function bootstrap(): Promise<void> {
  const environment = loadModelGatewayEnvironment(process.env);
  let localSmokeBudget: LocalSmokeBudget | undefined;
  if (environment.localSmokePermitFile) {
    const permitFile = environment.localSmokePermitFile;
    localSmokeBudget = new LocalSmokeBudget((tenantId, runId) => localSmokePermitted(permitFile, tenantId, runId));
    console.info(`Local smoke lifetime ceiling: USD ${LOCAL_SMOKE_CEILING_USD}`);
  }
  const parameterStore = createParameterStore(environment);
  const configProvider = createConfigProvider(environment, parameterStore);
  const modelProvider = await createModelProvider(environment, parameterStore);
  await modelProvider.hydrateControls();
  const adminServiceToken = await resolveAdminServiceToken(environment);
  const piiRedactionProvider = createPIIRedactionProvider(environment);
  const embeddingProvider = createEmbeddingProvider(environment);
  console.info(embeddingProviderLogMessage(environment));
  const cacheProvider = createCacheProvider(environment);
  const queueProvider = createQueueProvider(environment);
  const costEventsQueueName = `alter-${environment.alterEnvironment}-cost-events`;

  const costClient = new CostClient({
    address: environment.costLedgerGrpcAddress,
    protoPath: resolve(process.cwd(), "packages/contracts/proto/alter/cost/v1/cost.proto"),
    // cost-ledger-service is behind the default-deny ServiceAuthGuard. With no
    // provider this client sent no credential, so every call was rejected
    // UNAUTHENTICATED: unit prices fell back to the flat constant, model
    // outcomes were never recorded, and a per-model price could never be read
    // (#168). All three are best-effort, so nothing surfaced it.
    // background-workers' CostClient already authenticates this way.
    accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment(process.env),
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(
      configProvider,
      modelProvider,
      piiRedactionProvider,
      embeddingProvider,
      cacheProvider,
      queueProvider,
      costEventsQueueName,
      adminServiceToken,
      costClient,
      localSmokeBudget,
    ),
    new FastifyAdapter(),
  );
  await startModelgwGrpcTransport(app, {
    bindAddress: environment.grpcBindAddress,
    protoPath: MODELGW_PROTO_PATH,
  });
  app.enableShutdownHooks();
  await app.listen(environment.httpPort, "0.0.0.0");
}

void bootstrap();
