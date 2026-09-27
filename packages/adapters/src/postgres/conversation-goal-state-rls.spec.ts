import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresOrchestrationStoreProvider } from "./orchestration-store-provider";

const migrationsFolder = resolve(
  process.cwd(),
  "apps/orchestration-service/drizzle",
);
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-000000000011";
const workspaceB = "00000000-0000-7000-8000-000000000012";

async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO conversations
       (id, tenant_id, workspace_id, channel, temporal_workflow_id)
     VALUES
       ('cnv_a', $1, $2, 'web', 'tenant:a:channel:web:conversation:a'),
       ('cnv_b', $3, $4, 'api', 'tenant:b:channel:api:conversation:b')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
  await pool.query(
    `INSERT INTO conversation_goal_states
       (tenant_id, conversation_id, goal_state_json, status, revision)
     VALUES
       ($1, 'cnv_a', '{"pendingClarifications":{"clr_a":"tenant-a-only"}}'::jsonb, 'awaiting_clarification', 1),
       ($2, 'cnv_b', '{"pendingClarifications":{"clr_b":"tenant-b-only"}}'::jsonb, 'awaiting_clarification', 1)`,
    [tenantA, tenantB],
  );
}

/**
 * The image CI pins, overridable so the same tenant-isolation proof can run
 * against the Postgres major version a deployment target runs -- Neon is 18,
 * CI is 16.6, and RLS behaviour proven on one major version is not proven on
 * the other. The suite asserts the server it reached matches what was asked
 * for, so an ignored override cannot pass as a proof of the other version.
 */
const POSTGRES_IMAGE = process.env.POSTGRES_TEST_IMAGE ?? "postgres:16.6-alpine";

function requestedMajorVersion(image: string): number {
  const match = /postgres:(\d+)/.exec(image);
  if (match === null) throw new Error(`cannot read a major version from ${image}`);
  return Number(match[1]);
}

describe.sequential("conversation_goal_states RLS integration", () => {
  let container: StartedPostgreSqlContainer;
  let adminPool: Pool;
  let rolePool: Pool;
  let provider: PostgresOrchestrationStoreProvider;
  let roleProvider: PostgresOrchestrationStoreProvider;
  const role = `conversation_test_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase("orchestration_db")
      .withUsername("orchestration_test_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminPool = new Pool({ connectionString: container.getConnectionUri() });
    provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: container.getConnectionUri(),
        migrationsFolder,
      },
      { pool: adminPool },
    );
    await provider.migrate();
    await seed(adminPool);

    await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await adminPool.query(
      `GRANT CONNECT ON DATABASE orchestration_db TO ${role}`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await adminPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );

    rolePool = new Pool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: role,
      password,
    });
    roleProvider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://unused/orchestration_db",
        migrationsFolder,
      },
      { pool: rolePool },
    );
    // Long enough to pull the image on a cold cache: the default 10s hook
    // timeout fails before a not-yet-pulled Postgres image is even available,
    // which reads as a tenant-isolation failure rather than a slow download.
  }, 300_000);

  afterAll(async () => {
    await roleProvider?.close();
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${role}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await provider?.close();
    await container?.stop();
  });

  it("runs against the Postgres major version this suite was asked for", async () => {
    const result = await adminPool.query<{ major: string }>(
      "SELECT current_setting('server_version_num')::int / 10000 AS major",
    );
    expect(Number(result.rows[0]?.major)).toBe(requestedMajorVersion(POSTGRES_IMAGE));
  });

  it("forces RLS on conversation_goal_states", async () => {
    const result = await adminPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
       WHERE pg_namespace.nspname = 'public'
         AND pg_class.relkind = 'r'
         AND relname = 'conversation_goal_states'`,
    );

    expect(result.rows).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it("defaults to deny with no tenant context set", async () => {
    const unset = await rolePool.query<{ count: string }>(
      "SELECT count(*) FROM conversation_goal_states",
    );
    expect(unset.rows[0]?.count).toBe("0");
  });

  it("tenant A can never read tenant B's goal state, even by exact conversation_id", async () => {
    await roleProvider.withTenant(tenantA, async (client) => {
      const ownRow = await client.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM conversation_goal_states WHERE conversation_id = 'cnv_a'",
      );
      expect(ownRow.rows).toHaveLength(1);

      const otherTenantRow = await client.query(
        "SELECT * FROM conversation_goal_states WHERE conversation_id = 'cnv_b'",
      );
      expect(otherTenantRow.rows).toHaveLength(0);

      const everything = await client.query<{ count: string }>(
        "SELECT count(*) FROM conversation_goal_states",
      );
      expect(everything.rows[0]?.count).toBe("1");
    });
  });

  it("tenant A can never merge into tenant B's goal state row", async () => {
    await roleProvider.withTenant(tenantA, async (client) => {
      const blockedUpdate = await client.query(
        `UPDATE conversation_goal_states
         SET goal_state_json = '{"pendingClarifications":{"hijacked":"true"}}'::jsonb,
             revision = revision + 1
         WHERE tenant_id = $1 AND conversation_id = 'cnv_b'`,
        [tenantB],
      );
      expect(blockedUpdate.rowCount).toBe(0);
    });

    const stillIntact = await adminPool.query<{ goal_state_json: unknown }>(
      "SELECT goal_state_json FROM conversation_goal_states WHERE conversation_id = 'cnv_b'",
    );
    expect(stillIntact.rows[0]?.goal_state_json).toEqual({
      pendingClarifications: { clr_b: "tenant-b-only" },
    });
  });

  it("rejects tenant_id mutation on conversation_goal_states", async () => {
    await expect(
      roleProvider.withTenant(tenantA, async (client) =>
        client.query(
          "UPDATE conversation_goal_states SET tenant_id = $1 WHERE tenant_id = $2 AND conversation_id = 'cnv_a'",
          [tenantB, tenantA],
        ),
      ),
    ).rejects.toThrow("tenant_id is immutable");
  });

  it("rejects a goal state row for a conversation belonging to another tenant", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO conversation_goal_states (tenant_id, conversation_id)
         VALUES ($1, 'cnv_b')`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects an unrecognized status value", async () => {
    await adminPool.query(
      `INSERT INTO conversations
         (id, tenant_id, workspace_id, channel, temporal_workflow_id)
       VALUES ('cnv_c', $1, $2, 'web', 'tenant:a:channel:web:conversation:c')`,
      [tenantA, workspaceA],
    );

    await expect(
      adminPool.query(
        `INSERT INTO conversation_goal_states (tenant_id, conversation_id, status)
         VALUES ($1, 'cnv_c', 'not_a_real_status')`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
