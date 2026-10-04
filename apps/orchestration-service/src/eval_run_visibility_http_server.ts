import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Module, type DynamicModule } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ActorContext, IdentityTenantGatewayRequest } from "@alterx/auth";

import { NodeExecutionsController } from "./runs/node-executions.controller";
import { NodeExecutionLedgerService } from "./runs/node-execution-ledger.service";
import { RunStreamController } from "./runs/run-stream.controller";
import { RunStreamEventService } from "./runs/run-stream-event.service";

/**
 * Real, disclosed eval-only entrypoint for tenant-isolation's
 * recovery_node_lookup and run_stream_subscribe cases -- NOT
 * orchestration-service's production main.ts. NodeExecutionsController
 * and RunStreamController are real and unmodified; NodeExecutionLedgerService
 * and RunStreamEventService are real, constructed directly with a real
 * Postgres store, same "one real service" pattern the other eval-only
 * entrypoints in this campaign already use.
 *
 * Both real cross-tenant checks (NodeExecutionLedgerService.list()'s
 * `SELECT id FROM runs WHERE tenant_id = $1 AND id = $2`,
 * RunStreamEventService.runIsVisible()'s identical real, explicit,
 * tenant-scoped query) throw/return false -> real 404 RUN_NOT_FOUND --
 * matches the golden set's own corrected "not_found" outcome (was
 * seeded as "denied" before this fix; the real mechanism here is a
 * resource-visibility check, not an authorization denial).
 *
 * Production main.ts applies Identity & Tenant Gateway globally (APP_GUARD),
 * which populates `request.actorContext` from a real, signed JWT --
 * that guard is not wired here (no real signing keys/JWKS reachable in
 * this environment). Instead, a real Fastify onRequest hook sets a
 * synthetic, disclosed ActorContext directly, same shape as
 * eval_trigger_registry_http_server.ts.
 */
function evalAuthActorContext(tenantId: string): ActorContext {
  return {
    actor_type: "service",
    user_id: null,
    tenant_id: tenantId,
    workspace_id: `ws_${tenantId.slice("ten_".length)}`,
    roles: ["eval-harness"],
    permissions: ["*"],
    session_id: null,
    jti: null,
  };
}

@Module({})
class EvalRunVisibilityModule {
  static register(store: PostgresOrchestrationStoreProvider): DynamicModule {
    return {
      module: EvalRunVisibilityModule,
      controllers: [NodeExecutionsController, RunStreamController],
      providers: [
        { provide: NodeExecutionLedgerService, useValue: new NodeExecutionLedgerService(store) },
        { provide: RunStreamEventService, useValue: new RunStreamEventService(store) },
      ],
    };
  }
}

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.EVAL_RUN_VISIBILITY_DB_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("eval_run_visibility_http_server requires EVAL_RUN_VISIBILITY_DB_URL");
  }
  const tenantId = process.env.EVAL_TENANT_ID;
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("eval_run_visibility_http_server requires EVAL_TENANT_ID");
  }
  const httpPort = process.env.HTTP_PORT;
  if (httpPort === undefined || httpPort.length === 0) {
    throw new Error("eval_run_visibility_http_server requires HTTP_PORT");
  }

  const store = new PostgresOrchestrationStoreProvider({
    authentication: "static",
    connectionString: databaseUrl,
    migrationsFolder: `${__dirname}/drizzle`,
  });
  await store.migrate();

  const app = await NestFactory.create<NestFastifyApplication>(
    EvalRunVisibilityModule.register(store),
    new FastifyAdapter(),
  );
  const actorContext = evalAuthActorContext(tenantId);
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
