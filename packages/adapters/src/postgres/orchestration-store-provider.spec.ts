import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignatureStatusSchema } from "@alterx/contracts";
import { PostgresOrchestrationStoreProvider } from "./orchestration-store-provider";

const migrationsFolder = resolve(
  process.cwd(),
  "apps/orchestration-service/drizzle",
);
const tenantA = "00000000-0000-7000-8000-000000000001";
const tenantB = "00000000-0000-7000-8000-000000000002";
const workspaceA = "00000000-0000-7000-8000-000000000011";
const workspaceB = "00000000-0000-7000-8000-000000000012";
const tables = [
  "workflows",
  "triggers",
  "trigger_versions",
  "conversations",
  "events",
  "runs",
] as const;

async function seed(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO workflows (id, tenant_id, workspace_id, name)
     VALUES ('wf_a', $1, $2, 'Workflow A'), ('wf_b', $3, $4, 'Workflow B')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
  await pool.query(
    `INSERT INTO triggers
       (id, tenant_id, workspace_id, workflow_id, name, type)
     VALUES
       ('trg_a', $1, $2, 'wf_a', 'Trigger A', 'webhook'),
       ('trg_b', $3, $4, 'wf_b', 'Trigger B', 'cron')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
  await pool.query(
    `INSERT INTO trigger_versions
       (id, tenant_id, trigger_id, version, config)
     VALUES
       ('trgv_a', $1, 'trg_a', 1, '{"kind":"webhook","provider":"shopify","dedup_window_seconds":300}'::jsonb),
       ('trgv_b', $2, 'trg_b', 1, '{"kind":"cron","cron_expression":"0 * * * *","timezone":"UTC"}'::jsonb)`,
    [tenantA, tenantB],
  );
  await pool.query(
    `INSERT INTO conversations
       (id, tenant_id, workspace_id, channel, temporal_workflow_id)
     VALUES
       ('cnv_a', $1, $2, 'web', 'tenant:a:channel:web:conversation:a'),
       ('cnv_b', $3, $4, 'api', 'tenant:b:channel:api:conversation:b')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
  await pool.query(
    `INSERT INTO events (
       event_id, event_type, schema_version, tenant_id, workspace_id,
       source, conversation_id, correlation_id, idempotency_key, occurred_at,
       trigger_id, trigger_version, payload, signature_status
     ) VALUES
       ('evt_a', 'order.created', '1.0.0', $1, $2, 'shopify', 'cnv_a',
        'corr_a', 'event-a', now(), 'trg_a', 1, '{}'::jsonb, 'verified'),
       ('evt_b', 'timer.fired', '1.0.0', $3, $4, 'schedule', 'cnv_b',
        'corr_b', 'event-b', now(), 'trg_b', 1, '{}'::jsonb, 'unverified')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
  await pool.query(
    `INSERT INTO runs (
       id, tenant_id, workspace_id, parent_kind, workflow_id,
       conversation_id, trigger_id
     ) VALUES
       ('run_a', $1, $2, 'workflow', 'wf_a', 'cnv_a', 'trg_a'),
       ('run_b', $3, $4, 'workflow', 'wf_b', 'cnv_b', 'trg_b')`,
    [tenantA, workspaceA, tenantB, workspaceB],
  );
}

describe.sequential("PostgresOrchestrationStoreProvider integration", () => {
  let container: StartedPostgreSqlContainer;
  let adminPool: Pool;
  let rolePool: Pool;
  let provider: PostgresOrchestrationStoreProvider;
  let roleProvider: PostgresOrchestrationStoreProvider;
  const role = `orchestration_test_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
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
  });

  afterAll(async () => {
    await roleProvider?.close();
    if (adminPool) {
      await adminPool.query(`DROP OWNED BY ${role}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await provider?.close();
    await container?.stop();
  });

  it("applies all six tables with forced RLS", async () => {
    const result = await adminPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
       WHERE pg_namespace.nspname = 'public'
         AND pg_class.relkind = 'r'
         AND relname = ANY($1::text[])
       ORDER BY relname`,
      [tables],
    );

    expect(result.rows).toHaveLength(6);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    }
  });

  it("enforces all declared foreign keys without cross-database references", async () => {
    const result = await adminPool.query<{
      table_name: string;
      foreign_table_name: string;
    }>(`
      SELECT
        source.relname AS table_name,
        target.relname AS foreign_table_name
      FROM pg_constraint constraint_record
      JOIN pg_class source ON source.oid = constraint_record.conrelid
      JOIN pg_class target ON target.oid = constraint_record.confrelid
      WHERE constraint_record.contype = 'f'
        AND source.relname = ANY(ARRAY[
          'triggers', 'trigger_versions', 'events', 'runs'
        ])
      ORDER BY source.relname, target.relname
    `);

    expect(result.rows).toHaveLength(12);
    expect(result.rows).toEqual(expect.arrayContaining([
      { table_name: "events", foreign_table_name: "conversations" },
      { table_name: "events", foreign_table_name: "triggers" },
      { table_name: "events", foreign_table_name: "trigger_versions" },
      { table_name: "runs", foreign_table_name: "conversations" },
      { table_name: "runs", foreign_table_name: "projects" },
      { table_name: "runs", foreign_table_name: "triggers" },
      { table_name: "runs", foreign_table_name: "workflows" },
      { table_name: "runs", foreign_table_name: "workflow_versions" },
      { table_name: "runs", foreign_table_name: "events" },
      { table_name: "runs", foreign_table_name: "events" },
      { table_name: "trigger_versions", foreign_table_name: "triggers" },
      { table_name: "triggers", foreign_table_name: "workflows" },
    ]));
  });

  it("defaults to deny and isolates reads and writes for every table", async () => {
    for (const table of tables) {
      const unset = await rolePool.query<{ count: string }>(
        `SELECT count(*) FROM ${table}`,
      );
      expect(unset.rows[0]?.count).toBe("0");
    }
    await expect(
      rolePool.query(
        `INSERT INTO workflows (id, tenant_id, workspace_id, name)
         VALUES ('wf_unscoped', $1, $2, 'Unscoped')`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await roleProvider.withTenant(tenantA, async (client) => {
      for (const table of tables) {
        const visible = await client.query<{ count: string }>(
          `SELECT count(*) FROM ${table}`,
        );
        expect(visible.rows[0]?.count).toBe("1");

        const blockedWrite = await client.query(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
          [tenantB],
        );
        expect(blockedWrite.rowCount).toBe(0);

        const ownWrite = await client.query(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
          [tenantA],
        );
        expect(ownWrite.rowCount).toBe(1);
      }
    });
  });

  it("rejects tenant_id mutation on every table", async () => {
    for (const table of tables) {
      await expect(
        roleProvider.withTenant(tenantA, async (client) =>
          client.query(
            `UPDATE ${table} SET tenant_id = $1 WHERE tenant_id = $2`,
            [tenantB, tenantA],
          ),
        ),
      ).rejects.toThrow("tenant_id is immutable");
    }
  });

  it("enforces dedup, trigger type, trigger version, and run parent constraints", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at, payload,
           signature_status
         ) VALUES (
           'evt_duplicate', 'order.created', '1.0.0', $1, $2, 'shopify',
           'corr_duplicate', 'event-a', now(), '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      adminPool.query(
        `INSERT INTO triggers
           (id, tenant_id, workspace_id, workflow_id, name, type)
         VALUES ('trg_invalid', $1, $2, 'wf_a', 'Invalid', 'queue')`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      adminPool.query(
        `INSERT INTO trigger_versions
           (id, tenant_id, trigger_id, version, config)
         VALUES ('trgv_duplicate', $1, 'trg_a', 1, '{}'::jsonb)`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      adminPool.query(
        `INSERT INTO runs
           (id, tenant_id, workspace_id, parent_kind)
         VALUES ('run_invalid', $1, $2, 'invalid')`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await adminPool.query(
      `INSERT INTO projects (id, tenant_id, workspace_id, name)
       VALUES ('prj_a', $1, $2, 'Project A')`,
      [tenantA, workspaceA],
    );
    await expect(
      adminPool.query(
        `INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, project_id)
         VALUES ('run_project_a', $1, $2, 'project', 'prj_a')`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      adminPool.query(
        `INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, project_id)
         VALUES ('run_project_cross_tenant', $1, $2, 'project', 'prj_a')`,
        [tenantB, workspaceB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects cross-tenant foreign keys and accepts same-tenant graph edges", async () => {
    await adminPool.query(
      `INSERT INTO triggers
         (id, tenant_id, workspace_id, workflow_id, name, type)
       VALUES ('trg_a_same_tenant', $1, $2, 'wf_a', 'Same Tenant', 'manual')`,
      [tenantA, workspaceA],
    );

    await expect(
      adminPool.query(
        `INSERT INTO triggers
           (id, tenant_id, workspace_id, workflow_id, name, type)
         VALUES ('trg_cross_workflow', $1, $2, 'wf_b', 'Cross Workflow', 'manual')`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, conversation_id, correlation_id, idempotency_key,
           occurred_at, payload, signature_status
         ) VALUES (
           'evt_cross_conversation', 'order.created', '1.0.0', $1, $2,
           'shopify', 'cnv_b', 'corr_cross_conversation',
           'event-cross-conversation', now(), '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_cross_trigger', 'order.created', '1.0.0', $1, $2,
           'shopify', 'corr_cross_trigger', 'event-cross-trigger',
           now(), 'trg_b', 1, '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO runs (
           id, tenant_id, workspace_id, parent_kind, workflow_id,
           conversation_id, trigger_id
         ) VALUES (
           'run_cross_edges', $1, $2, 'workflow', 'wf_b', 'cnv_b', 'trg_b'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO runs (
           id, tenant_id, workspace_id, parent_kind, workflow_id,
           conversation_id, trigger_id
         ) VALUES (
           'run_same_edges', $1, $2, 'workflow', 'wf_a', 'cnv_a',
           'trg_a_same_tenant'
         )`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("enforces trigger version provenance for events", async () => {
    await adminPool.query(
      `INSERT INTO triggers
         (id, tenant_id, workspace_id, workflow_id, name, type)
       VALUES ('trg_a_other', $1, $2, 'wf_a', 'Other Trigger', 'manual')`,
      [tenantA, workspaceA],
    );
    await adminPool.query(
      `INSERT INTO trigger_versions
         (id, tenant_id, trigger_id, version, config)
       VALUES ('trgv_a_other_2', $1, 'trg_a_other', 2, '{}'::jsonb)`,
      [tenantA],
    );

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_missing_trigger_version', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_missing_trigger_version',
           'event-missing-trigger-version', now(), 'trg_a', 99,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_wrong_tenant_trigger_version', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_wrong_tenant_trigger_version',
           'event-wrong-tenant-trigger-version', now(), 'trg_b', 1,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_wrong_trigger_version', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_wrong_trigger_version',
           'event-wrong-trigger-version', now(), 'trg_a', 2,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_valid_trigger_version', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_valid_trigger_version',
           'event-valid-trigger-version', now(), 'trg_a', 1,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("enforces trigger_id and trigger_version pairing for events", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at, payload,
           signature_status
         ) VALUES (
           'evt_untriggered_valid', 'message.received', '1.0.0',
           $1, $2, 'whatsapp', 'corr_untriggered_valid',
           'event-untriggered-valid', now(), '{}'::jsonb, 'unverified'
         )`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, trigger_version, payload, signature_status
         ) VALUES (
           'evt_triggered_valid', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_triggered_valid',
           'event-triggered-valid', now(), 'trg_a', 1,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_id, payload, signature_status
         ) VALUES (
           'evt_trigger_without_version', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_trigger_without_version',
           'event-trigger-without-version', now(), 'trg_a',
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           trigger_version, payload, signature_status
         ) VALUES (
           'evt_version_without_trigger', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_version_without_trigger',
           'event-version-without-trigger', now(), 1,
           '{}'::jsonb, 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps signature_status and payload parity with the public contract", async () => {
    for (const signatureStatus of SignatureStatusSchema.options) {
      await expect(
        adminPool.query(
          `INSERT INTO events (
             event_id, event_type, schema_version, tenant_id, workspace_id,
             source, correlation_id, idempotency_key, occurred_at, payload,
             signature_status
           ) VALUES (
             $1, 'order.created', '1.0.0', $2, $3, 'shopify', $4, $5,
             now(), '{}'::jsonb, $6
           )`,
          [
            `evt_signature_${signatureStatus}`,
            tenantA,
            workspaceA,
            `corr_signature_${signatureStatus}`,
            `event-signature-${signatureStatus}`,
            signatureStatus,
          ],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    }

    for (const invalidStatus of ["pending", "not_applicable"]) {
      await expect(
        adminPool.query(
          `INSERT INTO events (
             event_id, event_type, schema_version, tenant_id, workspace_id,
             source, correlation_id, idempotency_key, occurred_at, payload,
             signature_status
           ) VALUES (
             $1, 'order.created', '1.0.0', $2, $3, 'shopify', $4, $5,
             now(), '{}'::jsonb, $6
           )`,
          [
            `evt_signature_invalid_${invalidStatus}`,
            tenantA,
            workspaceA,
            `corr_signature_invalid_${invalidStatus}`,
            `event-signature-invalid-${invalidStatus}`,
            invalidStatus,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           payload_reference, signature_status
         ) VALUES (
           'evt_payload_reference_only', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_payload_reference_only',
           'event-payload-reference-only', now(),
           'art_00000000-0000-7000-8000-000000000001', 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      adminPool.query(
        `INSERT INTO events (
           event_id, event_type, schema_version, tenant_id, workspace_id,
           source, correlation_id, idempotency_key, occurred_at,
           signature_status
         ) VALUES (
           'evt_payload_missing', 'order.created', '1.0.0',
           $1, $2, 'shopify', 'corr_payload_missing',
           'event-payload-missing', now(), 'verified'
         )`,
        [tenantA, workspaceA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back and reapplies the complete migration chain", async () => {
    await provider.rollback();
    for (const table of tables) {
      const result = await adminPool.query<{ table_name: string | null }>(
        "SELECT to_regclass($1)::text AS table_name",
        [`public.${table}`],
      );
      expect(result.rows[0]?.table_name).toBeNull();
    }

    await provider.migrate();
    const reapplied = await adminPool.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [tables],
    );
    expect(reapplied.rows[0]?.count).toBe("6");
    await provider.rollback();
  });
});
