import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingModule } from "./billing.module";
import { BillingRepository } from "./billing.repository";
import { AdminBillingOperationsRepository } from "./admin-billing-operations.repository";
import { BillingPolicyModule } from "./billing-policy.module";
import { BillingPolicyService } from "./billing-policy.service";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import { PlatformDeletionService } from "../deletion/platform-deletion.service";
import { PlatformDeletionModule } from "../deletion/platform-deletion.module";
import { AdminBillingRepository } from "./admin-billing.repository";

const tenantA = "00000000-0000-7000-8000-0000000000a1";
const tenantB = "00000000-0000-7000-8000-0000000000b1";
const manifestA = "del_00000000-0000-7000-8000-00000000d001";
const root = resolve(__dirname, "../../../..");
const appPassword = randomUUID(), operationsPassword = randomUUID(), retentionPassword = randomUUID();
const appFunctions = [
  "erase_tenant_action_annotations(uuid,text)", "erase_tenant_payout_ledger(uuid,text)",
  "erase_tenant_listings(uuid,text)", "erase_tenant_marketplace_governance(uuid,text)",
  "erase_tenant_abuse_signal_actions(uuid,text)", "erase_tenant_billing_admin_operations(uuid,text)",
];
const operationsFunctions = ["admin_list_staff_billing_issues()", "list_billing_sync_tenants(uuid,integer)", "pseudonymise_orphan_users(uuid[])"];

// Own isolated server: the real deployment kit changes runtime passwords and
// must never be exercised against another local test's shared database roles.
describe("billing actual EC2 runtime database identities", () => {
  let container: StartedPostgreSqlContainer, admin: pg.Client, app: pg.Pool, operations: pg.Pool;
  const factoryPools = new Set<pg.Pool>();
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").withUsername("platform_api").withDatabase("platform_runtime").withStartupTimeout(120_000).start();
    admin = new pg.Client({ connectionString: container.getConnectionUri() }); await admin.connect();
    await applyRoles();
    await migrations("apps/platform-api/src/db/migrations");
    await migrations("apps/platform-api/src/db/marketplace-migrations");
    await applyRoles(); await applyRoles();
    app = rolePool("platform_app", appPassword); operations = rolePool("platform_operations", operationsPassword);
    await admin.query("INSERT INTO tenants(id,name,status) VALUES($1,'Runtime A','active'),($2,'Runtime B','active')", [tenantA, tenantB]);
    await admin.query("INSERT INTO billing_dunning_states(tenant_id,state,current_plan) VALUES($1,'limited','basic'),($2,'grace','basic')", [tenantA, tenantB]);
    await admin.query("INSERT INTO billing_policy_state(tenant_id,email_verified) VALUES($1,true),($2,false)", [tenantA, tenantB]);
  }, 120_000);
  afterAll(async () => { await Promise.all([...factoryPools].map(pool => pool.end())); await app?.end(); await operations?.end(); await admin?.end(); await container?.stop(); }, 60_000);

  function rolePool(role: string, password: string) {
    const url = new URL(container.getConnectionUri()); url.username = role; url.password = password;
    return new pg.Pool({ connectionString: url.href });
  }
  async function applyRoles() {
    const sql = readFileSync(join(root, "deploy/ec2/platform-db-roles.sql"), "utf8")
      .replaceAll(":'app_password'", `'${appPassword}'`).replaceAll(":'operations_password'", `'${operationsPassword}'`)
      .replaceAll(":'retention_password'", `'${retentionPassword}'`);
    await admin.query(sql);
  }
  async function migrations(relative: string) {
    const directory = join(root, relative);
    for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      for (const sql of readFileSync(join(directory, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await admin.query(sql);
    }
  }

  it("retains ordinary tenant FORCE RLS, declared operations identity and no runtime DDL", async () => {
    expect((await app.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect((await operations.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: true }]);
    expect((await app.query("SELECT tenant_id FROM billing_dunning_states")).rows).toEqual([]);
    const tx = await app.connect();
    try { await tx.query("BEGIN"); await tx.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantA]);
      expect((await tx.query("SELECT tenant_id FROM billing_dunning_states")).rows).toEqual([{ tenant_id: tenantA }]);
      expect((await tx.query("UPDATE billing_dunning_states SET state='suspended' WHERE tenant_id=$1 RETURNING tenant_id", [tenantB])).rows).toEqual([]);
      await tx.query("ROLLBACK");
    } finally { tx.release(); }
    await expect(app.query("CREATE TABLE runtime_forbidden(id integer)")).rejects.toThrow("permission denied");
    await expect(operations.query("CREATE TABLE runtime_forbidden(id integer)")).rejects.toThrow("permission denied");
  });

  it("allows every named manifest-guarded erasure helper after two role-kit reapplications", async () => {
    for (const signature of appFunctions) {
      expect((await app.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows, signature).toEqual([{ allowed: true }]);
    }
    for (const signature of appFunctions) {
      const name = signature.slice(0, signature.indexOf("("));
      await expect(app.query(`SELECT ${name}($1,$2)`, [tenantA, manifestA])).rejects.toThrow("no active erasure manifest");
    }
  });

  it("allows real staff billing inventory and system delivery inventory only through operations identity", async () => {
    expect((await new AdminBillingRepository(operations).listIssues()).map(row => row.tenant_id).sort()).toEqual([tenantA, tenantB]);
    expect((await operations.query("SELECT tenant_id FROM list_billing_sync_tenants(NULL,100)")).rows).toEqual([{ tenant_id: tenantA }, { tenant_id: tenantB }]);
    for (const signature of operationsFunctions) {
      expect((await app.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows, signature).toEqual([{ allowed: false }]);
      expect((await operations.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows, signature).toEqual([{ allowed: true }]);
    }
  });

  it("uses actual production factories with distinct staff, inventory and ordinary mutation connections", async () => {
    const environment = { ...process.env };
    try {
      const appUrl = new URL(container.getConnectionUri()); appUrl.username = "platform_app"; appUrl.password = appPassword;
      const operationsUrl = new URL(container.getConnectionUri()); operationsUrl.username = "platform_operations"; operationsUrl.password = operationsPassword;
      process.env.DATABASE_URL = appUrl.href; process.env.OPERATIONS_PLATFORM_DATABASE_URL = operationsUrl.href;
      const providers = Reflect.getMetadata("providers", BillingModule) as { provide: unknown; useFactory?: () => unknown }[];
      const inventory = providers.find(provider => provider.provide === AdminBillingRepository)!.useFactory!() as AdminBillingRepository;
      factoryPools.add((inventory as unknown as { pool: pg.Pool }).pool);
      expect((await inventory.listIssues()).map(row => row.tenant_id).sort()).toEqual([tenantA, tenantB]);
      for (const token of [BillingRepository, AdminBillingOperationsRepository]) {
        const instance = providers.find(provider => provider.provide === token)!.useFactory!() as { pool: pg.Pool };
        factoryPools.add(instance.pool);
        expect((await instance.pool.query("SELECT current_user AS identity")).rows).toEqual([{ identity: "platform_app" }]);
      }
      const policyProviders = Reflect.getMetadata("providers", BillingPolicyModule) as { provide: unknown; useFactory: (...args: unknown[]) => unknown }[];
      const policy = policyProviders.find(provider => provider.provide === BillingPolicyService)!.useFactory({}, {}, {}) as { pool: pg.Pool; inventoryPool: pg.Pool };
      factoryPools.add(policy.pool); factoryPools.add(policy.inventoryPool);
      expect((await policy.pool.query("SELECT current_user AS identity")).rows).toEqual([{ identity: "platform_app" }]);
      expect((await policy.inventoryPool.query("SELECT current_user AS identity")).rows).toEqual([{ identity: "platform_operations" }]);
      delete process.env.OPERATIONS_PLATFORM_DATABASE_URL; process.env.DATABASE_URL = container.getConnectionUri();
      const local = providers.find(provider => provider.provide === AdminBillingRepository)!.useFactory!() as AdminBillingRepository;
      factoryPools.add((local as unknown as { pool: pg.Pool }).pool);
      expect((await local.listIssues()).map(row => row.tenant_id).sort()).toEqual([tenantA,tenantB]);
    } finally { process.env = environment; }
  });

  it("keeps helper public revocations and dedicated retention grants", async () => {
    const functions = [...appFunctions, ...operationsFunctions];
    for (const signature of functions) {
      const privileges = await admin.query("SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute", [signature]);
      expect(privileges.rows, signature).toEqual([{ public_execute: false }]);
    }
    const retention = rolePool("platform_retention", retentionPassword);
    try {
      expect((await retention.query("SELECT expire_erasure_skeleton(NULL) AS removed")).rows).toEqual([{ removed: 0 }]);
      await expect(retention.query("SELECT * FROM tenants")).rejects.toThrow("permission denied");
    } finally { await retention.end(); }
  });
  it("erases through the actual ordinary runtime identity and finalizes only orphan users through operations", async () => {
    const orphan = "00000000-0000-7000-8000-000000000101", shared = "00000000-0000-7000-8000-000000000102";
    await admin.query("INSERT INTO users(id,identity_ref,email,status) VALUES($1,'auth0|runtime-orphan','orphan@example.test','active'),($2,'auth0|runtime-shared','shared@example.test','active')", [orphan,shared]);
    await admin.query("INSERT INTO tenant_members(id,tenant_id,user_id,role) VALUES($1,$2,$3,'owner'),($4,$2,$5,'member'),($6,$7,$5,'member')", [randomUUID(),tenantA,orphan,randomUUID(),shared,randomUUID(),tenantB]);
    await admin.query("INSERT INTO staff_users(id,identity_ref,email,roles) VALUES('stf_runtime','auth0|runtime-staff','staff@example.test',ARRAY['staff_admin'])");
    const operation = "bop_00000000-0000-7000-8000-000000000201";
    await admin.query("INSERT INTO billing_admin_operations(id,tenant_id,action,actor_ref,reason,revision,runs,credits) VALUES($1,$2,'grant_credits','stf_runtime','Runtime grant proof',2,2,4)", [operation,tenantA]);
    await admin.query("INSERT INTO billing_admin_credit_deliveries(tenant_id,operation_id,credits) VALUES($1,$2,4)", [tenantA,operation]);
    const environment = { ...process.env };
    let deletion: PlatformDeletionService;
    try {
      const appUrl = new URL(container.getConnectionUri()); appUrl.username = "platform_app"; appUrl.password = appPassword;
      const operationsUrl = new URL(container.getConnectionUri()); operationsUrl.username = "platform_operations"; operationsUrl.password = operationsPassword;
      const retentionUrl = new URL(container.getConnectionUri()); retentionUrl.username = "platform_retention"; retentionUrl.password = retentionPassword;
      process.env.DATABASE_URL = appUrl.href; process.env.OPERATIONS_PLATFORM_DATABASE_URL = operationsUrl.href; process.env.PLATFORM_RETENTION_DATABASE_URL = retentionUrl.href;
      const providers = Reflect.getMetadata("providers", PlatformDeletionModule) as { provide: unknown; useFactory: (secrets: unknown) => Promise<PlatformDeletionService> }[];
      deletion = await providers.find(provider => provider.provide === PlatformDeletionService)!.useFactory(createMockMutableSecretsProvider());
      const stores = deletion as unknown as { store: { pool: pg.Pool }; administrationStore: { pool: pg.Pool }; retentionStore: { pool: pg.Pool } };
      for (const store of [stores.store, stores.administrationStore, stores.retentionStore]) factoryPools.add(store.pool);
    } finally { process.env = environment; }
    await deletion.deleteSubjectData(`ten_${tenantA}`, manifestA);
    expect(await deletion.verifyDeletion(`ten_${tenantA}`, manifestA)).toMatchObject({ deleted: true });
    expect((await admin.query("SELECT * FROM billing_admin_operations WHERE tenant_id=$1", [tenantA])).rows).toEqual([]);
    expect((await admin.query("SELECT * FROM billing_admin_credit_deliveries WHERE tenant_id=$1", [tenantA])).rows).toEqual([]);
    expect((await admin.query("SELECT tenant_id FROM billing_dunning_states WHERE tenant_id=$1", [tenantB])).rows).toEqual([{ tenant_id: tenantB }]);
    expect((await admin.query("SELECT identity_ref,status FROM users WHERE id=$1", [orphan])).rows).toEqual([{ identity_ref: `erased:${orphan}`, status: "suspended" }]);
    expect((await admin.query("SELECT identity_ref,email,status FROM users WHERE id=$1", [shared])).rows).toEqual([{ identity_ref: "auth0|runtime-shared", email: "shared@example.test", status: "active" }]);
    expect([...(await deletion.listSubjectIds())].sort()).toEqual([`ten_${tenantA}`,`ten_${tenantB}`]);
  });

  it("passes the actual deployment role driver against this isolated migrated server", () => {
    const result = spawnSync("bash", [join(root,"deploy/ec2/check-platform-db-roles.sh"), container.getConnectionUri()], { encoding: "utf8", timeout: 120_000, maxBuffer: 5*1024*1024 });
    if (result.status !== 0 || result.error) {
      const detail = ((result.stdout ?? "")+(result.stderr ?? "")).split("\n").filter(line => /^FAIL |^ERROR:/.test(line)).slice(-3).join("\n");
      throw new Error(`Deployment role driver failed (${result.status ?? result.error?.name}): ${detail}`);
    }
    expect(result.stdout).toContain("platform-db-roles-ok");
  }, 120_000);

});
