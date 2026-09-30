import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { CompiledDag } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RunEstimateService } from "./run-estimate.service";
import type { RunEstimatesLedger, WorstCaseRunCostEstimator } from "./worst-case-run-cost-estimator";
import type { OrchestrationTenantStore } from "../runs/run-launcher.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const scoped = (tenant: string, workflow: string) => `${workflow}_${tenant === TENANT ? "a" : "b"}`;
const runId = (n: number) => `run_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;

// D4: which runs count as "the last five verified runs of this workflow", on a real orchestration_db.
describe.sequential("RunEstimateService history query", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  const runsAverage = vi.fn(async () => ({ averageBillableMinor: 100, runCount: 5 }));
  const service = () =>
    new RunEstimateService(
      store as unknown as OrchestrationTenantStore,
      { previewRun: async () => ({ workspaceId: WORKSPACE, compiledDag: { nodes: [] } as unknown as CompiledDag }) },
      { estimate: async () => ({ billableMinor: 10, modelCalls: 1, unpricedCalls: 0 }) } as unknown as WorstCaseRunCostEstimator,
      { worstCase: vi.fn(), runsAverage } as unknown as RunEstimatesLedger,
    );

  const seedRun = (tenant: string, workflow: string, n: number, verdict: string, decidedMinutesAgo: number) =>
    store.withTenant(tenant, async (tx) => {
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id) VALUES ($1,$2,$3,'workflow',$4)", [runId(n), tenant, WORKSPACE, scoped(tenant, workflow)]);
      await tx.query(
        `INSERT INTO run_outcomes (id, tenant_id, workspace_id, run_id, mode, eligible, verdict, human_rescue, critical_external_error,
                                   gates_passed, gates_failed, recovery_count, human_repair_after_complete, decided_at)
         VALUES ($1,$2,$3,$4,'workflow',true,$5,false,false,0,0,0,NULL, now() - ($6::int * interval '1 minute'))`,
        [randomUUID(), tenant, WORKSPACE, runId(n), verdict, decidedMinutesAgo],
      );
    });

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    for (const tenant of [TENANT, OTHER_TENANT]) {
      for (const workflow of ["wf_est", "wf_other"]) {
        await store.withTenant(tenant, (tx) =>
          tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'w')", [scoped(tenant, workflow), tenant, WORKSPACE]),
        );
      }
    }
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("takes the five newest verified runs of this workflow and no others", async () => {
    // seven verified (1 oldest ... 7 newest), one failed, one other workflow's, one other tenant's
    for (let n = 1; n <= 7; n += 1) await seedRun(TENANT, "wf_est", n, "completed_verified", 100 - n);
    await seedRun(TENANT, "wf_est", 8, "failed", 1);
    await seedRun(TENANT, "wf_other", 9, "completed_verified", 1);
    await seedRun(OTHER_TENANT, "wf_est", 10, "completed_verified", 1);

    const result = await service().estimate(`ten_${TENANT}`, WORKSPACE, "wf_est_a");

    expect(result).toMatchObject({ at_most_minor: 10, usually_minor: 100, sample_runs: 5 });
    expect(runsAverage).toHaveBeenCalledWith({
      tenantId: `ten_${TENANT}`,
      workspaceId: `ws_${WORKSPACE}`,
      runIds: [runId(7), runId(6), runId(5), runId(4), runId(3)],
    });
  });

  it("with fewer than five verified runs the average is never asked for", async () => {
    runsAverage.mockClear();
    const result = await service().estimate(`ten_${OTHER_TENANT}`, WORKSPACE, "wf_other_b");
    expect(result).toMatchObject({ usually_minor: null, sample_runs: 0 });
    expect(runsAverage).not.toHaveBeenCalled();
  });
});
