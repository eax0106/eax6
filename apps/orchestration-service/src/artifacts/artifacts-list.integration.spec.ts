import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { createMockObjectStorageProvider } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactsService, ArtifactValidationError } from "./artifacts.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const OTHER_WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const id = (prefix: string, n: number) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;

// The web's artifacts page lists every artifact the workspace's runs made.
// Workspace scoping is a join through runs, so it is proven on Postgres with
// a role held to row-level security.
describe.sequential("workspace artifact list, real Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let adminStore: PostgresOrchestrationStoreProvider;
  let tenantStore: PostgresOrchestrationStoreProvider;
  const role = `artifact_list_${randomBytes(6).toString("hex")}`;
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
      await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind) VALUES ($1, $2, $3, 'workflow')", [id("run", 1), TENANT, WORKSPACE]);
      await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind) VALUES ($1, $2, $3, 'workflow')", [id("run", 2), TENANT, WORKSPACE]);
      await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind) VALUES ($1, $2, $3, 'workflow')", [id("run", 3), TENANT, OTHER_WORKSPACE]);
      for (let n = 1; n <= 3; n += 1) {
        await tx.query(
          `INSERT INTO artifacts (id, tenant_id, run_id, storage_reference, content_type, size_bytes, created_at)
           VALUES ($1, $2, $3, $4, 'text/plain', $5, now() - make_interval(mins => $6::int))`,
          [id("art", n), TENANT, id("run", n === 3 ? 2 : 1), `s3://bucket/tenants/${TENANT}/art${n}`, n, n],
        );
      }
      await tx.query(
        "INSERT INTO artifacts (id, tenant_id, run_id, storage_reference, content_type, size_bytes) VALUES ($1, $2, $3, 's3://bucket/x', 'text/plain', 1)",
        [id("art", 9), TENANT, id("run", 3)],
      );
    });
    await adminStore.withTenant(OTHER_TENANT, async (tx) => {
      await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind) VALUES ($1, $2, $3, 'workflow')", [id("run", 4), OTHER_TENANT, WORKSPACE]);
      await tx.query(
        "INSERT INTO artifacts (id, tenant_id, run_id, storage_reference, content_type, size_bytes) VALUES ($1, $2, $3, 's3://bucket/y', 'text/plain', 1)",
        [id("art", 8), OTHER_TENANT, id("run", 4)],
      );
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

  const service = () => new ArtifactsService(tenantStore, createMockObjectStorageProvider(), "bucket");
  const ids = (page: { data: readonly { id: string }[] }) => page.data.map((artifact) => artifact.id);

  it("lists every artifact of the workspace's runs, newest first, and nothing from another workspace or tenant", async () => {
    const page = await service().listForWorkspace(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50);
    expect(ids(page)).toEqual([id("art", 1), id("art", 2), id("art", 3)]);
    expect(page.data.map((artifact) => artifact.runId)).toEqual([id("run", 1), id("run", 1), id("run", 2)]);
    expect(page.data.every((artifact) => artifact.workspaceId === WORKSPACE)).toBe(true);
    expect(page.page).toEqual({ next_cursor: null, has_more: false });
  });

  it("pages by cursor without repeating or skipping", async () => {
    const first = await service().listForWorkspace(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 2);
    expect(first.page).toEqual({ next_cursor: id("art", 2), has_more: true });
    const second = await service().listForWorkspace(`ten_${TENANT}`, `ws_${WORKSPACE}`, first.page.next_cursor ?? undefined, 2);
    expect([...ids(first), ...ids(second)]).toEqual([id("art", 1), id("art", 2), id("art", 3)]);
    expect(second.page.has_more).toBe(false);
  });

  it("refuses a cursor from another workspace, a bad workspace id and an out-of-range limit", async () => {
    await expect(service().listForWorkspace(`ten_${TENANT}`, `ws_${WORKSPACE}`, id("art", 9), 50)).rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(service().listForWorkspace(`ten_${TENANT}`, WORKSPACE, undefined, 50)).rejects.toBeInstanceOf(ArtifactValidationError);
    await expect(service().listForWorkspace(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 201)).rejects.toBeInstanceOf(ArtifactValidationError);
  });
});
