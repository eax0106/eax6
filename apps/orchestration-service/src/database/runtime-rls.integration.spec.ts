import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const tenantA = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const tenantB = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workspaceA = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const workspaceB = "018f4d6e-2b4a-7a3e-8c1a-1234567890d1";
const integrationA = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const integrationB = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const runtimeRole = "orchestration_service";
const runtimePassword = randomBytes(24).toString("hex");
const systemTenant = "00000000-0000-7000-8000-000000000000";

describe.sequential("orchestration runtime RLS", () => {
  let container: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let runtimeStore: PostgresOrchestrationStoreProvider;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: container.getConnectionUri(),
      migrationsFolder,
    });
    await store.withTenant(systemTenant, (tx) =>
      tx.query(`CREATE ROLE ${runtimeRole} LOGIN NOBYPASSRLS PASSWORD '${runtimePassword}'`),
    );
    await store.migrate();

    await store.withTenant(systemTenant, async (tx) => {
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
      await tx.query(`ALTER FUNCTION resolve_webhook_endpoint(text) OWNER TO ${runtimeRole}`);
      await tx.query(
        `INSERT INTO webhook_endpoints
         (id, tenant_id, workspace_id, integration_id, path_token)
       VALUES
         ('wep_a', $1, $2, $3, 'public-path-a'),
         ('wep_b', $4, $5, $6, 'public-path-b')`,
        [tenantA, workspaceA, integrationA, tenantB, workspaceB, integrationB],
      );
      await tx.query(
        `INSERT INTO webhook_endpoint_secrets
         (id, tenant_id, endpoint_id, version, secret_ref, status)
       VALUES
         ('whs_a', $1, 'wep_a', 1, '/alter/test/webhook/a', 'active'),
         ('whs_b', $2, 'wep_b', 1, '/alter/test/webhook/b', 'active')`,
        [tenantA, tenantB],
      );
    });

    const runtimeUrl = new URL(container.getConnectionUri());
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: runtimeUrl.toString(),
      migrationsFolder,
    });
  }, 120_000);

  afterAll(async () => {
    await runtimeStore?.close();
    await store?.close();
    await container?.stop();
  }, 60_000);

  it("holds the runtime role to RLS while a narrowly granted resolver finds one public endpoint", async () => {
    const role = await runtimeStore.withTenant(systemTenant, (tx) =>
      tx.query<{ rolbypassrls: boolean }>("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"),
    );
    expect(role.rows).toEqual([{ rolbypassrls: false }]);

    const { own, other } = await runtimeStore.withTenant(tenantA, async (tx) => {
      const own = await tx.query<{ id: string }>("SELECT id FROM webhook_endpoints ORDER BY id");
      const other = await tx.query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE id = 'wep_b'");
      return { own, other };
    });
    expect(own.rows).toEqual([{ id: "wep_a" }]);
    expect(other.rows).toEqual([]);

    const { resolved, unknown } = await runtimeStore.withTenant(systemTenant, async (tx) => {
      const resolved = await tx.query<{ endpoint_id: string; tenant_id: string; secret_ref: string }>(
        "SELECT endpoint_id, tenant_id::text, secret_ref FROM resolve_webhook_endpoint($1)",
        ["public-path-b"],
      );
      const unknown = await tx.query("SELECT * FROM resolve_webhook_endpoint($1)", ["missing-path"]);
      return { resolved, unknown };
    });
    expect(resolved.rows).toEqual([{ endpoint_id: "wep_b", tenant_id: tenantB, secret_ref: "/alter/test/webhook/b" }]);
    expect(unknown.rows).toEqual([]);
  });
});
