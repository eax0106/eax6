import { describe, expect, it, vi } from "vitest";

import {
  RunOutcomeNotCompletedError,
  RunOutcomeRunNotFoundError,
  RunOutcomeService,
  RunOutcomeValidationError,
  type RunOutcomeTenantStore,
  type RunOutcomeTransaction,
} from "./run-outcome.service";

const TENANT_ID = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const BARE_TENANT_ID = TENANT_ID.slice("ten_".length);
const RUN_ID = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE_ID = "018f47a5-7b2c-7d10-8f11-000000000001";
const WORKFLOW_VERSION_ID = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";

interface FakeDb {
  runs: { workspace_id: string; parent_kind: string; workflow_version_id: string | null; status: string } | undefined;
  workflowVersionStatus: string | undefined;
  verificationResults: readonly { verdict: string }[];
  recoveryActions: readonly { strategy: string | null; outcome: string | null }[];
  inserted: Record<string, unknown> | undefined;
}

function fakeStore(db: FakeDb): RunOutcomeTenantStore {
  return {
    async withTenant<T>(
      tenantId: string,
      operation: (tx: {
        query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
      }) => Promise<T>,
    ): Promise<T> {
      expect(tenantId).toBe(BARE_TENANT_ID);
      return operation({
        query: (async (sql: string, values: readonly unknown[] = []) => {
          if (sql.includes("FROM runs WHERE")) {
            return db.runs === undefined
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [db.runs] };
          }
          if (sql.includes("FROM workflow_versions")) {
            return db.workflowVersionStatus === undefined
              ? { rowCount: 0, rows: [] }
              : { rowCount: 1, rows: [{ status: db.workflowVersionStatus }] };
          }
          if (sql.includes("FROM verification_results") && sql.includes("GROUP BY verdict")) {
            const counts = new Map<string, number>();
            for (const r of db.verificationResults) {
              counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
            }
            return {
              rowCount: counts.size,
              rows: [...counts.entries()].map(([verdict, count]) => ({
                verdict,
                count: String(count),
              })),
            };
          }
          if (sql.includes("FROM verification_results") && sql.includes("gate_type = 'safety'")) {
            const hasCriticalFailure = db.verificationResults.some(
              (r) => r.verdict === "fail",
            );
            return { rowCount: hasCriticalFailure ? 1 : 0, rows: [] };
          }
          if (sql.includes("FROM recovery_actions")) {
            return { rowCount: db.recoveryActions.length, rows: [...db.recoveryActions] };
          }
          if (sql.includes("INSERT INTO run_outcomes")) {
            db.inserted = {
              tenantId: values[1],
              workspaceId: values[2],
              runId: values[3],
              mode: values[4],
              eligible: values[5],
              verdict: values[6],
              humanRescue: values[7],
              criticalExternalError: values[8],
              gatesPassed: values[9],
              gatesFailed: values[10],
              recoveryCount: values[11],
            };
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes("FROM run_outcomes WHERE")) {
            return db.inserted === undefined
              ? { rowCount: 0, rows: [] }
              : {
                  rowCount: 1,
                  rows: [{ verdict: db.inserted["verdict"], decided_at: "2026-09-28T10:00:00.000Z" }],
                };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as RunOutcomeTransaction["query"],
      });
    },
  };
}

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    runs: {
      workspace_id: WORKSPACE_ID,
      parent_kind: "workflow",
      workflow_version_id: WORKFLOW_VERSION_ID,
      status: "completed",
    },
    workflowVersionStatus: "promoted",
    verificationResults: [],
    recoveryActions: [],
    inserted: undefined,
    ...overrides,
  };
}

describe("RunOutcomeService budget settlement (D3)", () => {
  it("settles the run's budgets after recording the outcome, with the run's own workspace", async () => {
    const settle = vi.fn(async () => undefined);
    const service = new RunOutcomeService(fakeStore(baseDb()), undefined, { settle });
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");
    expect(settle).toHaveBeenCalledWith({ tenantId: BARE_TENANT_ID, workspaceId: WORKSPACE_ID, runId: RUN_ID });
  });

  it("a settlement failure never fails the run's finalization", async () => {
    const db = baseDb();
    const service = new RunOutcomeService(fakeStore(db), undefined, { settle: async () => { throw new Error("ledger down"); } });
    await expect(service.recordOutcome(TENANT_ID, RUN_ID, "failed")).resolves.toBeUndefined();
    expect(db.inserted).toMatchObject({ runId: RUN_ID });
  });
});

describe("RunOutcomeService.recordOutcome", () => {
  it("rejects a tenant_id without the ten_ prefix", async () => {
    const service = new RunOutcomeService(fakeStore(baseDb()));
    await expect(
      service.recordOutcome(BARE_TENANT_ID, RUN_ID, "completed"),
    ).rejects.toBeInstanceOf(RunOutcomeValidationError);
  });

  it("rejects a run_id without the run_ prefix", async () => {
    const service = new RunOutcomeService(fakeStore(baseDb()));
    await expect(
      service.recordOutcome(TENANT_ID, "not-a-run-id", "completed"),
    ).rejects.toBeInstanceOf(RunOutcomeValidationError);
  });

  it("throws RunOutcomeRunNotFoundError when the run does not exist", async () => {
    const service = new RunOutcomeService(fakeStore(baseDb({ runs: undefined })));
    await expect(
      service.recordOutcome(TENANT_ID, RUN_ID, "completed"),
    ).rejects.toBeInstanceOf(RunOutcomeRunNotFoundError);
  });

  it("clean completed run with no recovery -> completed_verified, eligible", async () => {
    const db = baseDb({
      verificationResults: [{ verdict: "pass" }, { verdict: "pass" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({
      verdict: "completed_verified",
      eligible: true,
      gatesPassed: 2,
      gatesFailed: 0,
      recoveryCount: 0,
      humanRescue: false,
      criticalExternalError: false,
    });
  });

  it("completed run with a resolved recovery -> rescued", async () => {
    const db = baseDb({
      recoveryActions: [{ strategy: "escalate_model", outcome: "resolved" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ verdict: "rescued", recoveryCount: 1 });
  });

  it("completed run with a resolved degrade -> degraded (takes priority over rescued)", async () => {
    const db = baseDb({
      recoveryActions: [
        { strategy: "escalate_model", outcome: "resolved" },
        { strategy: "degrade", outcome: "resolved" },
      ],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ verdict: "degraded" });
  });

  it("failed run with an unresolved ask_user escalation -> escalated", async () => {
    const db = baseDb({
      recoveryActions: [{ strategy: "ask_user", outcome: "escalated" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "failed");

    expect(db.inserted).toMatchObject({ verdict: "escalated" });
  });

  it("failed run with no unresolved escalation -> failed", async () => {
    const db = baseDb({
      recoveryActions: [{ strategy: "retry", outcome: "escalated" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "failed");

    expect(db.inserted).toMatchObject({ verdict: "failed" });
  });

  it("cancelled run -> abandoned, regardless of recovery history", async () => {
    const db = baseDb({
      recoveryActions: [{ strategy: "retry", outcome: "escalated" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "cancelled");

    expect(db.inserted).toMatchObject({ verdict: "abandoned" });
  });

  it("human_rescue is true only for a resolved ask_user recovery", async () => {
    const db = baseDb({
      recoveryActions: [{ strategy: "ask_user", outcome: "resolved" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ humanRescue: true });
  });

  it("critical_external_error true when a safety verification failure was recorded", async () => {
    const db = baseDb({
      verificationResults: [{ verdict: "fail" }],
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ criticalExternalError: true });
  });

  it.each(["compiled", "canary", "retired"])(
    "not eligible when workflow_version status is %s",
    async (status) => {
      const db = baseDb({ workflowVersionStatus: status });
      const service = new RunOutcomeService(fakeStore(db));
      await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

      expect(db.inserted).toMatchObject({ eligible: false });
    },
  );

  it("eligible when workflow_version status is rolled_back (was promoted at some point)", async () => {
    const db = baseDb({ workflowVersionStatus: "rolled_back" });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ eligible: true });
  });

  it("not eligible when the run has no workflow_version_id at all", async () => {
    const db = baseDb({
      runs: { workspace_id: WORKSPACE_ID, parent_kind: "workflow", workflow_version_id: null, status: "completed" },
    });
    const service = new RunOutcomeService(fakeStore(db));
    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(db.inserted).toMatchObject({ eligible: false });
  });
});

describe("RunOutcomeService.getByRunId", () => {
  it("rejects a run_id without the run_ prefix", async () => {
    const service = new RunOutcomeService(fakeStore(baseDb()));
    await expect(service.getByRunId(TENANT_ID, "bad-id")).rejects.toBeInstanceOf(
      RunOutcomeValidationError,
    );
  });

  it("returns undefined when no outcome has been recorded yet", async () => {
    const store: RunOutcomeTenantStore = {
      async withTenant(tenantId, operation) {
        expect(tenantId).toBe(BARE_TENANT_ID);
        return operation({
          query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
        });
      },
    };
    const service = new RunOutcomeService(store);
    await expect(service.getByRunId(TENANT_ID, RUN_ID)).resolves.toBeUndefined();
  });
});

describe("RunOutcomeService.getLearningSummary", () => {
  function learningStore(status = "failed", withOutcome = true): RunOutcomeTenantStore {
    return {
      async withTenant(tenantId, operation) {
        expect(tenantId).toBe(BARE_TENANT_ID);
        return operation({
          query: vi.fn(async (sql: string) => {
            if (sql.includes("FROM runs WHERE")) {
              return {
                rowCount: 1,
                rows: [{
                  workspace_id: WORKSPACE_ID,
                  parent_kind: "workflow",
                  workflow_version_id: WORKFLOW_VERSION_ID,
                  status,
                }],
              };
            }
            if (sql.includes("FROM run_outcomes")) {
              return withOutcome
                ? {
                    rowCount: 1,
                    rows: [{
                      run_id: RUN_ID,
                      mode: "workflow",
                      eligible: true,
                      verdict: "failed",
                      human_rescue: false,
                      critical_external_error: false,
                      gates_passed: 2,
                      gates_failed: 1,
                      recovery_count: 1,
                      human_repair_after_complete: null,
                      decided_at: "2026-07-29T00:00:00.000Z",
                    }],
                  }
                : { rowCount: 0, rows: [] };
            }
            if (sql.includes("FROM node_executions")) {
              return {
                rowCount: 1,
                rows: [{
                  node_execution_id: "node_a",
                  node_key: "publish",
                  node_type: "ToolCall",
                  status: "failed",
                  attempt: 2,
                  input_ref: "research",
                  output_ref: null,
                  error_code: "TOOL_PERMISSION_DENIED",
                }],
              };
            }
            if (sql.includes("FROM recovery_actions")) {
              return {
                rowCount: 1,
                rows: [{
                  node_execution_id: "node_a",
                  failure_class: "tool_permission_denial",
                  strategy: "ask_user",
                  outcome: "escalated",
                }],
              };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          }) as unknown as RunOutcomeTransaction["query"],
        });
      },
    };
  }

  it("returns the real outcome, node, and recovery projection", async () => {
    const summary = await new RunOutcomeService(learningStore()).getLearningSummary(
      TENANT_ID,
      RUN_ID,
    );

    expect(summary).toEqual({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      workspace_id: `ws_${WORKSPACE_ID}`,
      verdict: "failed",
      gates_passed: 2,
      gates_failed: 1,
      recovery_count: 1,
      nodes: [expect.objectContaining({ node_key: "publish", attempt: 2 })],
      recovery_actions: [
        expect.objectContaining({ strategy: "ask_user", outcome: "escalated" }),
      ],
    });
  });

  it.each([
    ["running", true],
    ["failed", false],
  ] as const)(
    "rejects a run without a completed outcome (status=%s, outcome=%s)",
    async (status, withOutcome) => {
      await expect(
        new RunOutcomeService(learningStore(status, withOutcome)).getLearningSummary(
          TENANT_ID,
          RUN_ID,
        ),
      ).rejects.toBeInstanceOf(RunOutcomeNotCompletedError);
    },
  );
});

// C5, design log §21 / §22 item 10: each recorded outcome's verdict goes to
// the Cost Ledger, and a ledger outage never fails the run's finalization.
describe("RunOutcomeService.recordOutcome sends the verdict to the Cost Ledger", () => {
  it("sends the stored verdict with its decision time", async () => {
    const recordRunVerdict = vi.fn().mockResolvedValue({ recorded: true });
    const service = new RunOutcomeService(fakeStore(baseDb()), { recordRunVerdict });

    await service.recordOutcome(TENANT_ID, RUN_ID, "completed");

    expect(recordRunVerdict).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      run_id: RUN_ID,
      verdict: "completed_verified",
      decided_at: "2026-09-28T10:00:00.000Z",
    });
  });

  it("still records the outcome when the ledger is unreachable", async () => {
    const db = baseDb();
    const recordRunVerdict = vi.fn().mockRejectedValue(new Error("cost ledger unavailable"));
    const service = new RunOutcomeService(fakeStore(db), { recordRunVerdict });

    await expect(service.recordOutcome(TENANT_ID, RUN_ID, "failed")).resolves.toBeUndefined();
    expect(db.inserted).toMatchObject({ verdict: "failed" });
  });
});
