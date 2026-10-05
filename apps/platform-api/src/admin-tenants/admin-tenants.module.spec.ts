import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RbacModule } from "../rbac";
import { AdminTenantsModule } from "./admin-tenants.module";
import { AdminTenantsRepository } from "./admin-tenants.repository";
import { AdminTenantsService } from "./admin-tenants.service";
import { AdminTenantActivityService } from "./admin-tenant-activity.service";
import { TenantActivityClient } from "../engine";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("AdminTenantsModule", () => {
  it("wires real providers and applies staff auth middleware on init", async () => {
    process.env.DATABASE_URL = "postgres://localhost/platform";
    setEngineEnvironment();

    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule, AdminTenantsModule],
    }).compile();

    expect(moduleRef.get(AdminTenantsRepository)).toBeInstanceOf(
      AdminTenantsRepository,
    );
    expect(moduleRef.get(AdminTenantsService)).toBeInstanceOf(
      AdminTenantsService,
    );
    expect(moduleRef.get(AdminTenantActivityService)).toBeInstanceOf(AdminTenantActivityService);
    expect(moduleRef.get(TenantActivityClient)).toBeInstanceOf(TenantActivityClient);

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.close();
  });
});

function setEngineEnvironment(): void {
  process.env.NODE_ENV = "test";
  process.env.MARKETPLACE_DATABASE_URL = "postgres://localhost/marketplace";
  process.env.SIGNING_KEY_PROVIDER = "mock";
  process.env.ENGINE_BASE_URL = "http://engine.test";
  process.env.BILLING_SYNC_SERVICE_TOKEN_REF = "env:BILLING_SYNC_TOKEN";
  process.env.CONNECTION_REGISTRY_SERVICE_TOKEN_REF = "env:CONNECTION_REGISTRY_TOKEN";
  process.env.ADS_CORE_BASE_URL = "http://ads.test";
  process.env.COST_LEDGER_BASE_URL = "http://costs.test";
  process.env.EVAL_FACADE_TOKEN_REF = "env:EVAL_TOKEN";
  process.env.DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF = "env:DEPLOYMENT_ADMIN_TOKEN";
  process.env.AUDIT_SERVICE_BASE_URL = "http://audit.test";
  process.env.AUDIT_QUERY_SERVICE_TOKEN_REF = "env:AUDIT_TOKEN";
  process.env.ENGINE_M2M_TOKEN_URL = "https://identity.test/oauth/token";
  process.env.ENGINE_M2M_AUDIENCE = "https://engine.test";
  process.env.ENGINE_M2M_CLIENT_ID = "platform-api";
  process.env.ENGINE_M2M_CLIENT_SECRET_REF = "env:ENGINE_SECRET";
}
