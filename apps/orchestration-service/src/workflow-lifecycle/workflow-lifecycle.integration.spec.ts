import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";

import {
  WorkflowLifecycleService,
  DeploymentNotFoundError,
  DeploymentStateTransitionError,
} from "./workflow-lifecycle.service";
import type { EvalFacadeService } from "../eval-facade/eval-facade.service";

// promoteVersion/startCanary gate on a real release-gate check
// (59ad276) -- this suite exercises the Postgres-backed state machine, not
// the gate itself, so this fake always passes.
const PASSING_EVAL_FACADE: EvalFacadeService = {
  runEvaluation: async () => ({
    evaluation_run_id: "evr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    status: "completed",
    results_json: "{}",
  }),
  checkReleaseGate: async () => ({ passed: true, failed_thresholds: [] }),
} as unknown as EvalFacadeService;

const FAILING_EVAL_FACADE: EvalFacadeService = {
  ...PASSING_EVAL_FACADE,
  checkReleaseGate: async () => ({ passed: false, failed_thresholds: ["workflow E2E"] }),
} as unknown as EvalFacadeService;

const migrationsFolder = resolve(
  process.cwd(),
  "apps/orchestration-service/drizzle",
);
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const TENANT_A_REQUEST = `ten_${TENANT_A}`;
const WORKSPACE_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const WORKSPACE_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const WORKFLOW_A = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const WORKFLOW_B = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890b3";
const VERSION_1 = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
const VERSION_2 = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890a5";
const VERSION_3 = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890a6";
const VERSION_B = "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890b4";

type VersionStatus =
  | "compiled"
  | "tested"
  | "canary"
  | "promoted"
  | "rolled_back"
  | "retired";

interface SeedVersion {
  readonly id: string;
  readonly status: VersionStatus;
  readonly trafficPercent?: number;
}

interface StoredVersion extends Record<string, unknown> {
  readonly id: string;
  readonly status: VersionStatus;
  readonly traffic_percent: number | null;
}

interface EvidenceVersion extends Record<string, unknown> {
  readonly status: VersionStatus;
  readonly evaluation_run_id: string | null;
  readonly tested_at: Date | null;
  readonly evaluation_failed_at: Date | null;
}

describe.sequential("WorkflowLifecycleService Postgres integration", () => {
  let container: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let service: WorkflowLifecycleService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("workflow_lifecycle_test")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: container.getConnectionUri(),
      migrationsFolder,
    });
    await store.migrate();
    service = new WorkflowLifecycleService(store, PASSING_EVAL_FACADE);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await store.withTenant(tenantId, async (tx) => {
        await tx.query("DELETE FROM workflow_versions WHERE tenant_id = $1", [
          tenantId,
        ]);
        await tx.query("DELETE FROM workflows WHERE tenant_id = $1", [tenantId]);
      });
    }
  });

  async function seedWorkflow(
    tenantId: string,
    workspaceId: string,
    workflowId: string,
    versions: readonly SeedVersion[],
  ): Promise<void> {
    await store.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO workflows (id, tenant_id, workspace_id, name)
         VALUES ($1, $2, $3, 'Deployment test workflow')`,
        [workflowId, tenantId, workspaceId],
      );
      for (const [index, version] of versions.entries()) {
        await tx.query(
          `INSERT INTO workflow_versions
             (id, tenant_id, workflow_id, version, compiled_dag,
              dag_schema_version, status, traffic_percent, evaluation_run_id, tested_at)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, 'v1', $5, $6, $7, $8)`,
          [
            version.id,
            tenantId,
            workflowId,
            index + 1,
            version.status,
            version.trafficPercent ?? null,
            version.status === "tested" ? "evr_seed" : null,
            version.status === "tested" ? new Date() : null,
          ],
        );
      }
    });
  }

  async function storedVersions(
    tenantId = TENANT_A,
    workflowId = WORKFLOW_A,
  ): Promise<readonly StoredVersion[]> {
    return store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<StoredVersion>(
        `SELECT id, status, traffic_percent
         FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2
         ORDER BY version`,
        [tenantId, workflowId],
      );
      return result.rows;
    });
  }

  async function storedEvidence(versionId: string): Promise<EvidenceVersion> {
    return store.withTenant(TENANT_A, async (tx) => {
      const result = await tx.query<EvidenceVersion>(
        `SELECT status, evaluation_run_id, tested_at, evaluation_failed_at
         FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3`,
        [TENANT_A, WORKFLOW_A, versionId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Expected workflow version");
      return row;
    });
  }

  async function deployMarks() {
    return store.withTenant(TENANT_A, async (tx) => {
      const result = await tx.query<{ id: string; kind: string | null; stamp: Date | null }>(
        "SELECT id, last_deploy_kind AS kind, last_deployed_at AS stamp FROM workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY version", [TENANT_A, WORKFLOW_A],
      );
      return result.rows;
    });
  }

  const databaseClock = async () => store.withTenant(TENANT_A, async (tx) => {
    const result = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    return result.rows[0]!.now.getTime();
  });

  it("promotes atomically and marks routine supersession retired", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "promoted" },
      { id: VERSION_2, status: "canary", trafficPercent: 10 },
    ]);

    // Read the clock that records the timestamp: Docker's database clock can
    // differ from the host clock even though promotion is correct.
    const databaseNow = async () => store.withTenant(TENANT_A, async (tx) => {
      const result = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      return result.rows[0]!.now.getTime();
    });
    const startedAt = await databaseNow();
    const result = await service.promoteVersion({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
    });

    expect(result.status).toBe("promoted");
    expect(new Date(result.promoted_at).toISOString()).toBe(result.promoted_at);
    expect(new Date(result.promoted_at).getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(new Date(result.promoted_at).getTime()).toBeLessThanOrEqual(await databaseNow());
    expect(await storedVersions()).toEqual([
      { id: VERSION_1, status: "retired", traffic_percent: null },
      { id: VERSION_2, status: "promoted", traffic_percent: null },
    ]);
    const marks = await deployMarks();
    expect(marks[0]).toEqual({ id: VERSION_1, kind: null, stamp: null });
    expect(marks[1]?.kind).toBe("promoted");
    expect(marks[1]?.stamp?.getTime()).toBeGreaterThanOrEqual(startedAt);
    expect(marks[1]?.stamp?.getTime()).toBeLessThanOrEqual(await databaseClock());
  });

  it("persists canary traffic while leaving the stable version promoted", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "promoted" },
      { id: VERSION_2, status: "tested" },
    ]);

    await expect(
      service.startCanary({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        workflow_version_id: VERSION_2,
        traffic_percent: 20,
      }),
    ).resolves.toEqual({ status: "canary", traffic_percent: 20 });
    expect(await storedVersions()).toEqual([
      { id: VERSION_1, status: "promoted", traffic_percent: null },
      { id: VERSION_2, status: "canary", traffic_percent: 20 },
    ]);
  });

  it("rejects a second canary so traffic routing stays unambiguous", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "promoted" },
      { id: VERSION_2, status: "canary", trafficPercent: 20 },
      { id: VERSION_3, status: "tested" },
    ]);

    await expect(
      service.startCanary({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        workflow_version_id: VERSION_3,
        traffic_percent: 10,
      }),
    ).rejects.toThrow(DeploymentStateTransitionError);
    expect(await storedVersions()).toEqual([
      { id: VERSION_1, status: "promoted", traffic_percent: null },
      { id: VERSION_2, status: "canary", traffic_percent: 20 },
      { id: VERSION_3, status: "tested", traffic_percent: null },
    ]);
  });

  it("distinguishes incident rollback from routine retirement", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "retired" },
      { id: VERSION_2, status: "promoted" },
    ]);

    const previousStamp = "2026-09-29T10:00:00.000Z";
    await store.withTenant(TENANT_A, async (tx) => {
      await tx.query("UPDATE workflow_versions SET last_deployed_at=$1,last_deploy_kind='promoted' WHERE tenant_id=$2 AND id=$3", [previousStamp, TENANT_A, VERSION_2]);
    });
    const beforeRollback = await databaseClock();

    await expect(
      service.rollbackVersion({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        target_version_id: VERSION_1,
      }),
    ).resolves.toEqual({
      status: "rolled_back",
      active_version_id: VERSION_1,
    });
    expect(await storedVersions()).toEqual([
      { id: VERSION_1, status: "promoted", traffic_percent: null },
      { id: VERSION_2, status: "rolled_back", traffic_percent: null },
    ]);
    const marks = await deployMarks();
    expect(marks[0]?.kind).toBe("restored");
    expect(marks[0]?.stamp?.getTime()).toBeGreaterThanOrEqual(beforeRollback);
    expect(marks[0]?.stamp?.getTime()).toBeLessThanOrEqual(await databaseClock());
    expect(marks[1]).toEqual({ id: VERSION_2, kind: "promoted", stamp: new Date(previousStamp) });
  });

  it("rejects illegal retired promotion and canary rollback target transitions", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "retired" },
      { id: VERSION_2, status: "promoted" },
      { id: VERSION_3, status: "canary", trafficPercent: 10 },
    ]);

    await expect(
      service.promoteVersion({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        workflow_version_id: VERSION_1,
      }),
    ).rejects.toThrow(DeploymentStateTransitionError);
    await expect(
      service.rollbackVersion({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        target_version_id: VERSION_3,
      }),
    ).rejects.toThrow(DeploymentStateTransitionError);
  });

  it("cannot read or mutate another tenant's workflow version", async () => {
    await seedWorkflow(TENANT_B, WORKSPACE_B, WORKFLOW_B, [
      { id: VERSION_B, status: "compiled" },
    ]);

    await expect(
      service.promoteVersion({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_B,
        workflow_version_id: VERSION_B,
      }),
    ).rejects.toThrow(DeploymentNotFoundError);
    expect(await storedVersions(TENANT_B, WORKFLOW_B)).toEqual([
      { id: VERSION_B, status: "compiled", traffic_percent: null },
    ]);
  });

  it("allows exactly one concurrent canary allocation", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "promoted" },
      { id: VERSION_2, status: "tested" },
      { id: VERSION_3, status: "tested" },
    ]);

    const results = await Promise.allSettled([
      service.startCanary({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        workflow_version_id: VERSION_2,
        traffic_percent: 10,
      }),
      service.startCanary({
        tenant_id: TENANT_A_REQUEST,
        workflow_id: WORKFLOW_A,
        workflow_version_id: VERSION_3,
        traffic_percent: 20,
      }),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const versions = await storedVersions();
    expect(versions.filter((version) => version.status === "canary")).toHaveLength(1);
  });

  it("persists passing evaluation evidence before making a version tested", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_2, status: "compiled" },
    ]);

    await expect(service.testVersion({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
    })).resolves.toEqual({ status: "tested" });

    const evidence = await storedEvidence(VERSION_2);
    expect(evidence.status).toBe("tested");
    expect(evidence.evaluation_run_id).toBe("evr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab");
    expect(evidence.tested_at).toBeInstanceOf(Date);
    expect(evidence.evaluation_failed_at).toBeNull();
  });

  it("persists failed evaluation evidence and leaves the version ineligible", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_2, status: "compiled" },
    ]);
    const failingService = new WorkflowLifecycleService(store, FAILING_EVAL_FACADE);

    await expect(failingService.testVersion({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
    })).rejects.toThrow();

    const evidence = await storedEvidence(VERSION_2);
    expect(evidence.status).toBe("compiled");
    expect(evidence.evaluation_run_id).toBe("evr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab");
    expect(evidence.tested_at).toBeNull();
    expect(evidence.evaluation_failed_at).toBeInstanceOf(Date);
    await expect(service.startCanary({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
      traffic_percent: 10,
    })).rejects.toThrow(DeploymentStateTransitionError);
  });

  it("enforces tested evidence in Postgres", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_2, status: "compiled" },
    ]);

    await expect(store.withTenant(TENANT_A, async (tx) => tx.query(
      "UPDATE workflow_versions SET status = 'tested' WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3",
      [TENANT_A, WORKFLOW_A, VERSION_2],
    ))).rejects.toMatchObject({ code: "23514" });
  });

  it("requires test before canary and promotion, then supports full rollback", async () => {
    await seedWorkflow(TENANT_A, WORKSPACE_A, WORKFLOW_A, [
      { id: VERSION_1, status: "promoted" },
      { id: VERSION_2, status: "compiled" },
    ]);

    await expect(service.startCanary({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
      traffic_percent: 10,
    })).rejects.toThrow(DeploymentStateTransitionError);
    await expect(service.promoteVersion({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      workflow_version_id: VERSION_2,
    })).rejects.toThrow(DeploymentStateTransitionError);

    await service.testVersion({ tenant_id: TENANT_A_REQUEST, workflow_id: WORKFLOW_A, workflow_version_id: VERSION_2 });
    await service.startCanary({ tenant_id: TENANT_A_REQUEST, workflow_id: WORKFLOW_A, workflow_version_id: VERSION_2, traffic_percent: 10 });
    await service.promoteVersion({ tenant_id: TENANT_A_REQUEST, workflow_id: WORKFLOW_A, workflow_version_id: VERSION_2 });
    await expect(service.rollbackVersion({
      tenant_id: TENANT_A_REQUEST,
      workflow_id: WORKFLOW_A,
      target_version_id: VERSION_1,
    })).resolves.toEqual({ status: "rolled_back", active_version_id: VERSION_1 });
  });
});
