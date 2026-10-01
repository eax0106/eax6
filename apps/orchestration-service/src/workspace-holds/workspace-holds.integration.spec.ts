import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RunLauncherService, WorkspacePendingDeletionError } from "../runs/run-launcher.service";
import type { OrchestrationTenantStore } from "../runs/run-observability.service";
import { WorkspaceHoldsService, WorkspaceHoldValidationError } from "./workspace-holds.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WS = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const OTHER_WS = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f2";

// D2 workspace holds on a real orchestration_db.
describe.sequential("WorkspaceHoldsService", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let holds: WorkspaceHoldsService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    holds = new WorkspaceHoldsService(store as unknown as OrchestrationTenantStore);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("holds and releases idempotently, per workspace and per tenant", async () => {
    await holds.hold(`ten_${TENANT}`, WS, "usr_1");
    await holds.hold(`ten_${TENANT}`, WS, "usr_1");
    expect(await holds.isHeld(`ten_${TENANT}`, WS)).toBe(true);
    expect(await holds.isHeld(`ten_${TENANT}`, OTHER_WS)).toBe(false);
    expect(await holds.isHeld(`ten_${OTHER_TENANT}`, WS)).toBe(false);

    await holds.release(`ten_${TENANT}`, WS);
    await holds.release(`ten_${TENANT}`, WS);
    expect(await holds.isHeld(`ten_${TENANT}`, WS)).toBe(false);
  });

  it("the engine refuses run creation in a held workspace on real Postgres", async () => {
    const workflow = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890f3";
    await store.withTenant(TENANT, (tx) =>
      tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,'held')", [workflow, TENANT, WS.slice(3)]),
    );
    await holds.hold(`ten_${TENANT}`, WS, "usr_1");
    const durable = { startWorkflow: vi.fn(), terminateWorkflow: vi.fn() };
    const launcher = new RunLauncherService(store as unknown as OrchestrationTenantStore, durable as never);

    await expect(launcher.createRun(`ten_${TENANT}`, workflow)).rejects.toBeInstanceOf(WorkspacePendingDeletionError);
    const runs = await store.withTenant(TENANT, (tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM runs"));
    expect(runs.rows[0]?.n).toBe(0);
    expect(durable.startWorkflow).not.toHaveBeenCalled();
    await holds.release(`ten_${TENANT}`, WS);
  });

  it("refuses malformed ids before touching the database", async () => {
    await expect(holds.hold("ten_nope", WS, "usr_1")).rejects.toBeInstanceOf(WorkspaceHoldValidationError);
    await expect(holds.release(`ten_${TENANT}`, "ws_nope")).rejects.toBeInstanceOf(WorkspaceHoldValidationError);
  });
});
