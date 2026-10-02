import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Module, type DynamicModule } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import type { ActorContext, IdentityTenantGatewayRequest } from "@alterx/auth";

import {
  PostgresTriggerBindingStore,
  TriggerBindingService,
} from "./trigger-bindings";
import { TriggerRegistryController } from "./trigger-registry/trigger-registry.controller";
import { TriggerRegistryService } from "./trigger-registry/trigger-registry.service";

/**
 * Real, disclosed eval-only entrypoint for HARD-7j (`workflow` golden-set
 * domain's `register_trigger` operation) -- NOT orchestration-service's
 * production main.ts. TriggerRegistryController is real and unmodified;
 * TriggerRegistryService is real, constructed directly with a real
 * Postgres store, same "one real service" pattern the other eval-only
 * entrypoints in this campaign already use.
 *
 * Production main.ts applies SessionGatewayGuard globally (APP_GUARD),
 * which populates `request.actorContext` from a real, signed JWT --
 * that guard is not wired here (no real signing keys/JWKS reachable in
 * this environment). Instead, a real Fastify onRequest hook sets a
 * synthetic, disclosed ActorContext directly, mirroring exactly what the
 * real guard would produce after real validation. This substitutes only
 * *how a caller is authenticated*, never the real registerTrigger
 * business logic itself (real DB write, real cron/webhook validation,
 * real workflowVersionId FK check all execute unmodified).
 */
function evalAuthActorContext(tenantId: string): ActorContext {
  return {
    actor_type: "service",
    user_id: null,
    tenant_id: tenantId,
    workspace_id: null,
    roles: ["eval-harness"],
    permissions: ["*"],
    session_id: null,
    jti: null,
  };
}

@Module({})
class EvalTriggerRegistryModule {
  static register(store: PostgresOrchestrationStoreProvider): DynamicModule {
    return {
      module: EvalTriggerRegistryModule,
      controllers: [TriggerRegistryController],
      providers: [
        { provide: TriggerRegistryService, useValue: new TriggerRegistryService(store) },
        {
          provide: TriggerBindingService,
          useValue: new TriggerBindingService(
            new PostgresTriggerBindingStore(store),
            createMockMutableSecretsProvider({ secrets: {} }),
            { webhookBaseUrl: "http://127.0.0.1" },
          ),
        },
      ],
    };
  }
}

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.EVAL_TRIGGER_REGISTRY_DB_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("eval_trigger_registry_http_server requires EVAL_TRIGGER_REGISTRY_DB_URL");
  }
  const tenantId = process.env.EVAL_TENANT_ID;
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("eval_trigger_registry_http_server requires EVAL_TENANT_ID");
  }
  const httpPort = process.env.HTTP_PORT;
  if (httpPort === undefined || httpPort.length === 0) {
    throw new Error("eval_trigger_registry_http_server requires HTTP_PORT");
  }

  const store = new PostgresOrchestrationStoreProvider({
    authentication: "static",
    connectionString: databaseUrl,
    migrationsFolder: `${__dirname}/drizzle`,
  });
  await store.migrate();

  const app = await NestFactory.create<NestFastifyApplication>(
    EvalTriggerRegistryModule.register(store),
    new FastifyAdapter(),
  );
  const actorContext = evalAuthActorContext(`ten_${tenantId}`);
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
