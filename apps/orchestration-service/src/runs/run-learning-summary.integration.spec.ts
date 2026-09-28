import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RunOutcomeNotCompletedError,
  RunOutcomeRunNotFoundError,
  RunOutcomeTenantMismatchError,
  RunOutcomeService,
} from "./run-outcome.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890bb";
const TENANT_REQUEST = `ten_${TENANT}`;
const OTHER_TENANT_REQUEST = `ten_${OTHER_TENANT}`;
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890ac";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ad";
const PENDING_RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890bd";
const NODE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ae";

describe.sequential("KNOW-13 run learning summary", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let service: RunOutcomeService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: postgres.getConnectionUri(),
      migrationsFolder,
    });
    await store.migrate();
    service = new RunOutcomeService(store);

    await store.withTenant(TENANT, async (tx) => {
      await tx.query(
        `INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, status, ended_at)
         VALUES ($1, $2, $3, 'workflow', 'failed', clock_timestamp()),
                ($4, $2, $3, 'workflow', 'running', NULL)`,
        [RUN, TENANT, WORKSPACE, PENDING_RUN],
      );
      await tx.query(
        `INSERT INTO node_executions
           (id, tenant_id, run_id, dag_node_id, node_type, attempt, status,
            input_ref, output_ref, error, ended_at)
         VALUES ($1, $2, $3, 'publish', 'ToolCall', 3, 'failed',
                 'research', NULL, '{"code":"TOOL_PERMISSION_DENIED","detail":"redacted"}',
                 clock_timestamp())`,
        [NODE, TENANT, RUN],
      );
      await tx.query(
        `INSERT INTO recovery_actions
           (id, tenant_id, run_id, node_execution_id, failure_class, strategy,
            policy_version, outcome)
         VALUES ('rca_018f4d6e-2b4a-7a3e-8c1a-1234567890af', $1, $2, $3,
                 'tool_permission_denial', 'ask_user', 'v1', 'escalated')`,
        [TENANT, RUN, NODE],
      );
      await tx.query(
        `INSERT INTO run_outcomes
           (id, tenant_id, workspace_id, run_id, mode, eligible, verdict,
            human_rescue, critical_external_error, gates_passed, gates_failed,
            recovery_count, decided_at)
         VALUES ('018f4d6e-2b4a-7a3e-8c1a-1234567890f0', $1, $2, $3,
                 'workflow', true, 'failed', false, false, 2, 1, 1,
                 clock_timestamp())`,
        [TENANT, WORKSPACE, RUN],
      );
    });
  }, 90_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop({ remove: false });
  }, 60_000);

  it("reads seeded run_outcomes, node_executions, and recovery_actions", async () => {
    const summary = await service.getLearningSummary(TENANT_REQUEST, RUN);
    expect(summary).toMatchObject({
      tenant_id: TENANT_REQUEST,
      run_id: RUN,
      workspace_id: `ws_${WORKSPACE}`,
      verdict: "failed",
      gates_passed: 2,
      gates_failed: 1,
      recovery_count: 1,
      nodes: [{
        node_execution_id: NODE,
        node_key: "publish",
        status: "failed",
        attempt: 3,
        error_code: "TOOL_PERMISSION_DENIED",
      }],
      recovery_actions: [{
        node_execution_id: NODE,
        failure_class: "tool_permission_denial",
        strategy: "ask_user",
        outcome: "escalated",
      }],
    });
  });

  it("distinguishes incomplete and tenant-invisible runs", async () => {
    await expect(
      service.getLearningSummary(TENANT_REQUEST, PENDING_RUN),
    ).rejects.toBeInstanceOf(RunOutcomeNotCompletedError);
    await expect(
      service.getLearningSummary(OTHER_TENANT_REQUEST, RUN),
    ).rejects.toBeInstanceOf(RunOutcomeRunNotFoundError);
  });

  it("refuses a service-asserted tenant the run does not belong to by name (design log §30)", async () => {
    await expect(
      service.getLearningSummary(OTHER_TENANT_REQUEST, RUN, { assertedByService: true }),
    ).rejects.toBeInstanceOf(RunOutcomeTenantMismatchError);
    // The owner asserting itself still reads, and a run that exists nowhere
    // is still simply not found.
    await expect(
      service.getLearningSummary(TENANT_REQUEST, RUN, { assertedByService: true }),
    ).resolves.toMatchObject({ run_id: RUN });
    await expect(
      service.getLearningSummary(OTHER_TENANT_REQUEST, "run_018f4d6e-2b4a-7a3e-8c1a-00000000dead", {
        assertedByService: true,
      }),
    ).rejects.toBeInstanceOf(RunOutcomeRunNotFoundError);
  });
});
