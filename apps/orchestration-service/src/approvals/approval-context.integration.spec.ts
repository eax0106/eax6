import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ApprovalNotFoundError, ApprovalsService } from "./approvals.service";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const other = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const workflow = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const run = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const node = "018f4d6e-2b4a-7a3e-8c1a-1234567890a4";
const migrationsFolder = resolve("apps/orchestration-service/drizzle");
let postgres: StartedPostgreSqlContainer;
let admin: PostgresOrchestrationStoreProvider;
let store: PostgresOrchestrationStoreProvider;
let approvals: ApprovalsService;
const signalWorkflow = vi.fn().mockResolvedValue(undefined);
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start();
  admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
  await admin.migrate();
  const role = `approval_context_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  await admin.withTenant(tenant, async tx => {
    await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
    await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1,$2,$2,'approval context')", [workflow, tenant]);
    await tx.query("INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, workflow_id, status) VALUES ($1,$2,$2,'workflow',$3,'running')", [run, tenant, workflow]);
    await tx.query("INSERT INTO node_executions (id, tenant_id, run_id, dag_node_id, node_type, status) VALUES ($1,$2,$3,'approve.email','HumanApproval','running')", [node, tenant, run]);
  });
  store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });
  approvals = new ApprovalsService(store, { signalWorkflow });
}, 120_000);
afterAll(async () => { await store?.close(); await admin?.close(); await postgres?.stop(); });
it("projects graph context on list, read and decision; other tenant cannot read it", async () => {
  const created = await approvals.createPending({ tenantId: `ten_${tenant}`, runId: run, nodeExecutionId: node, requestedAction: {}, expirySeconds: 3600 });
  const context = { workflow_id: workflow, node_key: "approve.email" };
  expect(await approvals.getById(`ten_${tenant}`, created.id)).toMatchObject(context);
  expect((await approvals.list(`ten_${tenant}`)).data.find(a => a.id === created.id)).toMatchObject(context);
  expect((await approvals.list(`ten_${other}`)).data).toEqual([]);
  await expect(approvals.getById(`ten_${other}`, created.id)).rejects.toBeInstanceOf(ApprovalNotFoundError);
  expect(await approvals.decide(`ten_${tenant}`, created.id, "approved", tenant, undefined)).toMatchObject({ ...context, status: "approved" });
});
it("keeps graph context when read expires a pending approval", async () => {
  const created = await approvals.createPending({ tenantId: `ten_${tenant}`, runId: run, nodeExecutionId: node, requestedAction: {}, expirySeconds: 3600 });
  await store.withTenant(tenant, tx => tx.query("UPDATE approvals SET expiry_at=now()-interval '1 second' WHERE id=$1", [created.id]));
  expect(await approvals.getById(`ten_${tenant}`, created.id)).toMatchObject({ workflow_id: workflow, node_key: "approve.email", status: "expired" });
});
