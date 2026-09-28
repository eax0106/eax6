import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NodeExecutionLedgerService } from "./node-execution-ledger.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890d1";
const TENANT = `ten_${BARE_TENANT}`;
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890d2";
const NODE_1 = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890d3";
const NODE_2 = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890d4";

// C8, design log §22 item 7: the Side-Effect Ledger on a real orchestration_db.
describe.sequential("Side-Effect Ledger", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let ledger: NodeExecutionLedgerService;

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
    ledger = new NodeExecutionLedgerService(store);
    await store.withTenant(BARE_TENANT, async (tx) => {
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind) VALUES ($1,$2,$2,'workflow')", [RUN, BARE_TENANT]);
      await tx.query(
        "INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$3,$4,'notify','ToolCall','failed'),($2,$3,$4,'draft','LLMTask','succeeded')",
        [NODE_1, NODE_2, BARE_TENANT, RUN],
      );
    });
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("keeps an attempt that never reported back as evidence, and completes one that did", async () => {
    await ledger.recordSideEffectAttempt({
      id: "sfx_1", tenantId: TENANT, runId: RUN, dagNodeId: "notify", nodeExecutionId: NODE_1, toolName: "email.send",
    });
    expect(await ledger.priorSideEffects(TENANT, RUN, "notify")).toEqual([{ toolName: "email.send", status: "attempted" }]);
    expect(await ledger.priorSideEffects(TENANT, RUN, "draft")).toEqual([]);

    await ledger.completeSideEffect(TENANT, "sfx_1", "aud_018f4d6e-2b4a-7a3e-8c1a-1234567890ff");
    expect(await ledger.priorSideEffects(TENANT, RUN, "notify")).toEqual([{ toolName: "email.send", status: "completed" }]);
  });

  it("withdraws only an attempt that never completed", async () => {
    await ledger.withdrawSideEffectAttempt(TENANT, "sfx_1");
    expect(await ledger.priorSideEffects(TENANT, RUN, "notify")).toHaveLength(1);

    await ledger.recordSideEffectAttempt({
      id: "sfx_2", tenantId: TENANT, runId: RUN, dagNodeId: "draft", nodeExecutionId: NODE_2, toolName: "database.insert",
    });
    await ledger.withdrawSideEffectAttempt(TENANT, "sfx_2");
    expect(await ledger.priorSideEffects(TENANT, RUN, "draft")).toEqual([]);
  });
});
