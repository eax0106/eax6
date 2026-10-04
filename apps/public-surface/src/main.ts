import { resolve } from "node:path";
import { AwsSecretsManagerProvider, CloudflareTurnstileVerifier, EventBridgeEventPublisher, ModelGatewayClient,
  PostgresOrchestrationStoreProvider, RedisPublicFormRateLimiter, RedisPublicFormReceiptStore } from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment, PromptInjectionClassifier } from "@alterx/auth";
import { loadPublicSurfaceEnvironment } from "./config/environment";
import { PublicFormRepository } from "./public-form.repository";
import { PublicFormService } from "./public-form.service";
import { createPublicSurfaceServer } from "./server";

export function createProductionPublicSurface(config: ReturnType<typeof loadPublicSurfaceEnvironment>) {
  const store = new PostgresOrchestrationStoreProvider(config.database), repository = new PublicFormRepository(store);
  const page = new RedisPublicFormRateLimiter(config.redisUrl, "public-form:page", config.pageLimits);
  const submit = new RedisPublicFormRateLimiter(config.redisUrl, "public-form:submit", config.submitLimits);
  const receipts = new RedisPublicFormReceiptStore(config.redisUrl), secrets = new AwsSecretsManagerProvider({ region: config.region });
  const model = new ModelGatewayClient({ address: config.modelGatewayAddress, protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto"),
    accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment() });
  const publisher = new EventBridgeEventPublisher({ region: config.region, busName: config.busName,
    ...(config.eventBridgeEndpoint === undefined ? {} : { endpoint: config.eventBridgeEndpoint }) });
  const service = new PublicFormService(config.codec, repository, { page, submit },
    new CloudflareTurnstileVerifier(() => secrets.getSecret(config.turnstileSecretRef), config.hostname), new PromptInjectionClassifier(model), receipts, publisher, config.tokenKey);
  const ready = async () => { await repository.verifyRuntimeRole(); await receipts.probe(); };
  const app = createPublicSurfaceServer(service, config.siteKey, config.origin, ready, config.trustProxy);
  app.addHook("onClose", async () => { publisher.close(); await Promise.all([page.close(), submit.close(), receipts.close(), store.close()]); });
  return { app, ready };
}

async function bootstrap(): Promise<void> {
  const config = loadPublicSurfaceEnvironment(), runtime = createProductionPublicSurface(config);
  await runtime.ready();
  await runtime.app.listen({ host: "0.0.0.0", port: config.port });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void runtime.app.close().then(() => process.exit(0), () => process.exit(1)); });
}
if (require.main === module) void bootstrap().catch(() => { console.error("Public Surface failed to start"); process.exitCode = 1; });
