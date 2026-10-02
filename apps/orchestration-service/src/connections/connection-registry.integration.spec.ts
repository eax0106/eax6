import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ConnectionRegistrySnapshot } from "@alterx/contracts";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OrchestrationDeletionService } from "../deletion/deletion.service";
import { ConnectionRegistryController, CONNECTION_REGISTRY_TOKEN_HASH } from "./connection-registry.controller";
import { ConnectionRegistryService } from "./connection-registry.service";
import { connectionRegistry } from "../../db/schema/connection_registry";

const tenant = "00000000-0000-7000-8000-000000000001", other = "00000000-0000-7000-8000-000000000002";
const workspace = "00000000-0000-7000-8000-000000000003", otherWorkspace = "00000000-0000-7000-8000-000000000004";
const token = "connection-registry-fixture";
const migrationsFolder = resolve("apps/orchestration-service/drizzle");
function snapshot(overrides: Partial<ConnectionRegistrySnapshot> = {}): ConnectionRegistrySnapshot {
  const record = { tenant_id: tenant, workspace_id: workspace, connection_id: randomUUID(), connector_type: "github", status: "connected" as const, source_revision: 1, ...overrides };
  return { ...record, secret_ref: `/alter/integrations/${record.tenant_id}/${record.workspace_id}/${record.connection_id}` };
}

describe.sequential("Engine connection registry HTTP and restricted PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let registry: ConnectionRegistryService, deletion: OrchestrationDeletionService, app: NestFastifyApplication;
  let runtimeUri: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `registry_${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    runtimeUri = uri.href;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    registry = new ConnectionRegistryService(store); deletion = new OrchestrationDeletionService(store);
    const module = await Test.createTestingModule({ controllers: [ConnectionRegistryController], providers: [
      { provide: ConnectionRegistryService, useValue: registry },
      { provide: CONNECTION_REGISTRY_TOKEN_HASH, useValue: createHash("sha256").update(token).digest("hex") },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  }, 120_000);
  beforeEach(async () => { await admin.withTenant(tenant, tx => tx.query("TRUNCATE connection_registry")); });
  afterAll(async () => { await app?.close(); await store?.close(); await admin?.close(); await postgres?.stop(); });
  const send = (body: unknown, credential: string | undefined = token) => app.getHttpAdapter().getInstance().inject({
    method: "POST", url: "/internal/connections/upsert", payload: body as Record<string, unknown>,
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });

  it("authenticates before storing and rejects secret material or mismatched references", async () => {
    const record = snapshot();
    expect((await send(record, "")).statusCode).toBe(401);
    expect((await send(record, "wrong")).statusCode).toBe(401);
    expect((await send({ ...record, access_token: "must-not-cross" })).statusCode).toBe(400);
    expect((await send({ ...record, secret_ref: "/alter/integrations/other/secret" })).statusCode).toBe(400);
    expect((await send({ ...record, status: "healthy" })).statusCode).toBe(400);
    expect(await registry.list(tenant, workspace)).toEqual([]);
    expect((await send(record)).statusCode).toBe(200);
    expect(await registry.list(tenant, workspace)).toEqual([record]);
    expect(connectionRegistry).toBeDefined();
  });

  it("retains the newest revision under concurrent and duplicate delivery, and refuses scope changes", async () => {
    const record = snapshot();
    const responses = await Promise.all([
      send({ ...record, status: "revoked", source_revision: 3 }), send({ ...record, status: "error", source_revision: 2 }), send(record),
    ]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200, 200]);
    expect(await registry.list(tenant, workspace)).toEqual([{ ...record, status: "revoked", source_revision: 3 }]);
    expect((await send(record)).statusCode).toBe(200);
    expect(await registry.list(tenant, workspace)).toEqual([{ ...record, status: "revoked", source_revision: 3 }]);
    expect((await send({ ...record, status: "revoked", source_revision: 3 })).statusCode).toBe(200);
    expect((await send({ ...record, status: "connected", source_revision: 3 })).statusCode).toBe(409);
    expect((await send(snapshot({ ...record, workspace_id: otherWorkspace, source_revision: 4 }))).statusCode).toBe(409);
  });

  it("enforces real RLS, workspace predicates, tenant immutability and reference constraints", async () => {
    const record = snapshot(); await registry.upsert(record);
    expect(await registry.list(other, workspace)).toEqual([]);
    expect(await registry.list(tenant, otherWorkspace)).toEqual([]);
    const role = await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(await store.withTenant(other, tx => tx.query("SELECT * FROM connection_registry"))).toMatchObject({ rows: [] });
    await expect(store.withTenant(tenant, tx => tx.query("UPDATE connection_registry SET tenant_id=$1", [other]))).rejects.toThrow();
    await expect(store.withTenant(tenant, tx => tx.query("UPDATE connection_registry SET secret_ref='raw-token'"))).rejects.toThrow();
  });

  it("synchronizes the real platform lifecycle through HTTP in a separate process", async () => {
    await app.listen(0, "127.0.0.1");
    const result = await promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run",
      "apps/platform-api/src/integrations/connection-registry.integration.spec.ts", "--maxWorkers=1"], {
      env: { ...process.env, CONNECTION_REGISTRY_TEST_URL: await app.getUrl(),
        CONNECTION_REGISTRY_TEST_TOKEN: token, CONNECTION_REGISTRY_TEST_DATABASE_URL: runtimeUri },
      timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.stdout).toMatch(/4 passed/);
  }, 120_000);

  it("registers connection snapshots for workspace and tenant erasure and applies the paired rollback", async () => {
    await registry.upsert(snapshot()); await registry.upsert(snapshot({ workspace_id: otherWorkspace }));
    await registry.upsert(snapshot({ tenant_id: other }));
    const manifest = `del_${randomUUID()}`;
    expect(await deletion.locateWorkspaceData(`ten_${tenant}`, `ws_${workspace}`)).toContainEqual({ store: "orchestration-service", table: "connection_registry", rowCount: 1, objectReferences: [] });
    expect((await deletion.deleteWorkspaceData(`ten_${tenant}`, `ws_${workspace}`, manifest)).deletedRows).toBe(1);
    expect(await registry.list(tenant, workspace)).toEqual([]);
    expect(await registry.list(tenant, otherWorkspace)).toHaveLength(1);
    expect((await deletion.deleteSubjectData(`ten_${tenant}`, manifest)).deletedRows).toBe(1);
    expect((await deletion.verifyDeletion(`ten_${tenant}`, manifest)).deleted).toBe(true);
    expect(await registry.list(other, workspace)).toHaveLength(1);
    await admin.withTenant(tenant, async tx => {
      await tx.query(readFileSync(resolve(migrationsFolder, "rollback/0050_drop_connection_registry.sql"), "utf8"));
      expect((await tx.query("SELECT to_regclass('connection_registry') AS name")).rows[0]?.name).toBeNull();
    });
  });
});
