import "reflect-metadata";
import { randomUUID } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AwsBedrockModelProvider,
  FailoverModelProvider,
  startModelgwGrpcTransport,
  type CostHandlerClient,
} from "@alterx/adapters";
import {
  createMockCacheProvider,
  createMockConfigProvider,
  createMockEmbeddingProvider,
  createMockMutableParameterStoreProvider,
  createMockPIIRedactionProvider,
  createMockQueueProvider,
  type ModelProvider,
} from "@alterx/shared-clients";
import type { ModelAliasPolicy } from "@alterx/contracts";

import { AppModule } from "./app.module";
import { loadModelGatewayEnvironment } from "./config/environment";
import { MODELGW_PROTO_PATH } from "./gateway/grpc.constants";
import { OperationalConfigProvider } from "./operations/operational-config-provider";
import { evalCacheProvider } from "./gateway/eval-cache";

/**
 * Real, disclosed eval-only entrypoint for Phase 1 (task 1.5) -- NOT
 * apps/model-gateway's production entrypoint (see main.ts for that) and
 * NOT a replacement for eval_bootstrap.ts. Additive only; no production
 * code path changes.
 *
 * Why a second eval bootstrap exists alongside eval_bootstrap.ts:
 *   eval_bootstrap.ts builds AnthropicModelProvider/OpenAiModelProvider
 *   from a plain ANTHROPIC_API_KEY/OPENAI_API_KEY env var. The Phase 1
 *   master prompt puts Anthropic OUT OF SCOPE by decision and names
 *   Bedrock (qwen.qwen3-32b-v1:0) as the provider -- Bedrock needs no
 *   secret (IAM/AWS creds only, per main.ts's own comment), and the
 *   measured Converse results in ap-south-1 (2026-09-09) confirmed qwen,
 *   deepseek.v3.2 and mistral-large-3 all hold the strict 9-key JSON
 *   contract at temperature 0. This script is the Bedrock analogue of
 *   eval_bootstrap.ts so the intent golden set can run against the real
 *   provider the prompt actually selected, without touching Anthropic.
 *
 * The alias policy is the Phase 1 binding: every tier resolves to
 * qwen.qwen3-32b-v1:0 (see infrastructure/model-alias-policy/phase-1-qwen-all-aliases.json,
 *   kept in sync with PHASE_1_QWEN_POLICY below). It is seeded into a mock
 *   mutable parameter store and read by OperationalConfigProvider with
 *   the SAME precedence the production SSM override parameter
 *   (MODEL_POLICY_OVERRIDE_PARAMETER_NAME) uses -- so this exercises
 *   the real override-read path, not a parallel one. fallback_chain is
 *   omitted (empty): FallbackProviderSchema is z.enum(["anthropic",
 *   "openai"]); Anthropic is out of scope and OpenAI-on-Bedrock returned no
 *   text, so the chain cannot express a working non-Anthropic provider
 *   today. See Track C20 -- the enum's shape is the open question.
 *
 * Requires real AWS credentials with bedrock:InvokeModel in ALTER_REGION
 * (ap-south-1). Throws synchronously if AWS_ENDPOINT_URL_BEDROCK_RUNTIME is
 * set alongside AWS_ENDPOINT_URL (the same fatal guard main.ts uses so
 * Bedrock never accidentally targets LocalStack). Never reads, logs, or
 * stores a credential.
 */

// Phase 1 alias policy: every tier on qwen.qwen3-32b-v1:0, no fallback chain.
// Source of truth: infrastructure/model-alias-policy/phase-1-qwen-all-aliases.json.
const PHASE_1_QWEN_POLICY: ModelAliasPolicy = {
  version: "phase-1-qwen-all-aliases",
  bindings: {
    FAST: { model_id: "qwen.qwen3-32b-v1:0", capability_tags: ["low-latency"] },
    STANDARD: { model_id: "qwen.qwen3-32b-v1:0", capability_tags: ["general"] },
    ADVANCED: { model_id: "qwen.qwen3-32b-v1:0", capability_tags: ["reasoning"] },
    CEILING: { model_id: "qwen.qwen3-32b-v1:0", capability_tags: ["frontier"] },
  },
};

const MODEL_POLICY_PARAMETER_NAME = "/alter/eval/model-policy";

function createEvalModelProvider(): ModelProvider {
  // Bedrock is the real primary and needs no secret (IAM/AWS creds only).
  // aws-sdk reads AWS credentials from the standard default chain; if none
  // is present the first Converse call throws for a real reason, never a
  // faked success.
  const region = process.env.ALTER_REGION ?? "ap-south-1";
  const endpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
  return new AwsBedrockModelProvider({
    region,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
}

async function bootstrap(): Promise<void> {
  const environment = loadModelGatewayEnvironment(process.env);
  if (environment.runtimeMode !== "mock") {
    throw new Error(
      "eval_bootstrap_bedrock only supports RUNTIME_MODE=mock -- use main.ts for a real " +
        "AWS AppConfig-backed deployment.",
    );
  }

  // Seed the Phase 1 alias policy into a mock mutable store, then hand it
  // to OperationalConfigProvider as the override store. resolveModelAlias
  // reads this with the same precedence it gives the real SSM override in
  // production -- so alias -> qwen resolution here is the real override
  // path, not a parallel one.
  const store = createMockMutableParameterStoreProvider({
    parameters: { [MODEL_POLICY_PARAMETER_NAME]: JSON.stringify(PHASE_1_QWEN_POLICY) },
  });
  const configProvider = new OperationalConfigProvider(
    // Baseline provides metadata/cost-limit/tool-permission and the
    // alias fallback; the override store (seeded with the qwen policy
    // below) wins for alias resolution, matching production's SSM-override
    // precedence.
    createMockConfigProvider({ policy: PHASE_1_QWEN_POLICY }),
    store,
    MODEL_POLICY_PARAMETER_NAME,
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
