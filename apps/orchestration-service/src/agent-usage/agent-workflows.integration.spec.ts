import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrchestrationTenantStore } from "../runs/run-observability.service";
import { AgentWorkflowsService, AgentWorkflowsValidationError } from "./agent-workflows.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const OTHER_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e2";
const WS_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const WS_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890f2";
const AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const OTHER_AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
let counter = 0;

// Section 17: the workflows an agent worked in lately, on a real orchestration_db.
describe.sequential("AgentWorkflowsService", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresOrchestrationStoreProvider;
  let service: AgentWorkflowsService;

  const step = async (tenant: string, workspace: string, workflow: string, agent: string, daysAgo: number) => {
    const n = ++counter;
    const runId = `run_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
    await store.withTenant(tenant, async (tx) => {
      await tx.query(
        "INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [workflow, tenant, workspace, `Workflow ${workflow}`],
      );
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,workflow_id,parent_kind) VALUES ($1,$2,$3,$4,'workflow')", [runId, tenant, workspace, workflow]);
      await tx.query(
        `INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,agent_id,status,started_at)
         VALUES ($1,$2,$3,'n','LLMTask',$4,'succeeded', now() - make_interval(days => $5))`,
        [`node_${n}`, tenant, runId, agent, daysAgo],
      );
    });
  };

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    service = new AgentWorkflowsService(store as unknown as OrchestrationTenantStore);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("lists each workflow the agent ran in within 30 days, once, across the tenant's workspaces", async () => {
    await step(TENANT, WS_A, "wf_a", AGENT, 1);
    await step(TENANT, WS_A, "wf_a", AGENT, 2);
    await step(TENANT, WS_B, "wf_b", AGENT, 3);
    await step(TENANT, WS_A, "wf_old", AGENT, 45);
    await step(TENANT, WS_A, "wf_other_agent", OTHER_AGENT, 1);
    await step(OTHER_TENANT, WS_A, "wf_foreign", AGENT, 1);

    await expect(service.recentWorkflows(`ten_${TENANT}`, AGENT)).resolves.toEqual([
      { workflow_id: "wf_a", workspace_id: WS_A, name: "Workflow wf_a" },
      { workflow_id: "wf_b", workspace_id: WS_B, name: "Workflow wf_b" },
    ]);
  });

  it("refuses a malformed tenant or agent id before reading", async () => {
    await expect(service.recentWorkflows("nope", AGENT)).rejects.toBeInstanceOf(AgentWorkflowsValidationError);
    await expect(service.recentWorkflows(`ten_${TENANT}`, "agt_1")).rejects.toBeInstanceOf(AgentWorkflowsValidationError);
  });
});
