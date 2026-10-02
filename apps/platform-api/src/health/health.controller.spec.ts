import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";

describe("GET /health", () => {
  let app: NestFastifyApplication;
  const originalEnvironment = { ...process.env };

  beforeEach(async () => {
    process.env.DATABASE_URL =
      "postgres://platform_api:platform_api_local@localhost:5432/platform_db";
    process.env.PLATFORM_RETENTION_DATABASE_URL = "postgres://platform_retention:fixture-only@localhost:5432/platform_db";
    process.env.MARKETPLACE_DATABASE_URL =
      "postgres://platform_api:platform_api_local@localhost:5432/marketplace_db";
    process.env.NODE_ENV = "test";
    process.env.SIGNING_KEY_PROVIDER = "mock";
    process.env.ENGINE_BASE_URL = "http://engine.test";
    process.env.CONNECTION_REGISTRY_SERVICE_TOKEN_REF = "env:CONNECTION_REGISTRY_SERVICE_TOKEN";
    process.env.ADS_CORE_BASE_URL = "http://ads.test";
    process.env.COST_LEDGER_BASE_URL = "http://cost-ledger.test";
  process.env.EVAL_FACADE_TOKEN_REF = "env:EVAL_FACADE_TOKEN";
  process.env.DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF = "env:DEPLOYMENT_ADMIN_TOKEN";
    process.env.AUDIT_SERVICE_BASE_URL = "http://audit-service.test";
    process.env.AUDIT_QUERY_SERVICE_TOKEN_REF = "env:AUDIT_QUERY_SERVICE_TOKEN";
    process.env.ENGINE_M2M_TOKEN_URL = "https://identity.test/oauth/token";
    process.env.ENGINE_M2M_AUDIENCE = "https://engine.test";
    process.env.ENGINE_M2M_CLIENT_ID = "platform-api";
    process.env.ENGINE_M2M_CLIENT_SECRET_REF = "env:ENGINE_M2M_CLIENT_SECRET";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN_REF = "env:NOTIFICATION_DIGEST_SERVICE_TOKEN";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN = "test-notification-digest-token";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF = "env:CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN = "test-connector-health-sweep-token";
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnvironment };
  });

  it("returns the service health response", async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "platform-api",
    });
  });

  it("refuses application boot without the retention connection", async () => {
    delete process.env.PLATFORM_RETENTION_DATABASE_URL;
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/PLATFORM_RETENTION_DATABASE_URL/);
  });
});
