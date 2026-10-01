import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { createMockMutableSecretsProvider, type ErasableSecretsProvider } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DELETE_ORDER, OrchestrationDeletionService, TABLES } from "./deletion.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const TENANT_RETENTION = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const MANIFEST = "del_018f4d6e-2b4a-7a3e-8c1a-123456789099";

describe.sequential("OrchestrationDeletionService real Postgres", () => {
  let secrets: ErasableSecretsProvider;
  let postgres: StartedPostgreSqlContainer;
  let adminStore: PostgresOrchestrationStoreProvider;
  let tenantStore: PostgresOrchestrationStoreProvider;
  let service: OrchestrationDeletionService;
  const role = `deletion_test_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: postgres.getConnectionUri(),
      migrationsFolder,
    });
    await adminStore.migrate();
    await adminStore.withTenant(TENANT_A, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    tenantStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      migrationsFolder,
    });
    // Webhook signing secrets for both tenants plus one outside the prefix.
    secrets = createMockMutableSecretsProvider({
      secrets: {
        [`alter/webhook-endpoints/ten_${TENANT_A}/whe_a/v1`]: "a1",
        [`alter/webhook-endpoints/ten_${TENANT_A}/whe_a/v2`]: "a2",
        [`alter/webhook-endpoints/ten_${TENANT_B}/whe_b/v1`]: "b1",
        "alter/unrelated/value": "keep",
      },
    });
    service = new OrchestrationDeletionService(tenantStore, adminStore, secrets);
  }, 90_000);

  afterAll(async () => {
    await tenantStore?.close();
    await adminStore.withTenant(TENANT_A, async (tx) => {
      await tx.query(`DROP OWNED BY ${role}`);
      await tx.query(`DROP ROLE IF EXISTS ${role}`);
    });
    await adminStore?.close();
    await postgres?.stop();
  }, 60_000);

  // F4 (Phase 5): the fix for ENGINE-FIX-P0-2 filled in the ten tables
  // TABLES/DELETE_ORDER were missing, but left them hand-maintained with
  // no schema-derived check -- the exact drift risk that caused the
  // original gap could reopen the moment a future migration adds another
  // tenant-scoped table and nobody remembers to update these two arrays.
  // This test closes that: it asks the real, live schema which tables
  // actually carry a tenant_id column and asserts TABLES/DELETE_ORDER
  // cover exactly that set -- not a hand-copied duplicate of either array,
  // the real production exports imported above. A migration that adds a
  // tenant-scoped table without updating both arrays now fails CI here
  // instead of silently reintroducing a false "erasure complete".
  it("TABLES and DELETE_ORDER cover every real tenant-scoped table, no more and no less", async () => {
    const result = await adminStore.withTenant(TENANT_A, async (tx) =>
      tx.query<{ table_name: string }>(
        `SELECT DISTINCT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public'
            AND c.column_name = 'tenant_id'
            AND t.table_type = 'BASE TABLE'`,
      ),
    );
    const realTenantTables = new Set(result.rows.map((row) => row.table_name));

    expect(new Set(TABLES)).toEqual(realTenantTables);
    expect(new Set(DELETE_ORDER)).toEqual(realTenantTables);
    // DELETE_ORDER must be a real permutation, not just the same set with a
    // duplicate standing in for a missing entry.
    expect(DELETE_ORDER).toHaveLength(new Set(DELETE_ORDER).size);
  });

  it("deletes all 35 tenant tables while preserving a second tenant", async () => {
    await seedAll(adminStore, TENANT_A, "a");
    await seedAll(adminStore, TENANT_B, "b");

    const before = await service.locateSubjectData(`ten_${TENANT_A}`);
    // 30: ENGINE-FIX-P0-2 added the ten tables (migrations 0019+) that were
    // previously missing from both TABLES and DELETE_ORDER, which let
    // verifyDeletion certify erasure complete while their rows survived;
    // C8 added side_effects; D3 added budgets, budget_usage and budget_reservations;
    // D2 added workspace_holds and workspace_run_retention.
    expect(before).toHaveLength(35);
    expect(before.every((location) => location.rowCount === 1)).toBe(true);

    await expect(service.deleteSubjectData(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({
      deletedRows: 35,
      deletedObjects: 2,
    });
    await expect(service.verifyDeletion(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({
      deleted: true,
      remaining: [],
    });
    expect((await service.locateSubjectData(`ten_${TENANT_B}`)).every((item) => item.rowCount === 1)).toBe(true);
    // C81: tenant A's webhook signing secrets are gone; B's and unrelated ones stay.
    await expect(secrets.listSecretReferences(`alter/webhook-endpoints/ten_${TENANT_A}/`)).resolves.toEqual([]);
    await expect(secrets.listSecretReferences("alter/")).resolves.toEqual([
      `alter/webhook-endpoints/ten_${TENANT_B}/whe_b/v1`,
      "alter/unrelated/value",
    ].sort());
  });

  it("fails verification while a webhook signing secret of the tenant survives, and a retry erases it", async () => {
    await secrets.putSecret(`alter/webhook-endpoints/ten_${TENANT_A}/whe_late/v1`, "late");
    await expect(service.verifyDeletion(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({
      deleted: false,
      remaining: [expect.objectContaining({ table: "secrets:alter/webhook-endpoints", rowCount: 1 })],
    });
    await expect(service.deleteSubjectData(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({ deletedObjects: 1 });
    await expect(service.verifyDeletion(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({ deleted: true, remaining: [] });
  });

  it("fails verification while any tenant row survives", async () => {
    await adminStore.withTenant(TENANT_A, async (tx) => {
      await tx.query(
        "INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ('wf_partial',$1,$1,'partial')",
        [TENANT_A],
      );
    });
    await expect(service.verifyDeletion(`ten_${TENANT_A}`, MANIFEST)).resolves.toMatchObject({
      deleted: false,
      remaining: [expect.objectContaining({ table: "workflows", rowCount: 1 })],
    });
  });

  it("sweeps expired content only and enumerates subjects without logging them", async () => {
    await seedRetention(adminStore);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const subjects = await service.listSubjectIds();
    expect(subjects).toContain(`ten_${TENANT_RETENTION}`);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    const result = await service.applyRetentionPolicy();
    expect(result.deletedRows).toBeGreaterThanOrEqual(5);
    await tenantStore.withTenant(TENANT_RETENTION, async (tx) => {
      const conversations = await tx.query<{ id: string }>(
        "SELECT id FROM conversations WHERE tenant_id=$1 ORDER BY id",
        [TENANT_RETENTION],
      );
      expect(conversations.rows).toEqual([{ id: "conv_recent" }]);
      const node = await tx.query<{ input_ref: string | null; output_ref: string | null }>(
        "SELECT input_ref,output_ref FROM node_executions WHERE tenant_id=$1 AND id='node_retention'",
        [TENANT_RETENTION],
      );
      expect(node.rows[0]).toEqual({ input_ref: null, output_ref: null });
    });
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

async function seedAll(
  store: PostgresOrchestrationStoreProvider,
  tenant: string,
  suffix: string,
): Promise<void> {
  await store.withTenant(tenant, async (tx) => {
    const workflow = `wf_${suffix}`;
    const workflowVersion = `wfv_${suffix}`;
    const trigger = `trg_${suffix}`;
    const conversation = `conv_${suffix}`;
    const run = `run_${suffix}`;
    const node = `node_${suffix}`;
    await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$2,'fixture')", [workflow, tenant]);
    await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES ($1,$2,$3,1,'{}','v1')", [workflowVersion, tenant, workflow]);
    await tx.query("INSERT INTO workflow_template_variable_definitions(id,tenant_id,workflow_id,workflow_version_id,name,value_type) VALUES ($1,$2,$3,$4,'REGION','text')", [`wtv_${suffix}`, tenant, workflow, workflowVersion]);
    await tx.query("INSERT INTO workflow_template_variable_values(tenant_id,workflow_id,name,value_json) VALUES ($1,$2,'REGION','\"ap-south-1\"')", [tenant, workflow]);
    await tx.query("INSERT INTO triggers(id,tenant_id,workspace_id,workflow_id,name,type) VALUES ($1,$2,$2,$3,'fixture','manual')", [trigger, tenant, workflow]);
    await tx.query("INSERT INTO trigger_webhook_secrets(tenant_id,trigger_id,version,secret_hash) VALUES ($1,$2,1,repeat('0',64))", [tenant, trigger]);
    await tx.query("INSERT INTO trigger_versions(id,tenant_id,trigger_id,version,config) VALUES ($1,$2,$3,1,'{}')", [`trgv_${suffix}`, tenant, trigger]);
    await tx.query("INSERT INTO conversations(id,tenant_id,workspace_id,channel,temporal_workflow_id) VALUES ($1,$2,$2,'api',$3)", [conversation, tenant, `temporal-${suffix}`]);
    await tx.query("INSERT INTO clarifications(id,tenant_id,workspace_id,conversation_id,question,expiry_at) VALUES ($1,$2,$2,$3,'fixture',now()+interval '1 hour')", [`clr_${suffix}`, tenant, conversation]);
    await tx.query("INSERT INTO conversation_goal_states(tenant_id,conversation_id) VALUES ($1,$2)", [tenant, conversation]);
    await tx.query("INSERT INTO events(event_id,event_type,schema_version,tenant_id,workspace_id,source,idempotency_key,occurred_at,conversation_id,trigger_id,trigger_version,payload,signature_status) VALUES ($1,'fixture','v1',$2,$2,'fixture',$3,now(),$4,$5,1,'{}','verified')", [`evt_${suffix}`, tenant, `idem-${suffix}`, conversation, trigger]);
    await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,workflow_version_id,conversation_id,trigger_id,triggering_event_id) VALUES ($1,$2,$2,'workflow',$3,$4,$5,$6,$7)", [run, tenant, workflow, workflowVersion, conversation, trigger, `evt_${suffix}`]);
    await tx.query("INSERT INTO blackboard_checkpoints(tenant_id,run_id,context_key,value_json) VALUES ($1,$2,'fixture','{}')", [tenant, run]);
    await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$2,$3,'fixture','Merge','succeeded')", [node, tenant, run]);
    await tx.query("INSERT INTO side_effects(id,tenant_id,run_id,dag_node_id,node_execution_id,tool_name,status) VALUES ($1,$2,$3,'fixture',$4,'email.send','completed')", [`sfx_${suffix}`, tenant, run, node]);
    // D3: a budget, what it has spent, and the run's reservation against it.
    const budget = `bud_018f4d6e-2b4a-7a3e-8c1a-1234567890${suffix === "a" ? "a9" : "b9"}`;
    await tx.query("INSERT INTO budgets(id,tenant_id,workspace_id,workflow_id,kind,period,amount_minor,created_by) VALUES ($1,$2,$2,$3,'workflow','daily',100,'usr_fixture')", [budget, tenant, workflow]);
    await tx.query("INSERT INTO budget_usage(tenant_id,budget_id,period_key,reserved_minor) VALUES ($1,$2,'2026-09-30',10)", [tenant, budget]);
    await tx.query("INSERT INTO budget_reservations(tenant_id,run_id,budget_id,period_key,reserved_minor) VALUES ($1,$2,$3,'2026-09-30',10)", [tenant, run, budget]);
    // D2: a workspace held pending deletion.
    await tx.query("INSERT INTO workspace_holds(tenant_id,workspace_id,held_by) VALUES ($1,$1,'usr_fixture')", [tenant]);
    await tx.query("INSERT INTO workspace_run_retention(tenant_id,workspace_id,retention_days,updated_by) VALUES ($1,$1,30,'usr_fixture')", [tenant]);
    await tx.query("INSERT INTO run_stream_events(id,tenant_id,run_id,seq,event,payload) VALUES ($1,$2,$3,1,'node.completed','{}')", [`sse_${suffix}`, tenant, run]);
    await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,node_execution_id,gate_type,verdict) VALUES ($1,$2,$3,$4,'quality','pass')", [`vrf_${suffix}`, tenant, run, node]);
    await tx.query("INSERT INTO recovery_actions(id,tenant_id,run_id,node_execution_id,failure_class) VALUES ($1,$2,$3,$4,'fixture')", [`rcv_${suffix}`, tenant, run, node]);
    await tx.query("INSERT INTO run_outcomes(id,tenant_id,workspace_id,run_id,mode,eligible,verdict,human_rescue,critical_external_error,decided_at) VALUES ($1,$2,$2,$3,'workflow',true,'completed_verified',false,false,now())", [`018f4d6e-2b4a-7a3e-8c1a-1234567890${suffix === "a" ? "a8" : "b8"}`, tenant, run]);
    await tx.query("INSERT INTO approvals(id,tenant_id,workspace_id,run_id,node_execution_id,requested_action,expiry_at) VALUES ($1,$2,$2,$3,$4,'{}',now()+interval '1 hour')", [`apr_${suffix}`, tenant, run, node]);

    // The ten tables ENGINE-FIX-P0-2 added to TABLES/DELETE_ORDER (migrations
    // 0019+). Seeded here so "deletes all 35 tenant tables" actually proves
    // coverage instead of just proving the original 19 still work.
    const project = `prj_${suffix}`;
    const webhookEndpoint = `whe_${suffix}`;
    const integrationId = randomUUID();
    const artifact = `art_${suffix}`;
    await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES ($1,$2,$2,'fixture')", [project, tenant]);
    // artifacts before deployments: deployments.artifact_id -> artifacts is a
    // plain (non-CASCADE) FK, so the referenced row must exist first.
    await tx.query("INSERT INTO artifacts(id,tenant_id,run_id,storage_reference,content_type,size_bytes) VALUES ($1,$2,$3,'s3://fixture','text/plain',1)", [artifact, tenant, run]);
    await tx.query("INSERT INTO deployments(id,tenant_id,project_id,artifact_id) VALUES ($1,$2,$3,$4)", [`dep_${suffix}`, tenant, project, artifact]);
    await tx.query("INSERT INTO project_plans(tenant_id,project_id,conversation_id,brief) VALUES ($1,$2,$3,'fixture')", [tenant, project, conversation]);
    await tx.query("INSERT INTO whatsapp_accounts(id,tenant_id,workspace_id,phone_number_id,waba_id,access_token_ref) VALUES ($1,$2,$2,$3,$4,'fixture-ref')", [`wa_${suffix}`, tenant, `phone_${suffix}_${randomUUID()}`, `waba_${suffix}`]);
    await tx.query("INSERT INTO webhook_endpoints(id,tenant_id,workspace_id,integration_id,path_token) VALUES ($1,$2,$2,$3,$4)", [webhookEndpoint, tenant, integrationId, `token_${suffix}_${randomUUID()}`]);
    await tx.query("INSERT INTO webhook_endpoint_secrets(id,tenant_id,endpoint_id,version,secret_ref) VALUES ($1,$2,$3,1,'fixture-secret-ref')", [`whs_${suffix}`, tenant, webhookEndpoint]);
    await tx.query("INSERT INTO trigger_integration_bindings(id,tenant_id,workspace_id,trigger_id,integration_id,webhook_endpoint_id,config) VALUES ($1,$2,$2,$3,$4,$5,'{}')", [`tib_${suffix}`, tenant, trigger, integrationId, webhookEndpoint]);
    await tx.query("INSERT INTO escalations(id,tenant_id,workspace_id,run_id,recovery_action_id,reason) VALUES ($1,$2,$2,$3,$4,'fixture')", [`esc_${suffix}`, tenant, run, `rcv_${suffix}`]);
    await tx.query("INSERT INTO run_dispatch_queue(id,tenant_id,run_id,compiled_dag) VALUES ($1,$2,$3,'{}')", [randomUUID(), tenant, run]);
  });
}

async function seedRetention(store: PostgresOrchestrationStoreProvider): Promise<void> {
  await store.withTenant(TENANT_RETENTION, async (tx) => {
    await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ('wf_retention',$1,$1,'retention')", [TENANT_RETENTION]);
    await tx.query("INSERT INTO conversations(id,tenant_id,workspace_id,channel,temporal_workflow_id,status,closed_at) VALUES ('conv_old',$1,$1,'api','temporal-old','closed',now()-interval '91 days'),('conv_recent',$1,$1,'api','temporal-recent','closed',now()-interval '89 days')", [TENANT_RETENTION]);
    await tx.query("INSERT INTO conversation_goal_states(tenant_id,conversation_id) VALUES ($1,'conv_old')", [TENANT_RETENTION]);
    await tx.query("INSERT INTO events(event_id,event_type,schema_version,tenant_id,workspace_id,source,idempotency_key,occurred_at,conversation_id,payload,signature_status) VALUES ('evt_old','fixture','v1',$1,$1,'fixture','idem-old',now(),'conv_old','{}','verified')", [TENANT_RETENTION]);
    await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,conversation_id) VALUES ('run_old',$1,$1,'workflow','wf_retention','conv_old'),('run_retention',$1,$1,'workflow','wf_retention',NULL)", [TENANT_RETENTION]);
    await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status,input_ref,output_ref,ended_at) VALUES ('node_retention',$1,'run_retention','fixture','Merge','succeeded','input','output',now()-interval '91 days')", [TENANT_RETENTION]);
  });
}
