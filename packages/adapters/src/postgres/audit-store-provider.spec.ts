import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUDIT_GENESIS_HASH_HEX,
  verifyAuditChain,
  type AuditEventToAppend,
} from "@alterx/shared-clients";
import { PostgresAuditStoreProvider } from "./audit-store-provider";

function event(index: number): AuditEventToAppend {
  return {
    id: randomUUID(),
    tenantId: "018f47a2-7b11-7b11-8a11-1234567890ab",
    tenantPseudonym: null,
    actorType: "service",
    actorRef: `svc_${index}`,
    action: "tool.invoke",
    targetType: "integration",
    targetRef: `integration-${index}`,
    result: "success",
    reasonCode: null,
    context: { request_id: `request-${index}`, ip_class: "private" },
    occurredAt: new Date(`2026-07-24T06:31:${String(index).padStart(2, "0")}.000Z`),
  };
}

describe.sequential("PostgresAuditStoreProvider", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let provider: PostgresAuditStoreProvider;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("audit_db")
      .withUsername("audit_test_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: container.getConnectionUri(),
        migrationsFolder: resolve(process.cwd(), "apps/audit-service/drizzle"),
      },
      { pool },
    );
    await provider.migrate();
  });

  afterAll(async () => {
    await provider.close();
    await container.stop();
  });

  it("applies exact immutable audit_events schema with forced RLS", async () => {
    const columns = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'audit_events'
      ORDER BY ordinal_position
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "id",
      "tenant_id",
      "tenant_pseudonym",
      "actor_type",
      "actor_ref",
      "action",
      "target_type",
      "target_ref",
      "result",
      "reason_code",
      "context",
      "occurred_at",
      "prev_hash",
      "entry_hash",
      "erased_at",
      "chain_position",
    ]);

    const table = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'audit_events'::regclass
    `);
    expect(table.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  it("stores a deletion certificate and ledger atomically without a raw tenant ID", async () => {
    const tenantId = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
    const pseudonym = "tnp_2ba0b21d4bf47fb593b90a7e7289a8e633097e791a0fd57e129ce13240af3d64";
    const completedAt = new Date("2026-07-30T10:00:00.000Z");
    await provider.storeDeletionCompletion(
      {
        id: randomUUID(),
        tenantPseudonym: pseudonym,
        manifest: { status: "completed", providers: ["ads-core", "orchestration-service"] },
        requestedAt: new Date("2026-07-30T09:59:00.000Z"),
        completedAt,
        verifiedBy: "audit-service/deletion-orchestrator",
      },
      {
        id: randomUUID(),
        subjectPseudonym: pseudonym,
        subjectSelectors: { scheme: "hmac-sha256-v1" },
        deletedAt: completedAt,
      },
    );

    const records = await pool.query<{
      certificate: string;
      ledger: string;
    }>(
      `SELECT row_to_json(c)::text AS certificate, row_to_json(l)::text AS ledger
       FROM deletion_certificates c CROSS JOIN deletion_ledger l`,
    );
    expect(records.rows).toHaveLength(1);
    const serialized = JSON.stringify(records.rows);
    expect(serialized).toContain(pseudonym);
    expect(serialized).not.toContain(tenantId);
    await expect(provider.listDeletionLedgerSince(new Date("2026-07-30T00:00:00.000Z"))).resolves.toEqual([
      expect.objectContaining({ subjectPseudonym: pseudonym, deletedAt: completedAt }),
    ]);

    await expect(pool.query("UPDATE deletion_ledger SET deleted_at=now()"))
      .rejects.toMatchObject({ code: "P0001" });
    await expect(pool.query("DELETE FROM deletion_certificates"))
      .rejects.toMatchObject({ code: "P0001" });
  });

  it("rolls back the ledger insert when atomic certificate persistence fails", async () => {
    const ledgerId = randomUUID();
    const pseudonym = "tnp_f2f12543c4ddf8304015a81fc9ee7e5f6fdad53d85d9a8cd48c37ed5fe40b6d1";
    await expect(provider.storeDeletionCompletion(
      {
        id: "not-a-uuid",
        tenantPseudonym: pseudonym,
        manifest: { status: "completed" },
        requestedAt: new Date("2026-07-30T10:00:00.000Z"),
        completedAt: new Date("2026-07-30T10:01:00.000Z"),
        verifiedBy: "audit-service/deletion-orchestrator",
      },
      {
        id: ledgerId,
        subjectPseudonym: pseudonym,
        subjectSelectors: { scheme: "hmac-sha256-v1" },
        deletedAt: new Date("2026-07-30T10:01:00.000Z"),
      },
    )).rejects.toMatchObject({ code: "22P02" });

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM deletion_ledger WHERE id=$1",
      [ledgerId],
    );
    expect(result.rows).toEqual([{ count: "0" }]);
  });

  it("validates config and reports unreachable database health", async () => {
    expect(
      () =>
        new PostgresAuditStoreProvider({
          authentication: "static",
          connectionString: "",
          migrationsFolder: "migrations",
        }),
    ).toThrow(/connectionString/);
    expect(
      () =>
        new PostgresAuditStoreProvider({
          authentication: "static",
          connectionString: "postgresql://127.0.0.1:1/audit",
          migrationsFolder: "",
        }),
    ).toThrow(/migrationsFolder/);

    const unreachable = new PostgresAuditStoreProvider({
      authentication: "static",
      connectionString: "postgresql://127.0.0.1:1/audit",
      migrationsFolder: resolve(process.cwd(), "apps/audit-service/drizzle"),
    });
    await expect(unreachable.healthCheck()).resolves.toMatchObject({
      status: "unhealthy",
    });
    await unreachable.close();
  });

  it("appends genesis and serializes concurrent writes", async () => {
    const first = await provider.append(event(0));
    expect(first.prevHash.toString("hex")).toBe(AUDIT_GENESIS_HASH_HEX);
    expect(first.entryHash).toHaveLength(32);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => provider.append(event(index + 1))),
    );
    expect(verifyAuditChain(await provider.readGlobalChain())).toEqual({
      valid: true,
      checkedEvents: 9,
    });
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: "healthy",
    });
  });

  it("keeps RLS default-deny and allows internal audit_service reads only", async () => {
    const password = randomBytes(24).toString("hex");
    const otherRole = `other_service_${randomBytes(6).toString("hex")}`;
    await pool.query(`CREATE ROLE audit_service LOGIN PASSWORD '${password}'`);
    await pool.query(`CREATE ROLE ${otherRole} LOGIN PASSWORD '${password}'`);
    await pool.query("GRANT CONNECT ON DATABASE audit_db TO audit_service");
    await pool.query(`GRANT CONNECT ON DATABASE audit_db TO ${otherRole}`);
    await pool.query("GRANT USAGE ON SCHEMA public TO audit_service");
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${otherRole}`);
    await pool.query("GRANT SELECT ON audit_events TO audit_service");
    await pool.query(`GRANT SELECT ON audit_events TO ${otherRole}`);

    const rolePool = (user: string) =>
      new Pool({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user,
        password,
      });
    const auditRolePool = rolePool("audit_service");
    const otherRolePool = rolePool(otherRole);
    try {
      await expect(
        auditRolePool.query<{ count: string }>(
          "SELECT count(*) FROM audit_events",
        ),
      ).resolves.toMatchObject({ rows: [{ count: "0" }] });

      const auditClient = await auditRolePool.connect();
      try {
        await auditClient.query("BEGIN");
        await auditClient.query(
          "SELECT set_config('app.audit_internal', 'on', true)",
        );
        const visible = await auditClient.query<{ count: string }>(
          "SELECT count(*) FROM audit_events",
        );
        expect(visible.rows[0]?.count).toBe("9");
        await auditClient.query("ROLLBACK");
      } finally {
        auditClient.release();
      }

      const otherClient = await otherRolePool.connect();
      try {
        await otherClient.query("BEGIN");
        await otherClient.query(
          "SELECT set_config('app.audit_internal', 'on', true)",
        );
        const visible = await otherClient.query<{ count: string }>(
          "SELECT count(*) FROM audit_events",
        );
        expect(visible.rows[0]?.count).toBe("0");
        await otherClient.query("ROLLBACK");
      } finally {
        otherClient.release();
      }
    } finally {
      await auditRolePool.end();
      await otherRolePool.end();
      await pool.query("DROP OWNED BY audit_service");
      await pool.query(`DROP OWNED BY ${otherRole}`);
      await pool.query("DROP ROLE audit_service");
      await pool.query(`DROP ROLE ${otherRole}`);
    }
  });

  it("rejects UPDATE, DELETE, and missing break-glass reason", async () => {
    await expect(
      pool.query(
        "UPDATE audit_events SET action = 'tampered' WHERE id = (SELECT id FROM audit_events LIMIT 1)",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        "DELETE FROM audit_events WHERE id = (SELECT id FROM audit_events LIMIT 1)",
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `
          INSERT INTO audit_events (
            id, actor_type, actor_ref, action, result, occurred_at,
            prev_hash, entry_hash
          ) VALUES ($1, 'admin', 'admin-1', 'support.access.grant', 'success', now(), $2, $3)
        `,
        [randomUUID(), randomBytes(32), randomBytes(32)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("detects privileged corruption through shared verifier", async () => {
    const selected = await pool.query<{
      id: string;
      context: Readonly<Record<string, unknown>>;
    }>("SELECT id, context FROM audit_events ORDER BY id LIMIT 1");
    const row = selected.rows[0];
    expect(row).toBeDefined();

    await pool.query(
      "ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable",
    );
    await pool.query("UPDATE audit_events SET context = $1 WHERE id = $2", [
      { request_id: "privileged-corruption" },
      row?.id,
    ]);
    await pool.query(
      "ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable",
    );
    expect(verifyAuditChain(await provider.readGlobalChain())).toMatchObject({
      valid: false,
      issue: "hash-mismatch",
    });

    await pool.query(
      "ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable",
    );
    await pool.query("UPDATE audit_events SET context = $1 WHERE id = $2", [
      row?.context,
      row?.id,
    ]);
    await pool.query(
      "ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable",
    );
    expect(verifyAuditChain(await provider.readGlobalChain())).toEqual({
      valid: true,
      checkedEvents: 9,
    });
  });

  it("queryEvents scopes by tenant, filters by actor_type, and paginates via real keyset cursor", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const marker = `query-test-${randomUUID()}`;
    const rows: AuditEventToAppend[] = [
      { ...event(900), id: randomUUID(), tenantId: tenantA, actorType: "user", action: marker, occurredAt: new Date("2027-01-01T00:00:00.000Z") },
      { ...event(901), id: randomUUID(), tenantId: tenantA, actorType: "support", action: marker, reasonCode: "ticket-99", occurredAt: new Date("2027-01-01T00:01:00.000Z") },
      { ...event(902), id: randomUUID(), tenantId: tenantA, actorType: "admin", action: marker, occurredAt: new Date("2027-01-01T00:02:00.000Z") },
      { ...event(903), id: randomUUID(), tenantId: tenantB, actorType: "user", action: marker, occurredAt: new Date("2027-01-01T00:03:00.000Z") },
    ];
    for (const row of rows) {
      await provider.append(row);
    }

    const tenantScoped = await provider.queryEvents({ tenantId: tenantA, action: marker, limit: 50 });
    expect(tenantScoped.events).toHaveLength(3);
    expect(tenantScoped.events.every((event_) => event_.tenantId === tenantA)).toBe(true);

    const actorFiltered = await provider.queryEvents({
      tenantId: tenantA,
      action: marker,
      actorTypes: ["user", "support"],
      limit: 50,
    });
    expect(actorFiltered.events).toHaveLength(2);

    const crossTenant = await provider.queryEvents({ tenantId: null, action: marker, limit: 50 });
    expect(crossTenant.events).toHaveLength(4);

    const page1 = await provider.queryEvents({ tenantId: null, action: marker, limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    if (page1.nextCursor === null) {
      throw new Error("Expected a real cursor from the first page");
    }
    const page2 = await provider.queryEvents({
      tenantId: null,
      action: marker,
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.events).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const allIds = new Set([...page1.events, ...page2.events].map((event_) => event_.id));
    expect(allIds.size).toBe(4);
  });

  it("readChainSince walks forward via the real recursive CTE, bounded by limit", async () => {
    // event()'s occurredAt embeds the index as a seconds field (00-59) --
    // 11/12/13 stay clear of the other tests' 0-10 and 900+ indices in this
    // shared-table file. Placed last (before the destructive rollback
    // test), and asserts only hash-relative behavior (readChainSince from
    // a specific entryHash), never absolute chain content -- every earlier
    // test in this file leaves real rows behind, and two of them
    // (verifyAuditChain checkedEvents: 9) hardcode an absolute count that
    // would break if this test's inserts ran before them.
    const first = await provider.append(event(11));
    const second = await provider.append(event(12));
    const third = await provider.append(event(13));

    const fromFirst = await provider.readChainSince(first.entryHash, 10);
    expect(fromFirst.map((e) => e.id)).toEqual([second.id, third.id]);

    const bounded = await provider.readChainSince(first.entryHash, 1);
    expect(bounded.map((e) => e.id)).toEqual([second.id]);

    // A hash that isn't in the chain at all is a broken anchor (a checkpoint
    // naming a row that does not exist), refused rather than read as "no
    // successors": silently returning [] would let verification pass over
    // a missing row (D2 compaction keeps the anchor by position instead).
    const unknownHash = Buffer.alloc(32, 7);
    await expect(provider.readChainSince(unknownHash, 10)).rejects.toThrow("Audit checkpoint anchor missing");
  });

  it("persists a chain checkpoint across reads and real upsert", async () => {
    await expect(provider.getChainCheckpoint()).resolves.toBeUndefined();

    const stored = await provider.append(event(14));
    const verifiedAt = new Date("2026-08-01T00:00:00.000Z");
    await provider.setChainCheckpoint({
      lastEntryHash: stored.entryHash,
      checkedEvents: 1,
      verifiedAt,
    });

    const checkpoint = await provider.getChainCheckpoint();
    expect(checkpoint?.lastEntryHash).toEqual(stored.entryHash);
    expect(checkpoint?.checkedEvents).toBe(1);
    expect(checkpoint?.verifiedAt).toEqual(verifiedAt);

    // Real ON CONFLICT upsert, not a second row.
    const second = await provider.append(event(15));
    await provider.setChainCheckpoint({
      lastEntryHash: second.entryHash,
      checkedEvents: 2,
      verifiedAt: new Date("2026-08-02T00:00:00.000Z"),
    });
    const rowCount = await pool.query(
      "SELECT count(*)::int AS n FROM audit_chain_checkpoints",
    );
    expect(rowCount.rows[0]?.n).toBe(1);
  });

  it("executes rollback migration", async () => {
    const rollback = await readFile(
      resolve(
        process.cwd(),
        "apps/audit-service/drizzle/rollback/0000_drop_audit_events.sql",
      ),
      "utf8",
    );
    await pool.query(rollback);
    const result = await pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.audit_events')::text AS table_name",
    );
    expect(result.rows[0]?.table_name).toBeNull();
    await expect(provider.readGlobalChain()).rejects.toMatchObject({
      code: "42P01",
    });
    await expect(provider.append(event(10))).rejects.toMatchObject({
      code: "42P01",
    });
  });
});
