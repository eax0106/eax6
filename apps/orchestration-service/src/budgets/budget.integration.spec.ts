import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrchestrationTenantStore } from "../runs/run-observability.service";
import {
  BudgetConflictError,
  BudgetExceededError,
  BudgetService,
  BudgetValidationError,
} from "./budget.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const TENANT = `ten_${BARE_TENANT}`;
const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const BARE_WORKSPACE = WORKSPACE.slice(3);
const WORKFLOW = "wf_budget";
let runCounter = 0;

// D3 (C10, design log section 22): budgets and the atomic reservation, on a real orchestration_db.
describe.sequential("Budgets", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let budgets: BudgetService;

  const newRun = async (): Promise<string> => {
    const id = `run_018f4d6e-2b4a-7a3e-8c1a-${String(++runCounter).padStart(12, "0")}`;
    await store.withTenant(BARE_TENANT, (tx) =>
      tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind) VALUES ($1,$2,$3,'workflow')", [id, BARE_TENANT, BARE_WORKSPACE]),
    );
    return id;
  };
  const reserveInOwnTransaction = async (amountMinor: number) => {
    const runId = await newRun();
    return store.withTenant(BARE_TENANT, (tx) =>
      budgets.reserve(tx, { tenantId: BARE_TENANT, workspaceId: BARE_WORKSPACE, workflowId: WORKFLOW, runId, amountMinor }),
    );
  };
  const usage = async (budgetId: string) =>
    store.withTenant(BARE_TENANT, async (tx) => {
      const rows = await tx.query<{ spent_minor: string; reserved_minor: string }>(
        "SELECT spent_minor::text, reserved_minor::text FROM budget_usage WHERE tenant_id=$1 AND budget_id=$2",
        [BARE_TENANT, budgetId],
      );
      return rows.rows[0];
    });
  const clear = () =>
    store.withTenant(BARE_TENANT, (tx) => tx.query("DELETE FROM budgets WHERE tenant_id=$1", [BARE_TENANT]));

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
    budgets = new BudgetService(store as unknown as OrchestrationTenantStore);
    await store.withTenant(BARE_TENANT, (tx) =>
      tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'w')", [WORKFLOW, BARE_TENANT, BARE_WORKSPACE]),
    );
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("creates each kind, refuses a second of the same scope and a malformed one", async () => {
    await clear();
    const workspace = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 100_000, createdBy: "usr_1" });
    expect(workspace).toMatchObject({ kind: "workspace", period: "monthly", mode: "hard", enabled: true, amount_minor: "100000" });
    await budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: WORKFLOW, kind: "workflow", period: "daily", amountMinor: 5_000, createdBy: "usr_1" });
    await budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: WORKFLOW, kind: "run_cap", amountMinor: 500, createdBy: "usr_1" });

    await expect(budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 1, createdBy: "u" })).rejects.toBeInstanceOf(BudgetConflictError);
    await expect(budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workflow", amountMinor: 1, createdBy: "u" })).rejects.toBeInstanceOf(BudgetValidationError);
    await expect(budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: WORKFLOW, kind: "run_cap", period: "daily", amountMinor: 1, createdBy: "u" })).rejects.toBeInstanceOf(BudgetValidationError);
    await expect(budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 0, createdBy: "u" })).rejects.toBeInstanceOf(BudgetValidationError);
    await expect(budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 1.5, createdBy: "u" })).rejects.toBeInstanceOf(BudgetValidationError);
    expect(await budgets.list(TENANT, WORKSPACE)).toHaveLength(3);
  });

  it("two runs starting together cannot both pass a cap: ten runs of 30 against 100 admit exactly three", async () => {
    await clear();
    const budget = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 100, createdBy: "u" });

    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => reserveInOwnTransaction(30)));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(refused).toHaveLength(7);
    for (const outcome of refused) expect(outcome.reason).toBeInstanceOf(BudgetExceededError);
    expect(await usage(budget.id)).toEqual({ spent_minor: "0", reserved_minor: "90" });
  });

  it("a refused run leaves nothing reserved anywhere (its transaction rolls back with it)", async () => {
    await clear();
    const workspace = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 1_000, createdBy: "u" });
    const workflowDaily = await budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: WORKFLOW, kind: "workflow", period: "daily", amountMinor: 50, createdBy: "u" });

    await expect(reserveInOwnTransaction(80)).rejects.toMatchObject({ budgetId: workflowDaily.id, kind: "workflow" });

    // not even a usage row survives: the whole start rolled back
    expect(await usage(workspace.id)).toBeUndefined();
    expect(await usage(workflowDaily.id)).toBeUndefined();
  });

  it("a per-run cap stops a run that could cost more than it, and a warn-only budget lets it through and says so", async () => {
    await clear();
    await budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: WORKFLOW, kind: "run_cap", amountMinor: 100, createdBy: "u" });
    await expect(reserveInOwnTransaction(101)).rejects.toMatchObject({ kind: "run_cap" });
    await expect(reserveInOwnTransaction(100)).resolves.toHaveLength(1);

    await clear();
    await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 100, mode: "warn", createdBy: "u" });
    await expect(reserveInOwnTransaction(90)).resolves.toEqual([expect.objectContaining({ mode: "warn", overCap: false })]);
    await expect(reserveInOwnTransaction(90)).resolves.toEqual([expect.objectContaining({ mode: "warn", overCap: true })]);
  });

  it("the end of the run releases the reservation and records what it really cost, once", async () => {
    await clear();
    const budget = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 1_000, createdBy: "u" });
    const runId = await newRun();
    await store.withTenant(BARE_TENANT, (tx) =>
      budgets.reserve(tx, { tenantId: BARE_TENANT, workspaceId: BARE_WORKSPACE, workflowId: WORKFLOW, runId, amountMinor: 400 }),
    );
    expect(await usage(budget.id)).toEqual({ spent_minor: "0", reserved_minor: "400" });

    expect(await budgets.settle(TENANT, runId, 120)).toBe(1);
    expect(await usage(budget.id)).toEqual({ spent_minor: "120", reserved_minor: "0" });
    expect(await budgets.settle(TENANT, runId, 120)).toBe(0);
    expect(await usage(budget.id)).toEqual({ spent_minor: "120", reserved_minor: "0" });

    // what it spent counts against the next run
    await expect(reserveInOwnTransaction(900)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(reserveInOwnTransaction(880)).resolves.toHaveLength(1);
  });

  it("a disabled budget binds nothing; another workspace's and another workflow's budgets do not apply", async () => {
    await clear();
    const workspace = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 10, createdBy: "u" });
    await budgets.update(TENANT, WORKSPACE, workspace.id, { enabled: false });
    await expect(reserveInOwnTransaction(1_000)).resolves.toEqual([]);

    await budgets.update(TENANT, WORKSPACE, workspace.id, { enabled: true, amountMinor: 5_000 });
    await store.withTenant(BARE_TENANT, (tx) =>
      tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ('wf_other',$1,$2,'o') ON CONFLICT DO NOTHING", [BARE_TENANT, BARE_WORKSPACE]),
    );
    await budgets.create(TENANT, { workspaceId: WORKSPACE, workflowId: "wf_other", kind: "run_cap", amountMinor: 1, createdBy: "u" });
    await expect(reserveInOwnTransaction(1_000)).resolves.toHaveLength(1);
    expect(await budgets.list(`ten_${OTHER_TENANT}`, WORKSPACE)).toEqual([]);
  });

  it("changes the cap and mode, deletes a budget, and reports one that is not there", async () => {
    await clear();
    const created = await budgets.create(TENANT, { workspaceId: WORKSPACE, kind: "workspace", amountMinor: 100, createdBy: "u" });
    expect(await budgets.update(TENANT, WORKSPACE, created.id, { amountMinor: 250, mode: "warn" })).toMatchObject({ amount_minor: "250", mode: "warn" });
    await expect(budgets.update(TENANT, WORKSPACE, "bud_018f4d6e-2b4a-7a3e-8c1a-000000000000", { enabled: false })).rejects.toMatchObject({ name: "BudgetNotFoundError" });
    await budgets.delete(TENANT, WORKSPACE, created.id);
    expect(await budgets.list(TENANT, WORKSPACE)).toEqual([]);
  });
});
