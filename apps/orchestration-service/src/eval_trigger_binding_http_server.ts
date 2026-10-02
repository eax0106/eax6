import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Module, type DynamicModule } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import type { ActorContext, IdentityTenantGatewayRequest } from "@alterx/auth";

import {
  IntegrationWebhookController,
  PostgresTriggerBindingStore,
  TriggerBindingController,
  TriggerBindingService,
  WebhookEndpointController,
} from "./trigger-bindings";

/**
 * Real, disclosed eval-only entrypoint for ENG-BINDING -- NOT
 * orchestration-service's production main.ts. Two substitutions, both
 * deliberate and both narrow:
 *
 * 1. AUTH. Production applies SessionGatewayGuard globally, populating
 *    request.actorContext from a real signed JWT. No signing keys/JWKS are
 *    reachable here, so a real Fastify onRequest hook sets a synthetic
 *    ActorContext directly -- exactly what the real guard would produce after
 *    real validation. This substitutes only HOW a caller is authenticated.
 *
 * 2. SECRETS. AwsSecretsManagerProvider needs real AWS credentials, which do
 *    not exist in this environment, so createMockMutableSecretsProvider()
 *    backs SecretsProvider with an in-process map. It implements the same
 *    MutableSecretsProvider interface, and every put/get/delete the rotation
 *    path performs runs for real against it. Crucially this does NOT weaken
 *    the property under test: rotation still deletes the old material and
 *    still revokes the old row, so a request signed with the old secret still
 *    real-fails.
 *
 * Everything else is production code, unmodified: the real controllers, the
 * real TriggerBindingService, the real PostgresTriggerBindingStore against a
 * real migrated Postgres, real HMAC verification, real RLS.
 *
 * ROTATION MODEL UNDER TEST: hard cutover, overlapSeconds = 0. Every
 * rotate-secret response carries `rotationPolicy` stating this.
 */
function evalAuthActorContext(
  tenantId: string,
  workspaceId: string,
): ActorContext {
  return {
    actor_type: "service",
    user_id: null,
    tenant_id: tenantId,
    workspace_id: workspaceId,
    roles: ["eval-harness"],
    permissions: ["*"],
    session_id: null,
    jti: null,
  };
}

@Module({})
class EvalTriggerBindingModule {
  static register(service: TriggerBindingService): DynamicModule {
    return {
      module: EvalTriggerBindingModule,
      controllers: [
        TriggerBindingController,
        WebhookEndpointController,
        IntegrationWebhookController,
      ],
      providers: [{ provide: TriggerBindingService, useValue: service }],
    };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`eval_trigger_binding_http_server requires ${name}`);
  }
  return value;
}

async function bootstrap(): Promise<void> {
  const databaseUrl = required("EVAL_TRIGGER_BINDING_DB_URL");
  const tenantId = required("EVAL_TENANT_ID");
  const workspaceId = required("EVAL_WORKSPACE_ID");
  const httpPort = required("HTTP_PORT");
  const webhookBaseUrl =
    process.env.WEBHOOK_PUBLIC_BASE_URL ?? `http://127.0.0.1:${httpPort}`;

  const store = new PostgresOrchestrationStoreProvider({
    authentication: "static",
    connectionString: databaseUrl,
    migrationsFolder: `${__dirname}/drizzle`,
  });
  await store.migrate();

  const service = new TriggerBindingService(
    new PostgresTriggerBindingStore(store),
    createMockMutableSecretsProvider({ secrets: {} }),
    { webhookBaseUrl },
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    EvalTriggerBindingModule.register(service),
    // rawBody: true retains the exact pre-parse bytes on request.rawBody,
    // which HMAC verification requires -- same as production main.ts.
    new FastifyAdapter(),
    { rawBody: true },
  );
  const actorContext = evalAuthActorContext(tenantId, workspaceId);
  app.getHttpAdapter().getInstance().addHook(
    "onRequest",
    (request: IdentityTenantGatewayRequest, _reply: unknown, done: () => void) => {
      request.actorContext = actorContext;
      done();
    },
  );
  app.enableShutdownHooks();
  await app.listen(Number(httpPort), "127.0.0.1");
}

void bootstrap();
