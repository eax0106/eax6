import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntegrationRepository } from "./integration.repository";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-000000000011";

describe.skipIf(!databaseUrl)("IntegrationRepository PostgreSQL RLS", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let repository: IntegrationRepository;
  let schemaName: string;
  let roleName: string;
  let poolConnectionString: string;

  beforeEach(async () => {
    schemaName = `integration_${randomUUID().replaceAll("-", "_")}`;
    roleName = `integration_role_${randomUUID().replaceAll("-", "_")}`;
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    await admin.query(`SET search_path TO "${schemaName}"`);
    await applyMigrations(admin);
    await admin.query(
      `INSERT INTO tenants (id, name, status)
       VALUES ($1, 'Tenant A', 'active'), ($2, 'Tenant B', 'active')`,
      [tenantA, tenantB],
    );
    await admin.query(
      `INSERT INTO workspaces (id, tenant_id, name, status)
       VALUES ($1, $2, 'Workspace A', 'active'),
              ('00000000-0000-7000-8000-000000000012', $2, 'Workspace B', 'active')`,
      [workspaceA, tenantA],
    );
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES
       IN SCHEMA "${schemaName}" TO "${roleName}"`,
    );
    const url = new URL(databaseUrl);
    url.username = roleName;
    url.password = password;
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    poolConnectionString = url.toString();
    pool = new pg.Pool({ connectionString: poolConnectionString });
    repository = new IntegrationRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
      await admin.end();
    }
  });

  it("isolates oauth_states and oauth_connections by tenant under RLS", async () => {
    const stateId = "state-token-1";
    await repository.createState(tenantA, {
      id: stateId,
      workspaceId: workspaceA,
      connector: "github",
      codeVerifier: "verifier",
      redirectUri: "https://app.alter.ai/cb",
      createdBy: randomUUID(),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const connectionId = randomUUID();
    await repository.createConnection(tenantA, {
      id: connectionId,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "octocat",
      scopes: "read:user repo",
    });

    expect(await repository.findState(tenantB, stateId)).toBeUndefined();
    expect(
      await repository.findConnection(tenantB, workspaceA, connectionId),
    ).toBeUndefined();
    expect(await repository.findState(tenantA, stateId)).toBeDefined();
    expect(
      await repository.findConnection(tenantA, workspaceA, connectionId),
    ).toMatchObject({ externalAccountId: "octocat", status: "connected" });

    const client = await pool.connect();
    try {
      await client.query("RESET app.current_tenant_id");
      expect(
        (await client.query("SELECT * FROM oauth_connections")).rows,
      ).toHaveLength(0);
    } finally {
      client.release();
    }

    await repository.deleteState(tenantA, stateId);
    expect(await repository.findState(tenantA, stateId)).toBeUndefined();

    await repository.recordUse(tenantA, connectionId, randomUUID(), "health_check");
    await repository.recordUse(tenantA, connectionId, randomUUID(), "revoke");
    const activity = await repository.listActivity(tenantA, connectionId, {
      limit: 1,
    });
    expect(activity.data).toHaveLength(1);
    expect(activity.data[0]).toMatchObject({ connectionId });
    expect(activity.page.has_more).toBe(true);
    const next = await repository.listActivity(tenantA, connectionId, {
      limit: 1,
      cursor: activity.page.next_cursor!,
    });
    expect(next.data).toHaveLength(1);
    expect(next.page.has_more).toBe(false);
    await expect(
      repository.listActivity(tenantA, connectionId, {
        limit: 1,
        cursor: randomUUID(),
      }),
    ).rejects.toMatchObject({ name: "ActivityCursorNotFoundError" });
    expect(
      (await repository.listActivity(tenantB, connectionId, { limit: 1 })).data,
    ).toHaveLength(0);
    const health = await repository.updateHealth(
      tenantA,
      workspaceA,
      connectionId,
      "healthy",
      new Date(),
    );
    expect(health?.lastHealthStatus).toBe("healthy");
    expect(health?.useAuditPtr).not.toBeNull();

    const revoked = await repository.revokeConnection(
      tenantA,
      workspaceA,
      connectionId,
    );
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("scopes connections by workspace within the same tenant", async () => {
    const workspaceB = "00000000-0000-7000-8000-000000000012";
    const idA = randomUUID();
    const idB = randomUUID();
    await repository.createConnection(tenantA, {
      id: idA,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "account-a",
      scopes: "read:user",
    });
    await repository.createConnection(tenantA, {
      id: idB,
      workspaceId: workspaceB,
      connector: "github",
      externalAccountId: "account-b",
      scopes: "read:user",
    });

    expect(await repository.listConnections(tenantA, workspaceA)).toHaveLength(1);
    expect(await repository.listConnections(tenantA, workspaceB)).toHaveLength(1);
    expect(
      await repository.findConnection(tenantA, workspaceB, idA),
    ).toBeUndefined();
  });

  it("isolates workspace connector configuration by tenant and workspace", async () => {
    const workspaceB = "00000000-0000-7000-8000-000000000012";
    await repository.upsertConnectorConfig(tenantA, workspaceA, "zendesk", {
      connector: "zendesk",
      subdomain: "workspace-a",
    });

    expect(
      await repository.findConnectorConfig(tenantA, workspaceA, "zendesk"),
    ).toMatchObject({ config: { subdomain: "workspace-a" } });
    expect(
      await repository.findConnectorConfig(tenantA, workspaceB, "zendesk"),
    ).toBeUndefined();
    expect(
      await repository.findConnectorConfig(tenantB, workspaceA, "zendesk"),
    ).toBeUndefined();

    const client = await pool.connect();
    try {
      await client.query("RESET app.current_tenant_id");
      expect(
        (await client.query("SELECT * FROM workspace_connector_configs")).rows,
      ).toHaveLength(0);
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, false)",
        [tenantB],
      );
      expect(
        (await client.query("SELECT * FROM workspace_connector_configs")).rows,
      ).toHaveLength(0);
    } finally {
      await client.query("RESET app.current_tenant_id");
      client.release();
    }
  });

  it("rolls back the transaction on a constraint violation", async () => {
    const id = randomUUID();
    await repository.createConnection(tenantA, {
      id,
      workspaceId: workspaceA,
      connector: "github",
      externalAccountId: "duplicate-account",
      scopes: "read:user",
    });
    await expect(
      repository.createConnection(tenantA, {
        id,
        workspaceId: workspaceA,
        connector: "github",
        externalAccountId: "different-account-same-id",
        scopes: "read:user",
      }),
    ).rejects.toThrow();
    expect(await repository.listConnections(tenantA, workspaceA)).toHaveLength(1);
  });

  it("closes the pool on module destroy when configured to do so", async () => {
    const ownedPool = new pg.Pool({ connectionString: poolConnectionString });
    const ownedRepository = new IntegrationRepository(ownedPool, true);
    await ownedRepository.onModuleDestroy();
    await expect(ownedPool.query("SELECT 1")).rejects.toThrow();
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
