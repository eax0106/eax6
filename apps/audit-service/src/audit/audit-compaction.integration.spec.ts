import { createHash, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { resolve } from "node:path";
import { PostgresAuditStoreProvider } from "@alterx/adapters";
import { connectPostgresTestClient, createPostgresTestPool, type PostgresTestClient, type PostgresTestPool } from "@alterx/adapters/testing";
import { auditGenesisHash, type AuditEventToAppend } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "./audit.service";
import { AUDIT_QUERY_SERVICE_TOKEN_HASH, AuditQueryController } from "./audit-query.controller";
import { createPlatformJobHandlers } from "../../../background-workers/src/platform-jobs/handlers";

const KEY = "compaction-fixture-signing-key-over-32-characters";
const A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
function event(tenantId = A, occurredAt = new Date()): AuditEventToAppend {
  return { id: randomUUID(), tenantId, tenantPseudonym: null, actorType: "admin",
    actorRef: "fixture-user", action: "run.finish", targetType: "workflow",
    targetRef: "fixture-workflow", result: "success", reasonCode: null,
    context: { request_id: "fixture-request" }, occurredAt };
}

describe.sequential("Audit closed-prefix compaction (Y2)", () => {
  let container: StartedPostgreSqlContainer;
  let admin: PostgresTestClient;
  let ordinary: PostgresTestPool;
  let retention: PostgresTestPool;
  let store: PostgresAuditStoreProvider;
  let service: AuditService;
  let app: NestFastifyApplication;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("audit_db").withUsername("audit_fixture_admin")
      .withPassword("disposable-fixture-only").start();
    admin = await connectPostgresTestClient(container.getConnectionUri());
    await admin.query("CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'fixture-app-only'");
    await admin.query("CREATE ROLE audit_retention LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'fixture-retention-only'");
    await admin.query("ALTER DATABASE audit_db OWNER TO audit_service");
    await admin.query("GRANT CREATE, USAGE ON SCHEMA public TO audit_service");
    const url = new URL(container.getConnectionUri());
    url.username = "audit_service"; url.password = "fixture-app-only";
    ordinary = createPostgresTestPool(url.toString());
    url.username = "audit_retention"; url.password = "fixture-retention-only";
    retention = createPostgresTestPool(url.toString());
    store = new PostgresAuditStoreProvider({ authentication: "static",
      connectionString: container.getConnectionUri(),
      migrationsFolder: resolve(process.cwd(), "apps/audit-service/drizzle") },
      { pool: ordinary, retentionPool: retention });
    await store.migrate();
    service = new AuditService(store, KEY);
    const moduleRef = await Test.createTestingModule({ controllers: [AuditQueryController], providers: [
      { provide: AuditService, useValue: service },
      { provide: AUDIT_QUERY_SERVICE_TOKEN_HASH, useValue: createHash("sha256").update("fixture-audit-token").digest("hex") },
    ] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
  }, 120_000);
  beforeEach(async () => {
    // This administrator owns only this disposable container, never shared data.
    await admin.query("TRUNCATE audit_events, audit_chain_checkpoints, deletion_ledger, deletion_certificates");
  });
  afterAll(async () => {
    await app?.close(); await store?.close(); await admin?.end(); await container?.stop();
  }, 60_000);

  it("seals before minimising; expiry respects completed deletion age and append order, not event time", async () => {
    for (const [tenant, time] of [[A, "2026-01-03"], [B, "2026-01-01"],
      [A, "2026-01-05"], [A, "2025-01-01"], [B, "2026-01-02"]] as const) {
      await store.append(event(tenant, new Date(time)));
    }
    await expect(store.minimiseTenantEvents(A, "tnp_fixture_a", new Date())).rejects.toThrow(/Signed audit prefix/);
    await service.sealChain();
    const seal = await store.getChainCheckpoint();
    expect(seal?.lastPosition).toBeGreaterThan(0);
    expect(seal?.signature).toHaveLength(32);
    expect(await store.minimiseTenantEvents(A, "tnp_fixture_a", new Date(0), seal)).toBe(3);
    const rows = (await store.queryEvents({ tenantId: null, limit: 200 })).events;
    expect(rows.filter(row => row.tenantPseudonym === "tnp_fixture_a")).toEqual([
      expect.objectContaining({ tenantId: null, actorRef: null, targetRef: null, reasonCode: null, context: null }),
      expect.objectContaining({ tenantId: null, actorRef: null, targetRef: null, reasonCode: null, context: null }),
      expect.objectContaining({ tenantId: null, actorRef: null, targetRef: null, reasonCode: null, context: null }),
    ]);
    expect(rows.find(row => row.tenantPseudonym !== null)!.erasedAt!.getFullYear()).toBeGreaterThan(2020);
    // Future caller time cannot expire newly minimised rows.
    expect((await service.compactSkeletons(new Date("2100-01-01"))).deletedRows).toBe(0);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE audit_events SET erased_at = transaction_timestamp() - interval '90 days' WHERE tenant_pseudonym = 'tnp_fixture_a'");
    await admin.query("COMMIT");
    // An old marker alone is insufficient: completion ledger must also be old.
    expect((await service.compactSkeletons()).deletedRows).toBe(0);
    await admin.query("INSERT INTO deletion_ledger VALUES ($1, 'tnp_fixture_a', '{}', transaction_timestamp() - interval '89 days 23 hours')", [randomUUID()]);
    expect((await service.compactSkeletons(new Date("2100-01-01"))).deletedRows).toBe(0);
    await admin.query("INSERT INTO deletion_ledger VALUES ($1, 'tnp_fixture_a', '{}', transaction_timestamp() - interval '90 days')", [randomUUID()]);
    expect((await service.compactSkeletons(new Date("2100-01-01"))).deletedRows).toBe(3);
    expect((await store.readGlobalChain()).length).toBe(2);
    await expect(service.verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 0 });
    await store.append(event(B, new Date("2020-01-01")));
    await expect(service.verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 1 });
    await expect(service.verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 1 });
    expect((await store.getChainCheckpoint())?.signature).toEqual(seal?.signature);
  });

  it("ordinary writes and function calls remain refused; retention has no table access", async () => {
    await store.append(event()); await service.sealChain();
    await ordinary.query("BEGIN");
    await ordinary.query("SELECT set_config('app.audit_internal', 'on', true)");
    await expect(ordinary.query("DELETE FROM audit_events")).rejects.toThrow(/immutable/);
    await ordinary.query("ROLLBACK");
    await expect(ordinary.query("SELECT minimise_audit_tenant($1, 'tnp_fixture', 1, $2)", [A, auditGenesisHash()])).rejects.toThrow(/retention identity/);
    await expect(ordinary.query("SELECT expire_audit_skeletons(now(), $1, 1)", [auditGenesisHash()])).rejects.toThrow(/retention identity/);
    await expect(retention.query("SELECT * FROM audit_events")).rejects.toThrow(/permission denied/);
    const role = await admin.query("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'audit_retention'");
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }]);
  });

  it("destroys a terminal skeleton and resumes append from the signed hash-only anchor", async () => {
    await store.append({ ...event(), actorType: "support", reasonCode: "fixture-support-reason" });
    const seal = await service.sealChain();
    expect(await store.minimiseTenantEvents(A, "tnp_terminal", new Date(), seal)).toBe(1);
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE audit_events SET erased_at = transaction_timestamp() - interval '91 days'");
    await admin.query("COMMIT");
    await admin.query("INSERT INTO deletion_ledger VALUES ($1, 'tnp_terminal', '{}', transaction_timestamp() - interval '91 days')", [randomUUID()]);
    const baseUrl = await app.getUrl();
    for (const token of [undefined, "wrong-fixture-token"]) {
      const response = await fetch(`${baseUrl}/internal/audit-events/skeletons/sweep`, {
        method: "POST", headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    }
    const handler = createPlatformJobHandlers({ auditServiceInternalBaseUrl: baseUrl,
      auditChainVerifyServiceToken: "fixture-audit-token" }).get("platform.audit-skeleton-retention-sweep")!;
    await expect(handler({})).resolves.toMatchObject({ deletedRows: 1 });
    expect(await store.readGlobalChain()).toEqual([]);
    await expect(service.verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 0 });
    await expect(store.append(event(B))).rejects.toThrow(/validated seal/);
    const appended = await store.append(event(B), await store.getChainCheckpoint());
    expect(appended.prevHash).toEqual(seal?.lastEntryHash);
    await expect(service.verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 1 });
  });

  it("rejects forged position or signature and never blesses an unsigned tampered prefix", async () => {
    const first = await store.append(event()); await service.sealChain();
    const seal = (await store.getChainCheckpoint())!;
    await admin.query("UPDATE audit_chain_checkpoints SET last_position = last_position + 1");
    await expect(service.verifyChain()).rejects.toThrow(/signature mismatch/);
    await expect(service.compactSkeletons()).rejects.toThrow(/signature mismatch/);
    await admin.query("UPDATE audit_chain_checkpoints SET last_position = $1", [seal.lastPosition]);
    await admin.query("UPDATE audit_chain_checkpoints SET signature = decode(repeat('01',32),'hex')");
    await expect(service.compactSkeletons()).rejects.toThrow(/signature mismatch/);
    await admin.query("UPDATE audit_chain_checkpoints SET signature = NULL");
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE audit_events SET context = '{\"request_id\":\"changed\"}' WHERE id = $1", [first.id]);
    await admin.query("COMMIT");
    await expect(service.verifyChain()).resolves.toMatchObject({ valid: false, issue: "hash-mismatch" });
    await expect(service.compactSkeletons()).rejects.toThrow(/segment invalid/);
    expect((await store.getChainCheckpoint())?.signature).toBeUndefined();
  });

  it("rejects a tampered post-seal row even with an erased marker; full verify does not advance seal", async () => {
    await store.append(event()); await service.sealChain();
    const seal = (await store.getChainCheckpoint())!;
    const victim = await store.append(event(B));
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE audit_events SET action = 'changed', erased_at = now() WHERE id = $1", [victim.id]);
    await admin.query("COMMIT");
    await expect(service.verifyChain()).resolves.toMatchObject({ valid: false, issue: "hash-mismatch" });
    await expect(service.verifyChainIncremental(5000)).resolves.toMatchObject({ valid: false, issue: "hash-mismatch" });
    await expect(service.compactSkeletons()).rejects.toThrow(/segment invalid/);
    expect((await store.getChainCheckpoint())?.signature).toEqual(seal.signature);
  });

  it("detects missing post-seal links and rejects a changed anchor without its signing key", async () => {
    await store.append(event()); await service.sealChain();
    const first = await store.append(event()); await store.append(event(B));
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("DELETE FROM audit_events WHERE id = $1", [first.id]); await admin.query("COMMIT");
    await expect(service.verifyChain()).resolves.toMatchObject({ valid: false, issue: "orphan" });
    await admin.query("UPDATE audit_chain_checkpoints SET last_entry_hash = $1", [Buffer.alloc(32, 7)]);
    await expect(service.verifyChain()).rejects.toThrow(/signature mismatch/);
  });
});
