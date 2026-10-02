import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Module, type DynamicModule } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ActorContext, IdentityTenantGatewayRequest } from "@alterx/auth";

import { WorkflowReadController } from "./workflow-read/workflow-read.controller";
import { WorkflowReadService } from "./workflow-read/workflow-read.service";

/**
 * Real, disclosed eval-only entrypoint for tenant-isolation's
 * workflow_get and workflow_update cases -- NOT orchestration-service's
 * production main.ts. WorkflowReadController is real and unmodified;
 * WorkflowReadService is real, constructed directly with a real Postgres
 * store, same "one real service" pattern as
 * eval_run_visibility_http_server.ts.
 *
 * The real cross-tenant check comes entirely from the `workflows` table's
 * own RLS policy (`workflows_tenant_context_isolation`,
 * 0000_create_workflows.sql) combined with WorkflowReadService's own
 * explicit `WHERE tenant_id = $1 AND id = $2` -- a cross-tenant read/
 * update is a real 404 WORKFLOW_NOT_FOUND, matching the golden set's
 * "not_found" outcome for both cases.
 *
 * Production main.ts applies SessionGatewayGuard globally (APP_GUARD),
 * which populates `request.actorContext` from a real, signed JWT -- that
 * guard is not wired here (no real signing keys/JWKS reachable in this
 * environment). Instead, a real Fastify onRequest hook sets a synthetic,
 * disclosed ActorContext directly, same shape as every other eval-only
 * entrypoint in this campaign.
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
class EvalWorkflowReadModule {
  static register(store: PostgresOrchestrationStoreProvider): DynamicModule {
    return {
      module: EvalWorkflowReadModule,
      controllers: [WorkflowReadController],
      providers: [{ provide: WorkflowReadService, useValue: new WorkflowReadService(store) }],
    };
  }
}

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.EVAL_WORKFLOW_READ_DB_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("eval_workflow_read_http_server requires EVAL_WORKFLOW_READ_DB_URL");
  }
  const tenantId = process.env.EVAL_TENANT_ID;
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("eval_workflow_read_http_server requires EVAL_TENANT_ID");
  }
  const httpPort = process.env.HTTP_PORT;
  if (httpPort === undefined || httpPort.length === 0) {
    throw new Error("eval_workflow_read_http_server requires HTTP_PORT");
  }

  const store = new PostgresOrchestrationStoreProvider({
    authentication: "static",
    connectionString: databaseUrl,
    migrationsFolder: `${__dirname}/drizzle`,
  });
  await store.migrate();

  const app = await NestFactory.create<NestFastifyApplication>(
    EvalWorkflowReadModule.register(store),
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
