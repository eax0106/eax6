import "reflect-metadata";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AdsQueryClient,
  AuditServiceClient,
  MetaCloudApiWhatsappProvider,
  AwsAppConfigConfigProvider,
  AwsSecretsManagerProvider,
  BrowserbasePlaywrightProvider,
  MockBrowserAutomationProvider,
  PostgresToolDatabaseProvider,
  RedisCacheProvider,
  SqsQueueProvider,
  SsrfGuardedFetcher,
  TavilySearchProvider,
  resolveEmailProvider,
  startToolgwGrpcTransport,
  type BrowserAutomationProvider,
} from "@alterx/adapters";
import {
  createMockAuditEventHandler,
  createMockCacheProvider,
  createMockConfigProvider,
  createMockQueueProvider,
  createMockSearchProvider,
  createMockSecretsProvider,
  type AuditEventHandler,
  type CacheProvider,
  type ConfigProvider,
  type EmailProvider,
  type QueueProvider,
  type SearchProvider,
  type SecretsProvider,
} from "@alterx/shared-clients";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";

import { AppModule } from "./app.module";
import { loadToolGatewayEnvironment } from "./config/environment";
import { resolveConnectionCredential } from "./gateway/connection-credential-client";
import { ADSQ_CLIENT_PROTO_PATH } from "./gateway/grpc.constants";
import { adsKnowledgeSearch, connectedWhatsappSend, httpRunScopeResolver } from "./gateway/workspace-tools";
import {
  AUDIT_CLIENT_PROTO_PATH,
  TOOLGW_PROTO_PATH,
} from "./gateway/grpc.constants";

type ToolGatewayEnvironment = ReturnType<typeof loadToolGatewayEnvironment>;

function createConfigProvider(
  environment: ToolGatewayEnvironment,
): ConfigProvider {
  if (environment.runtimeMode === "mock") {
    return createMockConfigProvider();
  }
  return new AwsAppConfigConfigProvider({
    region: environment.region,
    applicationIdentifier: environment.appConfigApplicationId,
    environmentIdentifier: environment.appConfigEnvironmentId,
    configurationProfileIdentifier: environment.appConfigConfigurationProfileId,
  });
}

function createSecretsProvider(
  environment: ToolGatewayEnvironment,
): SecretsProvider {
  if (environment.runtimeMode === "mock") {
    return createMockSecretsProvider();
  }
  return new AwsSecretsManagerProvider({ region: environment.region });
}

async function createSearchProvider(
  environment: ToolGatewayEnvironment,
  secretsProvider: SecretsProvider,
): Promise<SearchProvider> {
  if (environment.runtimeMode === "mock") {
    return createMockSearchProvider();
  }
  const apiKey = await secretsProvider.getSecret(
    environment.tavilyApiKeySecretRef,
  );
  return new TavilySearchProvider({ apiKey });
}

function createAuditClient(
  environment: ToolGatewayEnvironment,
): AuditEventHandler {
  if (environment.runtimeMode === "mock") {
    return createMockAuditEventHandler();
  }
  return new AuditServiceClient({
    address: environment.auditServiceGrpcAddress,
    protoPath: AUDIT_CLIENT_PROTO_PATH,
    accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment(process.env),
  });
}

function createQueueProvider(environment: ToolGatewayEnvironment): QueueProvider {
  return environment.runtimeMode === "mock"
    ? createMockQueueProvider()
    : new SqsQueueProvider({
        region: environment.region,
        ...(process.env.AWS_ENDPOINT_URL
          ? { endpoint: process.env.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false }
          : {}),
      });
}

function createCacheProvider(environment: ToolGatewayEnvironment): CacheProvider {
  if (environment.runtimeMode === "mock") {
    return createMockCacheProvider();
  }
  return new RedisCacheProvider({
    host: environment.cacheRedisHost,
    port: environment.cacheRedisPort,
  });
}

// ENGINE-RESTRUCTURE-P4-1b: browser automation moved here from sandbox-
// service (createBrowserProvider, mirrored field-for-field -- same env
// var names BROWSERBASE_API_KEY_REF / BROWSERBASE_PROJECT_ID). The real
// Browserbase API key is one platform-wide secret resolved once at
// startup; per-call credential_refs for browser.* use the reserved
// browser-automation template and resolve no secret (see
// tool-gateway.service.ts).
async function createBrowserProvider(
  environment: ToolGatewayEnvironment,
  secretsProvider: SecretsProvider,
  urlFetcher: SsrfGuardedFetcher,
): Promise<BrowserAutomationProvider> {
  if (environment.runtimeMode === "mock") {
    return new MockBrowserAutomationProvider(urlFetcher);
  }
  return new BrowserbasePlaywrightProvider(
    {
      apiKey: await secretsProvider.getSecret(
        environment.browserbaseApiKeyReference,
      ),
      projectId: environment.browserbaseProjectId,
    },
    urlFetcher,
  );
}

// email.send: the real SES identity is one platform-wide secret, resolved
// once at startup, never per call -- same treatment as
// createBrowserProvider above. resolveEmailProvider() is the same shared
// function apps/platform-api/src/notifications/notification.module.ts
// uses, driven by the same EMAIL_PROVIDER/SES_FROM_ADDRESS/
// SES_CREDENTIALS_SECRET_REF/NODE_ENV environment variables in both
// services -- not gated behind this service's own
// RUNTIME_MODE=mock switch, so both services make the identical
// mock-vs-real decision from the identical configuration rather than
// tool-gateway inventing a second, parallel one.
function createEmailProvider(secretsProvider: SecretsProvider): EmailProvider {
  return resolveEmailProvider((reference) => secretsProvider.getSecret(reference));
}

// knowledge.search and whatsapp.send: the engine names the run's workspace;
// ADS answers from its documents, and its connected WhatsApp account sends
// with that account's own token reference.
function workspaceTools(environment: ToolGatewayEnvironment, secretsProvider: SecretsProvider) {
  const resolveScope = httpRunScopeResolver(environment.engineBaseUrl, environment.internalServiceToken);
  return {
    knowledgeSearch: adsKnowledgeSearch(resolveScope, new AdsQueryClient({
      address: environment.adsqGrpcTarget,
      protoPath: ADSQ_CLIENT_PROTO_PATH,
      authorization: `Bearer ${environment.internalServiceToken}`,
    })),
    whatsappSend: connectedWhatsappSend(resolveScope, new MetaCloudApiWhatsappProvider(secretsProvider)),
  };
}

async function bootstrap(): Promise<void> {
  const environment = loadToolGatewayEnvironment(process.env);
  const configProvider = createConfigProvider(environment);
  const secretsProvider = createSecretsProvider(environment);
  const searchProvider = await createSearchProvider(environment, secretsProvider);
  const urlFetcher = new SsrfGuardedFetcher();
  const auditClient = createAuditClient(environment);
  const databaseProvider = new PostgresToolDatabaseProvider(secretsProvider);
  const costQueue = createQueueProvider(environment);
  const cacheProvider = createCacheProvider(environment);
  const browserProvider = await createBrowserProvider(
    environment,
    secretsProvider,
    urlFetcher,
  );
  const emailProvider = createEmailProvider(secretsProvider);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(
      configProvider,
      secretsProvider,
      searchProvider,
      urlFetcher,
      auditClient,
      databaseProvider,
      costQueue,
      `alter-${environment.alterEnvironment}-cost-events`,
      cacheProvider,
      browserProvider,
      emailProvider,
      {
        resolveConnection: input => resolveConnectionCredential(environment.engineBaseUrl, environment.internalServiceToken, input),
        ...workspaceTools(environment, secretsProvider),
      },
    ),
    new FastifyAdapter(),
  );
  await startToolgwGrpcTransport(app, {
    bindAddress: environment.grpcBindAddress,
    protoPath: TOOLGW_PROTO_PATH,
  });
  app.enableShutdownHooks();
  await app.listen(environment.httpPort, "0.0.0.0");
}

void bootstrap();
