import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeploymentChangesService, DeploymentChangesValidationError } from "./deployment-changes.service";

const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const AFTER = "2026-09-29T10:00:00.000Z";
describe.sequential("DeploymentChangesService PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let runtime: PostgresOrchestrationStoreProvider;
  let service: DeploymentChangesService;
  const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").withPassword(randomBytes(24).toString("hex")).start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: container.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `deploy_feed_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(24).toString("hex");
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(container.getConnectionUri());
    uri.username = role; uri.password = password;
    runtime = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.toString(), migrationsFolder });
    service = new DeploymentChangesService(runtime);
    for (const tenant of [TENANT, OTHER]) {
      await admin.withTenant(tenant, async (tx) => {
        await tx.query("INSERT INTO workflows (id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'Feed proof')", [`wf_${tenant}`, tenant, WORKSPACE]);
        for (const [version, stamp] of [[1, null], [2, "2026-09-29T09:00:00Z"], [3, AFTER], [4, "2026-09-29T11:00:00Z"], [5, "2026-09-29T12:00:00Z"]] as const) {
          await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status,last_deployed_at,last_deploy_kind) VALUES ($1,$2,$3,$4,'{}','v1','retired',$5,$6)", [`wfv_${tenant}_${version}`, tenant, `wf_${tenant}`, version, stamp, stamp === null ? null : version === 5 ? "restored" : "promoted"]);
        }
      });
    }
  }, 120_000);
  afterAll(async () => { await runtime?.close(); await admin?.close(); await container?.stop(); }, 60_000);
  it("returns only strictly newer tenant changes, newest first, using the workflow workspace", async () => {
    expect(await service.since(`ten_${TENANT}`, AFTER)).toEqual([5, 4].map((version) => ({ workflow_id: `wf_${TENANT}`, workflow_version_id: `wfv_${TENANT}_${version}`, workspace_id: WORKSPACE, version, kind: version === 5 ? "restored" : "promoted", changed_at: `2026-09-29T${version === 5 ? "12" : "11"}:00:00.000Z` })));
    expect(await service.since(TENANT, "2026-09-29T12:00:00Z")).toEqual([]);
  });
  it.each(["bad", "9", "2026-09-29", "2026-09-29T10:00:00", "2026-02-30T10:00:00Z"])("rejects malformed timestamp %s", async (time) => {
    await expect(service.since(TENANT, time)).rejects.toBeInstanceOf(DeploymentChangesValidationError);
  });
  it("rejects malformed tenants", async () => {
    await expect(service.since("bad", AFTER)).rejects.toBeInstanceOf(DeploymentChangesValidationError);
  });
  it("bounds the result at 200", async () => {
    await admin.withTenant(TENANT, async (tx) => {
      await tx.query("INSERT INTO workflow_versions (id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status,last_deployed_at,last_deploy_kind) SELECT 'wfv_bound_'||n,$1,$2,n,'{}','v1','retired','2026-09-29T13:00:00Z','promoted' FROM generate_series(6,210) n", [TENANT, `wf_${TENANT}`]);
    });
    const rows = await service.since(TENANT, AFTER);
    expect(rows).toHaveLength(200);
    expect(rows.every((row) => row.workflow_id === `wf_${TENANT}` && row.changed_at === "2026-09-29T13:00:00.000Z")).toBe(true);
  });
});
