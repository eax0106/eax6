import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OrchestrationDeletionService } from "../deletion/deletion.service";
import type { OrchestrationTenantStore } from "../runs/run-observability.service";
import {
  RunRetentionConfirmationRequiredError,
  RunRetentionService,
  RunRetentionStaleError,
  RunRetentionValidationError,
  sweepRunHistory,
} from "./run-retention.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890c2";
const WS = "018f4d6e-2b4a-7a3e-8c1a-1234567890d1";
const WS_OTHER = "018f4d6e-2b4a-7a3e-8c1a-1234567890d2";

// D2 run-history retention on a real orchestration_db.
describe.sequential("RunRetentionService", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let retention: RunRetentionService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    retention = new RunRetentionService(store as unknown as OrchestrationTenantStore);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  beforeEach(async () => {
    for (const tenant of [TENANT, OTHER_TENANT]) {
      await store.withTenant(tenant, async (tx) => {
        for (const table of ["workspace_run_retention", "deployments", "projects", "runs", "workflow_versions", "workflows"]) {
          await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant]);
        }
      });
    }
  });

  /** One workflow per workspace, then runs `ageDays` old in the given status. */
  async function seed(tenant: string, workspace: string, runs: readonly { id: string; ageDays: number; status?: string }[]) {
    await store.withTenant(tenant, async (tx) => {
      const workflow = `wf_${tenant.slice(-2)}${workspace.slice(-4)}`;
      const version = `wfv_${tenant.slice(-2)}${workspace.slice(-4)}`;
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'fixture') ON CONFLICT DO NOTHING", [workflow, tenant, workspace]);
      await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES ($1,$2,$3,1,'{}','v1') ON CONFLICT DO NOTHING", [version, tenant, workflow]);
      for (const run of runs) {
        await tx.query(
          `INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id,status,created_at,ended_at)
           VALUES ($1,$2,$3,'workflow',$4,$5,$6,now() - make_interval(days => $7), now() - make_interval(days => $7))`,
          [run.id, tenant, workspace, workflow, version, run.status ?? "completed", run.ageDays],
        );
        await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$2,$3,'n','Merge','succeeded')", [`node_${run.id}`, tenant, run.id]);
      }
    });
  }

  async function runIds(tenant: string): Promise<string[]> {
    return store.withTenant(tenant, async (tx) =>
      (await tx.query<{ id: string }>("SELECT id FROM runs WHERE tenant_id = $1", [tenant])).rows.map((row) => row.id).sort(),
    );
  }

  it("reads the 365-day default, previews what a lower window deletes, and refuses an unconfirmed lowering", async () => {
    await seed(TENANT, WS, [{ id: "run_a_5", ageDays: 5 }, { id: "run_a_40", ageDays: 40 }, { id: "run_a_100", ageDays: 100 }]);
    const initial = await retention.get(TENANT, WS);
    expect(initial).toMatchObject({ retentionDays: 365, isDefault: true });

    await expect(retention.preview(TENANT, WS, 30)).resolves.toBe(2);
    await expect(retention.preview(TENANT, WS, 7)).resolves.toBe(2);
    await expect(retention.preview(TENANT, WS, 365)).resolves.toBe(0);

    const refused = retention.set(TENANT, WS, { retentionDays: 30, confirmLowering: false, updatedBy: "usr_1" }, initial.etag);
    await expect(refused).rejects.toBeInstanceOf(RunRetentionConfirmationRequiredError);
    await expect(refused).rejects.toMatchObject({ runsToDelete: 2 });
    await expect(retention.get(TENANT, WS)).resolves.toMatchObject({ isDefault: true });

    const saved = await retention.set(TENANT, WS, { retentionDays: 30, confirmLowering: true, updatedBy: "usr_1" }, initial.etag);
    expect(saved).toMatchObject({ retentionDays: 30, isDefault: false, updatedBy: "usr_1" });

    // Raising needs no confirmation; a stale ETag is refused.
    await expect(retention.set(TENANT, WS, { retentionDays: 60, confirmLowering: false, updatedBy: "usr_1" }, initial.etag))
      .rejects.toBeInstanceOf(RunRetentionStaleError);
    await expect(retention.set(TENANT, WS, { retentionDays: 60, confirmLowering: false, updatedBy: "usr_2" }, saved.etag))
      .resolves.toMatchObject({ retentionDays: 60, updatedBy: "usr_2" });
  });

  it("accepts 7 to 365 whole days only", async () => {
    const { etag } = await retention.get(TENANT, WS);
    for (const days of [6, 366, 30.5, Number.NaN]) {
      await expect(retention.set(TENANT, WS, { retentionDays: days, confirmLowering: true, updatedBy: "usr_1" }, etag))
        .rejects.toBeInstanceOf(RunRetentionValidationError);
      await expect(retention.preview(TENANT, WS, days)).rejects.toBeInstanceOf(RunRetentionValidationError);
    }
    await expect(store.withTenant(TENANT, (tx) =>
      tx.query("INSERT INTO workspace_run_retention(tenant_id,workspace_id,retention_days,updated_by) VALUES ($1,$2,6,'x')", [TENANT, WS]),
    )).rejects.toThrow(/workspace_run_retention_days_range/);
  });

  it("the daily sweep deletes each workspace's finished runs past its window, with dependents, and nothing else", async () => {
    await seed(TENANT, WS, [
      { id: "run_a_5", ageDays: 5 },
      { id: "run_a_40", ageDays: 40, status: "failed" },
      { id: "run_a_41_running", ageDays: 41, status: "running" },
      { id: "run_a_50_deployed", ageDays: 50 },
      { id: "run_a_60_evaluation", ageDays: 60 },
    ]);
    await seed(TENANT, WS_OTHER, [{ id: "run_b_40", ageDays: 40 }, { id: "run_b_400", ageDays: 400, status: "cancelled" }]);
    await seed(OTHER_TENANT, WS, [{ id: "run_c_400", ageDays: 400 }]);
    await store.withTenant(TENANT, async (tx) => {
      await tx.query("INSERT INTO workspace_run_retention(tenant_id,workspace_id,retention_days,updated_by) VALUES ($1,$2,30,'usr_1')", [TENANT, WS]);
      await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES ('prj_1',$1,$2,'p')", [TENANT, WS]);
      await tx.query("INSERT INTO artifacts(id,tenant_id,run_id,storage_reference,content_type,size_bytes) VALUES ('art_1',$1,'run_a_50_deployed','s3://x','text/plain',1)", [TENANT]);
      await tx.query("INSERT INTO deployments(id,tenant_id,project_id,artifact_id) VALUES ('dep_1',$1,'prj_1','art_1')", [TENANT]);
      await tx.query("UPDATE workflow_versions SET evaluation_run_id = 'run_a_60_evaluation' WHERE tenant_id = $1 AND workflow_id = $2", [TENANT, `wf_${TENANT.slice(-2)}${WS.slice(-4)}`]);
    });

    await expect(store.withTenant(TENANT, (tx) => sweepRunHistory(tx, TENANT))).resolves.toBe(2);

    // WS keeps 30 days: run_a_40 goes; running, deployed and evaluation runs stay.
    // WS_OTHER has no setting, so 365 days: only run_b_400 goes.
    expect(await runIds(TENANT)).toEqual(["run_a_41_running", "run_a_5", "run_a_50_deployed", "run_a_60_evaluation", "run_b_40"]);
    expect(await runIds(OTHER_TENANT)).toEqual(["run_c_400"]);
    const orphans = await store.withTenant(TENANT, async (tx) =>
      (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM node_executions WHERE tenant_id = $1 AND run_id IN ('run_a_40','run_b_400')", [TENANT])).rows[0]!.n,
    );
    expect(orphans).toBe(0);
  });

  it("runs as part of the engine's existing daily retention policy", async () => {
    await seed(TENANT, WS, [{ id: "run_a_400", ageDays: 400 }, { id: "run_a_5", ageDays: 5 }]);
    const deletion = new OrchestrationDeletionService(store as never, store as never);
    const result = await deletion.applyTenantRetentionPolicy(`ten_${TENANT}`);
    expect(result.deletedRows).toBeGreaterThanOrEqual(1);
    expect(await runIds(TENANT)).toEqual(["run_a_5"]);
  });
});
