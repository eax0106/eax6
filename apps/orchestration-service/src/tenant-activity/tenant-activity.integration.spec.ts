import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantActivityService } from "./tenant-activity.service";

const tenant = uuidv7(), other = uuidv7(), workspace = uuidv7();
const window = { tenant_id: tenant, start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" };
describe.sequential("tenant engine activity through ordinary PostgreSQL", () => {
  let container: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let service: TenantActivityService;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("activity_db").withPassword(randomBytes(24).toString("hex")).start();
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: container.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = "activity_" + randomBytes(6).toString("hex"), password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const url = new URL(container.getConnectionUri()); url.username = role; url.password = password;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: url.href, migrationsFolder });
    service = new TenantActivityService(store);
  }, 120_000);
  afterAll(async () => { await store?.close(); await admin?.close(); await container?.stop(); });
  beforeEach(async () => {
    for (const id of [tenant, other]) await store.withTenant(id, async tx => { await tx.query("DELETE FROM runs WHERE tenant_id=$1", [id]); await tx.query("DELETE FROM workflows WHERE tenant_id=$1", [id]); });
  });

  it("returns exact counts and stable bounded lists from this tenant's actual records", async () => {
    await store.withTenant(tenant, async tx => {
      expect((await tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      for (let i = 0; i < 51; i++) {
        const workflow = `wf_${uuidv7()}`;
        await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,$4)", [workflow, tenant, workspace, `Workflow ${i}`]);
        await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,workflow_id,parent_kind,status,created_at) VALUES($1,$2,$3,$4,'workflow','completed','2026-09-20')", [`run_${uuidv7()}`, tenant, workspace, workflow]);
      }
    });
    await store.withTenant(other, async tx => {
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Other tenant')", [`wf_${uuidv7()}`, other, workspace]);
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,created_at) VALUES($1,$2,$3,'workflow','2026-09-20')", [`run_${uuidv7()}`, other, workspace]);
    });
    const result = await service.activity(window);
    expect(result).toMatchObject({ workflow_count: 51, run_count: 51 });
    expect(result.workflows).toHaveLength(50); expect(result.runs).toHaveLength(50);
    expect(result.workflows.some(item => item.name === "Other tenant")).toBe(false);
    expect(await service.activity(window)).toEqual(result);
    expect(await service.activity({ ...window, tenant_id: other })).toMatchObject({ workflow_count: 1, run_count: 1 });
  });

  it("includes the exact start, excludes the exact end and returns truthful empty data", async () => {
    const empty = await service.activity(window);
    expect(empty).toMatchObject({ workflow_count: 0, run_count: 0, workflows: [], runs: [] });
    const times = ["2026-09-04T23:59:59.999Z", window.start_at, "2026-10-04T23:59:59.999Z", window.end_at, "2026-10-05T00:00:00.001Z"];
    const ids = times.map(() => `run_${uuidv7()}`);
    await store.withTenant(tenant, async tx => {
      for (const [i, time] of times.entries()) await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,created_at) VALUES($1,$2,$3,'workflow',$4)", [ids[i], tenant, workspace, time]);
    });
    const result = await service.activity(window);
    expect(result.run_count).toBe(2); expect(result.runs.map(run => run.id)).toEqual([ids[2], ids[1]]);
    expect(() => service.activity({ ...window, tenant_id: "unrelated" })).toThrow();
  });
});
