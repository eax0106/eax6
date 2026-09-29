import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailProvider } from "@alterx/shared-clients";
import { NotificationRepository } from "./notification.repository";
import { NotificationService } from "./notification.service";

// B3.1b: a producer addresses a role in a workspace, and the recipients are
// read through the same row-level security as every tenant query -- never a
// member of another workspace or another tenant.
const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-000000000011";
const workspaceA2 = "00000000-0000-7000-8000-000000000012";
const workspaceB = "00000000-0000-7000-8000-000000000013";
const adminA = "00000000-0000-7000-8000-000000000101";
const editorA = "00000000-0000-7000-8000-000000000102";
const adminOtherWorkspace = "00000000-0000-7000-8000-000000000103";
const adminTenantB = "00000000-0000-7000-8000-000000000104";

describe.skipIf(!databaseUrl)("NotificationService.notifyWorkspaceRoles on PostgreSQL RLS", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let service: NotificationService;
  let schemaName: string;
  let roleName: string;
  const sent: string[] = [];

  beforeEach(async () => {
    sent.length = 0;
    schemaName = `notify_${randomUUID().replaceAll("-", "_")}`;
    roleName = `notify_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    await admin.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, 'A', 'active'), ($2, 'B', 'active')`,
      [tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO workspaces (id, tenant_id, name, status)
       VALUES ($1, $4, 'A', 'active'), ($2, $4, 'A2', 'active'), ($3, $5, 'B', 'active')`,
      [workspaceA, workspaceA2, workspaceB, tenantA, tenantB],
    );
    for (const user of [adminA, editorA, adminOtherWorkspace, adminTenantB]) {
      await admin.query(
        `INSERT INTO users (id, identity_ref, email, status) VALUES ($1, $2, $3, 'active')`,
        [user, `auth0|${user}`, `${user}@example.test`],
      );
    }
    const members: [string, string, string, string][] = [
      [tenantA, workspaceA, adminA, "admin"],
      [tenantA, workspaceA, editorA, "editor"],
      [tenantA, workspaceA2, adminOtherWorkspace, "admin"],
      [tenantB, workspaceB, adminTenantB, "admin"],
    ];
    for (const [tenant, workspace, user, role] of members) {
      await admin.query(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES ($1, $2, $3, 'member')`,
        [randomUUID(), tenant, user],
      );
      await admin.query(
        `INSERT INTO workspace_members (id, tenant_id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant, workspace, user, role],
      );
    }
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${roleName}"`,
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    const email = {
      sendTemplatedEmail: async (to: string) => {
        sent.push(to);
        return { messageId: "m-1" };
      },
    } as unknown as EmailProvider;
    service = new NotificationService(new NotificationRepository(pool), email);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("creates one event for each holder of the role in that workspace only", async () => {
    const count = await service.notifyWorkspaceRoles(["admin"], {
      tenantId: tenantA,
      workspaceId: workspaceA,
      eventClass: "system",
      severity: "warning",
      title: "GitHub connection needs reconnecting",
      body: "body",
      deepLink: "/connections/c-1",
      sourceService: "platform-api.integrations",
    });

    expect(count).toBe(1);
    const rows = await admin.query<{ user_id: string }>(
      `SELECT r.user_id FROM notification_reads r ORDER BY r.user_id`,
    );
    expect(rows.rows.map((row) => row.user_id)).toEqual([adminA]);
    const page = await service.list({ tenantId: tenantA, userId: adminA, limit: 10 });
    expect(page.items.map((item) => item.title)).toEqual(["GitHub connection needs reconnecting"]);
    expect(await service.list({ tenantId: tenantA, userId: editorA, limit: 10 })).toMatchObject({
      items: [],
    });
    expect(sent).toEqual([`${adminA}@example.test`]);
  });

  it("a producer that meets the same happening twice tells each recipient once", async () => {
    const input = {
      tenantId: tenantA,
      workspaceId: workspaceA,
      eventClass: "workflow" as const,
      severity: "critical" as const,
      title: "A workflow run failed",
      body: "b",
      deepLink: "/runs/run_1",
      sourceService: "platform-api.engine-events",
    };

    const first = await service.notifyWorkspaceRolesOnce(["admin", "editor"], "run.failed:run_1", input);
    const again = await service.notifyWorkspaceRolesOnce(["admin", "editor"], "run.failed:run_1", input);
    const other = await service.notifyWorkspaceRolesOnce(["admin", "editor"], "run.failed:run_2", input);

    expect([first, again, other]).toEqual([2, 0, 2]);
    const events = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM notification_events`);
    const reads = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM notification_reads`);
    expect([events.rows[0]!.n, reads.rows[0]!.n]).toEqual(["4", "4"]);
    // The repeat sent no second email either.
    expect(sent.sort()).toEqual(
      [adminA, adminA, editorA, editorA].map((user) => `${user}@example.test`).sort(),
    );
  });

  it("the dedupe key is per tenant: another tenant's identical key is a different event", async () => {
    const base = {
      eventClass: "workflow" as const,
      severity: "critical" as const,
      title: "t",
      body: "b",
      deepLink: null,
      sourceService: "platform-api.engine-events",
    };
    const a = await service.notifyWorkspaceRolesOnce(["admin"], "run.failed:same", {
      ...base,
      tenantId: tenantA,
      workspaceId: workspaceA,
    });
    const b = await service.notifyWorkspaceRolesOnce(["admin"], "run.failed:same", {
      ...base,
      tenantId: tenantB,
      workspaceId: workspaceB,
    });
    expect([a, b]).toEqual([1, 1]);
  });

  it("events made without a dedupe key are never merged", async () => {
    const input = {
      tenantId: tenantA,
      workspaceId: workspaceA,
      eventClass: "system" as const,
      severity: "info" as const,
      title: "t",
      body: "b",
      deepLink: null,
      sourceService: "platform-api.integrations",
    };
    await service.notifyWorkspaceRoles(["admin"], input);
    await service.notifyWorkspaceRoles(["admin"], input);
    const events = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM notification_events`);
    expect(events.rows[0]!.n).toBe("2");
  });

  it("finds no recipient across the tenant boundary", async () => {
    // Tenant A's context naming tenant B's workspace: RLS hides B's members.
    const count = await service.notifyWorkspaceRoles(["admin"], {
      tenantId: tenantA,
      workspaceId: workspaceB,
      eventClass: "system",
      severity: "warning",
      title: "t",
      body: "b",
      deepLink: null,
      sourceService: "platform-api.integrations",
    });

    expect(count).toBe(0);
    expect(sent).toEqual([]);
  });
});

async function applyMigrations(client: pg.Client): Promise<void> {
  const directory = join(__dirname, "../db/migrations");
  const sql = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(directory, file), "utf8"))
    .join("\n--> statement-breakpoint\n");
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}
