import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ExecutionContext } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  jwksFetch,
  mintJwt,
  TEST_NOW,
  TEST_TENANT,
  TEST_WORKSPACE,
  testSigningKey,
  type TestSigningKey,
} from "../test-utils/jwt-fixture";
import { ActorTokenValidator } from "./actor-token-validator";
import { M2mValidator } from "./m2m-validator";
import { SessionGatewayGuard } from "./session-gateway.guard";
import type {
  ReplayStore,
  IdentityTenantGatewayRequest,
} from "./types";

const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-000000000002";
const workspaceB = "00000000-0000-7000-8000-000000000012";
const migrationsFolder = resolve(
  process.cwd(),
  "apps/orchestration-service/drizzle",
);

describe.sequential("Session Gateway PostgreSQL RLS integration", () => {
  let container: StartedPostgreSqlContainer;
  let adminPool: Pool;
  let rolePool: Pool;
  let adminProvider: PostgresOrchestrationStoreProvider;
  let roleProvider: PostgresOrchestrationStoreProvider;
  let signingKey: TestSigningKey;
  const role = `session_gateway_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    signingKey = testSigningKey("auth0-test");
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_test_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    adminProvider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: container.getConnectionUri(),
        migrationsFolder,
      },
      { pool: adminPool },
    );
    await adminProvider.migrate();
    await adminPool.query(
      `INSERT INTO workflows (id, tenant_id, workspace_id, name)
       VALUES ('wf_a', $1, $2, 'Workflow A'),
              ('wf_b', $3, $4, 'Workflow B')`,
      [tenantA, workspaceA, tenantB, workspaceB],
    );
    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await adminPool.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
    await adminPool.query("GRANT USAGE ON SCHEMA public TO " + role);
    await adminPool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO " +
        role,
    );
    rolePool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: role,
      password,
    });
    roleProvider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://unused/orchestration_db",
        migrationsFolder,
      },
      { pool: rolePool },
    );
  }, 120_000);

  afterAll(async () => {
    await roleProvider?.close();
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${role}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await adminProvider?.close();
    await container?.stop();
  });

  it("sets INGR-1 tenant context on the queried connection and isolates rows", async () => {
    const m2m = new M2mValidator(
      {
        auth0Domain: "tenant.auth0.com",
        apiAudience: "alter-engine",
      },
      { fetch: jwksFetch(signingKey), nowSeconds: () => TEST_NOW },
    );
    const unusedActorValidator = new ActorTokenValidator(
      {
        issuer: "alter-platform-api.identity-broker",
        audience: "alter-engine",
        jwksUrl: "https://identity.example.test/actor-jwks",
      },
      { setIfAbsent: vi.fn() } satisfies ReplayStore,
      { fetch: jwksFetch(signingKey), nowSeconds: () => TEST_NOW },
    );
    const guard = new SessionGatewayGuard(
      m2m,
      unusedActorValidator,
      roleProvider,
    );
    const request: IdentityTenantGatewayRequest = {
      headers: {
        authorization: `Bearer ${mintJwt(
          {
            iss: "https://tenant.auth0.com/",
            aud: "alter-engine",
            iat: TEST_NOW,
            exp: TEST_NOW + 60,
            "https://alter.dev/claims/actor_type": "service",
            tenant_id: TEST_TENANT,
            workspace_id: TEST_WORKSPACE,
            roles: ["service"],
            permissions: ["workflow:read"],
          },
          signingKey,
        )}`,
      },
      url: "/v1/workflows",
    };
    const handler = () => undefined;
    const context = {
      getHandler: () => handler,
      getClass: () => class TestController {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ header: vi.fn() }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    const evidence = await request.withTenantDatabase?.(async (transaction) => {
      const setting = await transaction.query(
        "SELECT current_setting('app.current_tenant_id', true) AS tenant",
      );
      const workflows = await transaction.query(
        "SELECT id, name FROM workflows ORDER BY id",
      );
      return { setting: setting.rows, workflows: workflows.rows };
    });

    expect(evidence).toEqual({
      setting: [{ tenant: tenantA }],
      workflows: [{ id: "wf_a", name: "Workflow A" }],
    });
  });
});
