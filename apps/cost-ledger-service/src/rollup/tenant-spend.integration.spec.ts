import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PostgresCostStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantSpendService } from "./tenant-spend.service";

const tenant = randomUUID(), other = randomUUID(), workspace = randomUUID();
const window = { tenant_id: tenant, start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" };
describe.sequential("read-only tenant spend through ordinary PostgreSQL", () => {
  let container: StartedPostgreSqlContainer, admin: PostgresCostStoreProvider, store: PostgresCostStoreProvider, service: TenantSpendService;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("spend_db").withPassword(randomBytes(24).toString("hex")).start();
    const migrationsFolder = resolve("apps/cost-ledger-service/drizzle");
    admin = new PostgresCostStoreProvider({ authentication: "static", connectionString: container.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = "spend_" + randomBytes(6).toString("hex"), password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    });
    const url = new URL(container.getConnectionUri()); url.username = role; url.password = password;
    store = new PostgresCostStoreProvider({ authentication: "static", connectionString: url.href, migrationsFolder });
    service = new TenantSpendService(store, 0.2);
  }, 120_000);
  afterAll(async () => { await store?.close(); await admin?.close(); await container?.stop(); });
  beforeEach(async () => { for (const id of [tenant, other]) await store.withTenant(id, tx => tx.query("DELETE FROM cost_events WHERE tenant_id=$1", [id])); });
  async function event(id: string, minor: string, currency: string, time: string, ws = workspace) {
    await store.withTenant(id, tx => tx.query(`INSERT INTO cost_events(id,tenant_id,workspace_id,mode,source,provider,resource,quantity,unit,internal_cost_minor,currency,occurred_at)
      VALUES($1,$2,$3,'workflow','tool_gateway','fixture','call',1,'call',$4,$5,$6)`, [randomUUID(), id, ws, minor, currency, time]));
  }

  it("sums actual events across workspaces with canonical integer billing and exact time boundaries", async () => {
    expect((await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await event(tenant, "100", "INR", window.start_at);
    await event(tenant, "101", "INR", "2026-10-04T23:59:59.999Z", randomUUID());
    await event(tenant, "1", "USD", "2026-09-20T00:00:00Z");
    await event(tenant, "999", "INR", "2026-09-04T23:59:59.999Z");
    await event(tenant, "999", "INR", window.end_at);
    await event(other, "999", "INR", window.start_at);
    expect(await service.spend(window)).toEqual({ ...window, currencies: [{ currency: "INR", billed_minor: "252", event_count: 2 }, { currency: "USD", billed_minor: "2", event_count: 1 }] });
    expect((await store.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS n FROM billing_rollups"))).rows[0]!.n).toBe(0);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT count(*)::int AS n FROM cost_events"))).rows[0]!.n).toBe(5);
  });

  it("preserves very large minor units and distinguishes no events from recorded zero", async () => {
    expect(await service.spend(window)).toEqual({ ...window, currencies: [] });
    await event(tenant, "9007199254740993", "INR", window.start_at);
    expect((await service.spend(window)).currencies).toEqual([{ currency: "INR", billed_minor: "11258999068426242", event_count: 1 }]);
    await event(other, "0", "USD", window.start_at);
    expect((await service.spend({ ...window, tenant_id: other })).currencies).toEqual([{ currency: "USD", billed_minor: "0", event_count: 1 }]);
    for (const rate of [NaN, -1, 1, 0.9999999]) expect(() => new TenantSpendService(store, rate)).toThrow();
  });
});
