import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { DEPLOYCTL_HANDLER } from "@alterx/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { ArtifactsService } from "../artifacts/artifacts.service";
import { WorkflowLifecycleService } from "../workflow-lifecycle/workflow-lifecycle.service";

describe("GET /health", () => {
  let app: NestFastifyApplication | undefined;

  beforeEach(async () => {
    const config = {
      NODE_ENV: "production",
      RUNTIME_MODE: "real",
      INGRESS_SESSION_GATEWAY_CORE_ENABLED: "true",
      AUTH0_DOMAIN: "tenant.auth0.com",
      AUTH0_API_AUDIENCE: "alter-engine",
      ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker",
      ACTOR_TOKEN_AUDIENCE: "alter-engine",
      ACTOR_TOKEN_JWKS_URL: "https://identity.example.test/actor-jwks",
      REDIS_ENDPOINT: "redis://localhost:6379",
      ORCHESTRATION_DATABASE_HOST: "localhost",
      ORCHESTRATION_DATABASE_PORT: "5432",
      ORCHESTRATION_DATABASE_NAME: "orchestration_db",
      ORCHESTRATION_DATABASE_USER: "orchestration_service",
      DELETION_DATABASE_USER: "orchestration_deletion",
      DELETION_SERVICE_TOKEN_SHA256: "a".repeat(64),
      DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256: "c".repeat(64),
      EVAL_SERVICE_GRPC_TARGET: "127.0.0.1:50062",
      AUDIT_SERVICE_GRPC_ADDRESS: "127.0.0.1:50068",
      EVAL_FACADE_TOKEN_SHA256: "b".repeat(64),
      AWS_REGION: "ap-south-1",
      ALTER_ENV: "prod",
      EVENTBRIDGE_BUS_NAME: "alter-prod",
      ALTER_ARTIFACTS_BUCKET_PARAM: "/alter/prod/orchestration/artifacts-bucket",
      MODEL_GATEWAY_ADDRESS: "127.0.0.1:50051",
      TOOL_GATEWAY_ADDRESS: "127.0.0.1:50053",
      SANDBOX_SERVICE_ADDRESS: "127.0.0.1:50057",
      VERIFY_SERVICE_ADDRESS: "127.0.0.1:50054",
      MEMORY_SERVICE_ADDRESS: "127.0.0.1:50060",
      MEMORY_SERVICE_AUTHORIZATION: "Bearer test-service-token",
      PROVISIONING_SERVICE_ADDRESS: "127.0.0.1:50055",
      WHATSAPP_APP_SECRET: "test-app-secret",
      WHATSAPP_VERIFY_TOKEN: "test-verify-token",
      WHATSAPP_TENANT_ID: "00000000-0000-7000-8000-000000000001",
      WHATSAPP_WORKSPACE_ID: "00000000-0000-7000-8000-000000000011",
      TEMPORAL_ADDRESS: "127.0.0.1:7233",
      TEMPORAL_NAMESPACE: "default",
      CONVERSATION_LIFECYCLE_TASK_QUEUE: "conversation-lifecycle",
      EXECUTOR_TASK_QUEUE: "executor",
      WEBHOOK_PUBLIC_BASE_URL: "https://hooks.example.test",
      // D4: the pre-run estimate prices through the Cost Ledger with the model
      // gateway's own AppConfig policy; real mode refuses to start without them.
      COST_LEDGER_BASE_URL: "http://127.0.0.1:3070",
      APPCONFIG_APPLICATION_ID: "alter",
      APPCONFIG_ENVIRONMENT_ID: "prod",
      APPCONFIG_CONFIGURATION_PROFILE_ID: "model-policy",
    };
    for (const [name, value] of Object.entries(config)) {
      vi.stubEnv(name, value);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Health does not use artifact storage; avoid resolving AWS credentials.
      .overrideProvider(ArtifactsService)
      .useValue({})
      // Deployment's S3 bucket is resolved only for deployment requests.
      // Health must not contact AWS during its isolated controller test.
      .overrideProvider(DEPLOYCTL_HANDLER)
      .useValue({})
      .overrideProvider(WorkflowLifecycleService)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("returns health without authentication through the global guard", async () => {
    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "orchestration-service",
    });
  });
});
