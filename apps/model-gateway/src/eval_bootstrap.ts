import "reflect-metadata";
import { randomUUID } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AnthropicModelProvider,
  FailoverModelProvider,
  OpenAiModelProvider,
  startModelgwGrpcTransport,
  type CostHandlerClient,
} from "@alterx/adapters";
import {
  createMockCacheProvider,
  createMockConfigProvider,
  createMockEmbeddingProvider,
  createMockPIIRedactionProvider,
  createMockQueueProvider,
  type ModelProvider,
} from "@alterx/shared-clients";

import { AppModule } from "./app.module";
import { loadModelGatewayEnvironment } from "./config/environment";
import { MODELGW_PROTO_PATH } from "./gateway/grpc.constants";
import { OperationalConfigProvider } from "./operations/operational-config-provider";
import { evalCacheProvider } from "./gateway/eval-cache";

/**
 * Real, disclosed eval-only entrypoint -- NOT apps/model-gateway's
 * production entrypoint (see main.ts for that). Every provider except the
 * model provider is the same real mock this service's own sanctioned
 * `RUNTIME_MODE=mock` / `ALTER_ENV=local` combination already uses
 * (see config/environment.ts's own validation: mock is only permitted
 * when ALTER_ENV=local and NODE_ENV!=production -- this script reuses
 * that exact real gate via loadModelGatewayEnvironment, not a parallel
 * one).
 *
 * The model provider is the one real thing here: a genuine
 * AnthropicModelProvider or OpenAiModelProvider built directly from a
 * plain ANTHROPIC_API_KEY / OPENAI_API_KEY env var, bypassing the
 * production AwsSecretsManagerProvider fetch (main.ts's createModelProvider)
 * because no AWS Secrets Manager access exists in this environment. This
 * is a real key making real model calls -- the shortcut is around where
 * the key comes from, never around whether the call is real.
 *
 * Never touches main.ts or createModelProvider() -- purely additive, no
 * production code path changes. Set ANTHROPIC_API_KEY or OPENAI_API_KEY
 * yourself before running; this script never reads, logs, or stores the
 * key value beyond passing it straight into the real provider constructor.
 */
function createEvalModelProvider(): ModelProvider {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicApiKey !== undefined && anthropicApiKey.length > 0) {
    return new AnthropicModelProvider({ apiKey: anthropicApiKey });
  }
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (openaiApiKey !== undefined && openaiApiKey.length > 0) {
    return new OpenAiModelProvider({ apiKey: openaiApiKey });
  }
  throw new Error(
    "eval_bootstrap requires a real ANTHROPIC_API_KEY or OPENAI_API_KEY env var -- " +
      "set one yourself before running, this script never supplies or fabricates one.",
  );
}

async function bootstrap(): Promise<void> {
  const environment = loadModelGatewayEnvironment(process.env);
  if (environment.runtimeMode !== "mock") {
    throw new Error(
      "eval_bootstrap only supports RUNTIME_MODE=mock -- use main.ts for a real " +
        "AWS AppConfig-backed deployment.",
    );
  }

  const configProvider = new OperationalConfigProvider(
    createMockConfigProvider(),
    undefined,
    "/alter/eval/model-policy",
  );
  const modelProvider = new FailoverModelProvider(createEvalModelProvider(), {});
  const piiRedactionProvider = createMockPIIRedactionProvider();
  const embeddingProvider = createMockEmbeddingProvider();
  const cacheProvider = evalCacheProvider(createMockCacheProvider());
  const queueProvider = createMockQueueProvider();
  const costEventsQueueName = "alter-eval-cost-events";
  const costClient: CostHandlerClient = {
    ingestCostEvent: async () => ({ accepted: true }),
    resolveUnitPrice: async () => ({
      unit_cost_minor: "10",
      currency: "INR",
      confidence: "fixed_table",
    }),
    recordModelOutcome: async () => ({ accepted: true }),
  };

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(
      configProvider,
      modelProvider,
      piiRedactionProvider,
      embeddingProvider,
      cacheProvider,
      queueProvider,
      costEventsQueueName,
      randomUUID(),
      costClient,
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
