import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import type { ConnectionRegistrySnapshot } from "@alterx/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionRegistryClient } from "../engine/connection-registry-client";
import { createFetchOAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import { IntegrationRepository } from "./integration.repository";
import { IntegrationService, tokenReference, type ConnectorRuntimeConfigMap } from "./integration.service";
import { SystemIntegrationStore } from "./system-integration-store";

const tenant = "00000000-0000-7000-8000-000000000001", other = "00000000-0000-7000-8000-000000000002";
const workspace = "00000000-0000-7000-8000-000000000003", otherWorkspace = "00000000-0000-7000-8000-000000000004";
const actor = "00000000-0000-7000-8000-000000000005";
const migrationRoot = resolve("apps/platform-api/src/db/migrations");
const originalFetch = fetch;

// The engine integration spec supplies a real restricted database and HTTP server.
// Separate processes keep each app's imports inside its own boundary.
describe.skipIf(!process.env.CONNECTION_REGISTRY_TEST_URL).sequential("Platform connection registry lifecycle over real engine HTTP", () => {
  let postgres: StartedPostgreSqlContainer, admin: pg.Pool, runtime: pg.Pool, system: pg.Pool, engine: pg.Pool;
  let repository: IntegrationRepository, service: IntegrationService;
  let secrets: ReturnType<typeof createMockMutableSecretsProvider>;
  let missed = false, unhealthy = false, account = "account-a", tokenSequence = 0;
  const snapshots: ConnectionRegistrySnapshot[] = [];

  async function migrate(file: string): Promise<void> {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      for (const statement of readFileSync(resolve(migrationRoot, file), "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async function registered(id: string): Promise<ConnectionRegistrySnapshot | undefined> {
    const client = await engine.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const result = await client.query("SELECT tenant_id,workspace_id,connection_id,connector_type,status,secret_ref,source_revision FROM connection_registry WHERE connection_id=$1", [id]);
      await client.query("COMMIT"); return result.rows[0];
    } finally { client.release(); }
  }

  async function connect(): Promise<Awaited<ReturnType<IntegrationService["callback"]>>> {
    const authorization = await service.authorize(tenant, workspace, actor, "github", { redirect_uri: "https://client.test/callback" });
    return service.callback(tenant, workspace, actor, "github", { code: "fixture-code", state: authorization.state });
  }

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("platform_db").start();
    admin = new pg.Pool({ connectionString: postgres.getConnectionUri() });
    for (const file of ["0000_platform_db_identity_foundation.sql", "0003_onboarding_states.sql", "0009_oauth_hub.sql", "0015_workspace_connector_configs.sql", "0032_connection_sync_revision.sql"]) await migrate(file);
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Registry A','active'),($2,'Registry B','active')", [tenant, other]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,name,status) VALUES($1,$2,'Main','active'),($3,$2,'Other','active')", [workspace, tenant, otherWorkspace]);
    const role = `connections_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    runtime = new pg.Pool({ connectionString: uri.href }); repository = new IntegrationRepository(runtime);
    const systemRole = `${role}_system`;
    await admin.query(`CREATE ROLE ${systemRole} LOGIN BYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${systemRole}`);
    await admin.query(`GRANT SELECT ON oauth_connections TO ${systemRole}`);
    uri.username = systemRole; system = new pg.Pool({ connectionString: uri.href });
    engine = new pg.Pool({ connectionString: process.env.CONNECTION_REGISTRY_TEST_DATABASE_URL });
  }, 120_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE oauth_states,oauth_connections CASCADE");
    missed = false; unhealthy = false; account = "account-a"; tokenSequence = 0; snapshots.length = 0;
    secrets = { ...createMockMutableSecretsProvider({ secrets: { "fixture-client-id": "client", "fixture-client-secret": "secret" } }) };
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: `fixture-token-${++tokenSequence}`, token_type: "bearer", scope: "repo read:user" });
      }
      if (url === "https://api.github.com/user") return unhealthy ? new Response(null, { status: 401 }) : Response.json({ id: account });
      if (url === "https://api.github.com/applications/client/grant" && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("Unexpected OAuth edge request");
    }));
    const registry = new ConnectionRegistryClient(process.env.CONNECTION_REGISTRY_TEST_URL!, async () => process.env.CONNECTION_REGISTRY_TEST_TOKEN!, async (input, init) => {
      snapshots.push(JSON.parse(String(init?.body)) as ConnectionRegistrySnapshot);
      return missed ? new Response(null, { status: 503 }) : originalFetch(input, init);
    });
    service = new IntegrationService(repository, secrets, createFetchOAuthHttpClient(), {
      github: { configured: true, clientIdSecretRef: "fixture-client-id", clientSecretSecretRef: "fixture-client-secret" },
    } as ConnectorRuntimeConfigMap, registry, 300, new SystemIntegrationStore(system));
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); await engine?.end(); await runtime?.end(); await system?.end(); await admin?.end(); await postgres?.stop();
  });

  it("connects, reconnects the same account and propagates health using references only", async () => {
    const first = await connect();
    expect(first.engine_synced).toBe(true);
    const reference = tokenReference(tenant, workspace, first.id);
    expect(await registered(first.id)).toEqual({ tenant_id: tenant, workspace_id: workspace, connection_id: first.id,
      connector_type: "github", status: "connected", secret_ref: reference, source_revision: 1 });
    expect(JSON.parse(await secrets.getSecret(reference)).access_token).toBe("fixture-token-1");
    const second = await connect();
    expect(second.id).toBe(first.id); expect(second.engine_synced).toBe(true);
    expect(await repository.listConnections(tenant, workspace)).toHaveLength(1);
    expect(JSON.parse(await secrets.getSecret(reference)).access_token).toBe("fixture-token-2");
    expect(await secrets.listSecretReferences(`/alter/integrations/${tenant}/${workspace}/`)).toEqual([reference]);
    const originalPut = secrets.putSecret.bind(secrets);
    const putSecret = vi.spyOn(secrets, "putSecret").mockImplementation(async (ref, value) => {
      if (ref === reference) throw new Error("fixture storage unavailable");
      return originalPut(ref, value);
    });
    await expect(connect()).rejects.toThrow(); putSecret.mockRestore();
    expect((await repository.findConnection(tenant, workspace, first.id))?.sourceRevision).toBe(2);
    expect(JSON.parse(await secrets.getSecret(reference)).access_token).toBe("fixture-token-2");
    expect(await secrets.listSecretReferences(`/alter/integrations/${tenant}/${workspace}/`)).toEqual([reference]);
    expect(await registered(first.id)).toMatchObject({ source_revision: 2, status: "connected" });
    expect((await service.health(tenant, workspace, first.id, actor)).engine_synced).toBe(true);
    unhealthy = true;
    expect((await service.health(tenant, workspace, first.id, actor)).last_health_status).toBe("unhealthy");
    expect(await registered(first.id)).toMatchObject({ source_revision: 4, status: "error" });
    expect(snapshots.every(record => Object.keys(record).length === 7 && !JSON.stringify(record).includes("fixture-token"))).toBe(true);
  });

  it("preserves a missed connect and heals missed revoked and error states in the system sweep", async () => {
    missed = true;
    const connected = await connect();
    expect(connected.engine_synced).toBe(false); expect(await registered(connected.id)).toBeUndefined();
    expect(await secrets.getSecret(tokenReference(tenant, workspace, connected.id))).toBeTruthy();
    account = "account-b"; missed = false; const revoked = await connect();
    missed = true; const result = await service.revoke(tenant, workspace, revoked.id, actor);
    expect(result).toMatchObject({ status: "revoked", engine_synced: false, revoked_remotely: true });
    await expect(secrets.getSecret(tokenReference(tenant, workspace, revoked.id))).rejects.toThrow();
    expect(await registered(revoked.id)).toMatchObject({ status: "connected", source_revision: 1 });
    account = "account-c"; missed = false; const failed = await connect();
    await admin.query("UPDATE oauth_connections SET status='error',source_revision=source_revision+1 WHERE id=$1", [failed.id]);
    expect(await service.runHealthSweep("svc_platform_jobs")).toEqual({ connectionsProcessed: 3, connectionsFailed: 0 });
    expect(await registered(connected.id)).toMatchObject({ status: "connected", source_revision: 2 });
    expect(await registered(revoked.id)).toMatchObject({ status: "revoked", source_revision: 2 });
    expect(await registered(failed.id)).toMatchObject({ status: "error", source_revision: 2 });
    expect((await admin.query("SELECT used_by FROM oauth_connection_use_audits WHERE connection_id=$1", [connected.id])).rows).toEqual([{ used_by: "svc_platform_jobs" }]);
    missed = true;
    expect(await service.runHealthSweep("svc_platform_jobs")).toEqual({ connectionsProcessed: 3, connectionsFailed: 3 });
    await expect(migrate("rollback/0032_remove_connection_sync_revision.sql")).rejects.toThrow();
    expect((await admin.query("SELECT source_revision FROM oauth_connections WHERE id=$1", [connected.id])).rows[0]).toBeDefined();
  });

  it("uses a restricted tenant pool and a separate select-only sweep identity, and isolates workspaces", async () => {
    const connected = await connect();
    expect((await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect((await system.query("SELECT rolsuper,rolbypassrls,has_table_privilege(current_user,'oauth_connections','UPDATE') AS can_write FROM pg_roles WHERE rolname=current_user")).rows[0]).toEqual({ rolsuper: false, rolbypassrls: true, can_write: false });
    expect(await repository.findConnection(other, workspace, connected.id)).toBeUndefined();
    expect(await repository.findConnection(tenant, otherWorkspace, connected.id)).toBeUndefined();
    await expect(service.revoke(tenant, otherWorkspace, connected.id, actor)).rejects.toMatchObject({ response: { error_code: "INTEGRATION_CONNECTION_NOT_FOUND" } });
    expect(await secrets.getSecret(tokenReference(tenant, workspace, connected.id))).toBeTruthy();
  });

  it("rolls back and reapplies the platform migration while preserving representable attribution", async () => {
    const connected = await connect();
    await repository.recordUse(tenant, connected.id, actor, "health_check");
    await migrate("rollback/0032_remove_connection_sync_revision.sql");
    expect((await admin.query("SELECT used_by FROM oauth_connection_use_audits")).rows).toEqual([{ used_by: actor }]);
    expect((await admin.query("SELECT data_type FROM information_schema.columns WHERE table_name='oauth_connection_use_audits' AND column_name='used_by'")).rows[0]).toEqual({ data_type: "uuid" });
    await migrate("0032_connection_sync_revision.sql");
    expect((await repository.findConnection(tenant, workspace, connected.id))?.sourceRevision).toBe(1);
  });
});
