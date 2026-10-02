import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WhatsappAccountNotFoundError, WhatsappAccountRegistryService } from "./whatsapp-account-registry.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const OTHER_WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";

// Deleting a WhatsApp account is scoped by tenant and workspace in SQL, and
// takes the account out of inbound routing. Proven on Postgres with a role
// held to row-level security.
describe.sequential("WhatsApp account delete, real Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let adminStore: PostgresOrchestrationStoreProvider;
  let tenantStore: PostgresOrchestrationStoreProvider;
  const role = `wa_delete_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminStore = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await adminStore.migrate();
    await adminStore.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    });
    tenantStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      migrationsFolder,
    });
  }, 120_000);

  afterAll(async () => {
    await tenantStore?.close();
    await adminStore?.withTenant(TENANT, async (tx) => {
      await tx.query(`DROP OWNED BY ${role}`);
      await tx.query(`DROP ROLE IF EXISTS ${role}`);
    });
    await adminStore?.close();
    await postgres?.stop();
  }, 60_000);

  const registry = () => new WhatsappAccountRegistryService(tenantStore);
  const register = (tenant: string, workspace: string, phone: string) =>
    registry().register(tenant, {
      workspaceId: workspace, phoneNumberId: phone, wabaId: "waba", accessTokenRef: "env:WA", status: "connected",
      monitoringConfig: {}, mediaConfig: {}, escalationRules: [],
    });

  it("removes the account from its own workspace and stops routing its phone number", async () => {
    const account = await register(TENANT, WORKSPACE, "phone-own");
    await expect(registry().resolveInbound("phone-own")).resolves.toMatchObject({ accountId: account.id });

    await registry().remove(TENANT, WORKSPACE, account.id);

    expect((await registry().list(TENANT, WORKSPACE)).map((item) => item.id)).not.toContain(account.id);
    await expect(registry().resolveInbound("phone-own")).rejects.toBeInstanceOf(WhatsappAccountNotFoundError);
    await expect(registry().remove(TENANT, WORKSPACE, account.id)).rejects.toBeInstanceOf(WhatsappAccountNotFoundError);
  });

  it("does not remove an account of another workspace or another tenant", async () => {
    const otherWorkspace = await register(TENANT, OTHER_WORKSPACE, "phone-other-ws");
    const otherTenant = await register(OTHER_TENANT, WORKSPACE, "phone-other-tenant");

    await expect(registry().remove(TENANT, WORKSPACE, otherWorkspace.id)).rejects.toBeInstanceOf(WhatsappAccountNotFoundError);
    await expect(registry().remove(TENANT, WORKSPACE, otherTenant.id)).rejects.toBeInstanceOf(WhatsappAccountNotFoundError);

    expect((await registry().list(TENANT, OTHER_WORKSPACE)).map((item) => item.id)).toContain(otherWorkspace.id);
    expect((await registry().list(OTHER_TENANT, WORKSPACE)).map((item) => item.id)).toContain(otherTenant.id);
    await expect(registry().resolveInbound("phone-other-ws")).resolves.toMatchObject({ accountId: otherWorkspace.id });
  });
});
