import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  PostgresAuditStoreProvider,
  PostgresOrchestrationStoreProvider,
} from "@alterx/adapters";
import { ProblemDetailsSchema } from "@alterx/contracts";
import { createMockObjectStorageProvider } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DeletionController as OrchestrationDeletionController,
  ORCHESTRATION_DELETION_TOKEN_HASH,
} from "../../../orchestration-service/src/deletion/deletion.controller";
import { OrchestrationDeletionService } from "../../../orchestration-service/src/deletion/deletion.service";
import { DeletionOrchestrator } from "./deletion-orchestrator";
import { HttpDeletionProvider } from "./http-deletion-provider";
import { AuditService } from "../audit/audit.service";

const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const TENANT_A_REQUEST = `ten_${TENANT_A}`;
const TOKEN = "know16-internal-integration-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const KEY = "know16-integration-hmac-key-material-at-least-32-characters";
const migrations = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const auditMigrations = resolve(process.cwd(), "apps/audit-service/drizzle");

describe.sequential("KNOW-16 full right-to-delete flow", () => {
  let adsDatabase: StartedPostgreSqlContainer;
  let orchestrationDatabase: StartedPostgreSqlContainer;
  let auditDatabase: StartedPostgreSqlContainer;
  let adsStore: PostgresOrchestrationStoreProvider;
  let orchestrationStore: PostgresOrchestrationStoreProvider;
  let auditStore: PostgresAuditStoreProvider;
  let adsProcess: ChildProcess;
  let orchestrationApp: NestFastifyApplication;
  let adsUrl: string;
  let orchestrationUrl: string;

  beforeAll(async () => {
    [adsDatabase, orchestrationDatabase, auditDatabase] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg16").withDatabase("ads_db").withUsername("ads_admin").withPassword(randomBytes(24).toString("hex")).start(),
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("orchestration_admin").withPassword(randomBytes(24).toString("hex")).start(),
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("audit_db").withUsername("audit_admin").withPassword(randomBytes(24).toString("hex")).start(),
    ]);

    const adsSyncUrl = adsDatabase.getConnectionUri().replace(/^postgres:/, "postgresql:");
    execFileSync("uv", ["run", "alembic", "-c", "alembic.ini", "upgrade", "head"], {
      cwd: resolve(process.cwd(), "apps/ads-core"),
      env: {
        ...process.env,
        ADS_DB_URL_SYNC: adsSyncUrl,
        DELETION_SERVICE_TOKEN_SHA256: TOKEN_HASH,
      },
      stdio: "ignore",
    });
    adsStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: adsSyncUrl,
      migrationsFolder: migrations,
    });
    orchestrationStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: orchestrationDatabase.getConnectionUri(),
      migrationsFolder: migrations,
    });
    await orchestrationStore.migrate();
    const auditAdmin = new pg.Client({ connectionString: auditDatabase.getConnectionUri() });
    await auditAdmin.connect();
    try {
      await auditAdmin.query("CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'fixture-app-only'");
      await auditAdmin.query("CREATE ROLE audit_retention LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'fixture-retention-only'");
      await auditAdmin.query("ALTER DATABASE audit_db OWNER TO audit_service");
      await auditAdmin.query("GRANT USAGE, CREATE ON SCHEMA public TO audit_service");
    } finally { await auditAdmin.end(); }
    const auditUrl = new URL(auditDatabase.getConnectionUri());
    auditUrl.username = "audit_service"; auditUrl.password = "fixture-app-only";
    const retentionUrl = new URL(auditUrl);
    retentionUrl.username = "audit_retention"; retentionUrl.password = "fixture-retention-only";
    auditStore = new PostgresAuditStoreProvider({
      authentication: "static",
      connectionString: auditUrl.toString(),
      retentionConnectionString: retentionUrl.toString(),
      migrationsFolder: auditMigrations,
    });
    await auditStore.migrate();
    await seedAds(adsStore, TENANT_A, "a");
    await seedAds(adsStore, TENANT_B, "b");
    await seedOrchestration(orchestrationStore, TENANT_A, "a");
    await seedOrchestration(orchestrationStore, TENANT_B, "b");

    const adsPort = await freePort();
    adsUrl = `http://127.0.0.1:${adsPort}`;
    adsProcess = spawn("uv", [
      "run", "python", "-m", "uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", String(adsPort),
    ], {
      cwd: resolve(process.cwd(), "apps/ads-core"),
      env: {
        ...process.env,
        ADS_DB_URL_SYNC: adsSyncUrl,
        ADS_DB_URL: adsSyncUrl.replace("postgresql://", "postgresql+asyncpg://"),
        ADS_DELETION_DB_URL_SYNC: adsSyncUrl,
        DELETION_SERVICE_TOKEN_SHA256: TOKEN_HASH,
        INTERNAL_SERVICE_TOKEN_SHA256: TOKEN_HASH,
      },
      stdio: "ignore",
    });
    await waitHealthy(`${adsUrl}/health`);

    const orchestrationModule = await Test.createTestingModule({
      controllers: [OrchestrationDeletionController],
      providers: [
        { provide: OrchestrationDeletionService, useValue: new OrchestrationDeletionService(orchestrationStore, orchestrationStore) },
        { provide: ORCHESTRATION_DELETION_TOKEN_HASH, useValue: TOKEN_HASH },
      ],
    }).compile();
    orchestrationApp = orchestrationModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await orchestrationApp.listen(0, "127.0.0.1");
    orchestrationUrl = await orchestrationApp.getUrl();
  }, 120_000);

  afterAll(async () => {
    await orchestrationApp?.close();
    adsProcess?.kill("SIGTERM");
    await adsStore?.close();
    await orchestrationStore?.close();
    await auditStore?.close();
    await Promise.all([
      adsDatabase?.stop(), orchestrationDatabase?.stop(), auditDatabase?.stop(),
    ]);
  }, 60_000);

  it("executes manifest, object purge, both database purges, verification, and certificate", async () => {
    for (const baseUrl of [adsUrl, orchestrationUrl]) {
      const unauthorized = await fetch(`${baseUrl}/internal/deletion/subjects`);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("content-type")).toContain("application/problem+json");
      const problem = ProblemDetailsSchema.parse(await unauthorized.json());
      expect(problem).toMatchObject({ status: 401, error_code: "DELETION_AUTHENTICATION_FAILED" });
      expect(JSON.stringify(problem)).not.toContain(TENANT_A);
    }
    const adsOpenApi = await (await fetch(`${adsUrl}/openapi.json`)).json() as { paths: Record<string, unknown> };
    expect(Object.keys(adsOpenApi.paths)).not.toContain("/internal/deletion/subjects");
    const invalid = await fetch(`${adsUrl}/internal/deletion/locate?tenantId=sensitive-subject`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(invalid.status).toBe(400);
    const invalidProblem = ProblemDetailsSchema.parse(await invalid.json());
    expect(invalidProblem.error_code).toBe("DELETION_VALIDATION_FAILED");
    expect(JSON.stringify(invalidProblem)).not.toContain("sensitive-subject");

    const objectReference = `s3://ads-private/${TENANT_A}/doc_a/content`;
    const objects = createMockObjectStorageProvider([objectReference]);
    const orchestrator = new DeletionOrchestrator(
      auditStore,
      [
        new HttpDeletionProvider(adsUrl, TOKEN, "ads-core"),
        new HttpDeletionProvider(orchestrationUrl, TOKEN, "orchestration-service"),
      ],
      objects,
      KEY,
      () => new AuditService(auditStore, KEY).sealChain(),
    );

    await expect(orchestrator.execute(TENANT_A_REQUEST)).resolves.toMatchObject({ completed: true });
    expect(objects.deletedReferences).toEqual([objectReference]);
    expect(await adsCounts(adsStore, TENANT_A)).toEqual(Array(9).fill(0));
    expect(await adsCounts(adsStore, TENANT_B)).toEqual(Array(9).fill(1));
    expect(await orchestrationCounts(orchestrationStore, TENANT_A)).toEqual(Array(4).fill(0));
    expect(await orchestrationCounts(orchestrationStore, TENANT_B)).toEqual(Array(4).fill(1));

    const persisted = await auditStore.listDeletionLedgerSince(new Date("2026-01-01T00:00:00Z"));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(TENANT_A_REQUEST);
    expect(JSON.stringify(persisted)).not.toContain(TENANT_A);
    const auditProbe = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: auditDatabase.getConnectionUri(),
      migrationsFolder: migrations,
    });
    try {
      const records = await auditProbe.withTenant(TENANT_A, (tx) => tx.query<{ record: string }>(
          `SELECT row_to_json(record)::text AS record FROM (
             SELECT tenant_pseudonym,manifest,requested_at,completed_at,verified_by
             FROM deletion_certificates
             UNION ALL
             SELECT subject_pseudonym,subject_selectors,NULL,NULL,NULL FROM deletion_ledger
           ) record`,
        ));
      const serialized = JSON.stringify(records.rows);
      expect(serialized).not.toContain(TENANT_A_REQUEST);
      expect(serialized).not.toContain(TENANT_A);
      expect(serialized).not.toContain(objectReference);
      expect(serialized).not.toContain(KEY);
    } finally {
      await auditProbe.close();
    }

    // Simulate a restore that resurrects already-deleted rows and its S3 object.
    await seedAds(adsStore, TENANT_A, "a");
    await seedOrchestration(orchestrationStore, TENANT_A, "a");
    objects.put(objectReference);
    await expect(
      orchestrator.replayDeletionLedger("2026-01-01T00:00:00.000Z"),
    ).resolves.toMatchObject({ ledgerEntriesReplayed: 1 });
    expect(await adsCounts(adsStore, TENANT_A)).toEqual(Array(9).fill(0));
    expect(await orchestrationCounts(orchestrationStore, TENANT_A)).toEqual(Array(4).fill(0));
    expect(await adsCounts(adsStore, TENANT_B)).toEqual(Array(9).fill(1));
    expect(await orchestrationCounts(orchestrationStore, TENANT_B)).toEqual(Array(4).fill(1));
  });
});

async function seedAds(store: PostgresOrchestrationStoreProvider, tenant: string, suffix: string) {
  const vector = `[${Array(1024).fill(0).join(",")}]`;
  await store.withTenant(tenant, async (tx) => {
    await tx.query("INSERT INTO scopes(id,tenant_id,workspace_id) VALUES ($1,$2,$2)", [`scp_${suffix}`, tenant]);
    await tx.query("INSERT INTO sources(id,tenant_id,scope_id,kind) VALUES ($1,$2,$3,'upload')", [`src_${suffix}`, tenant, `scp_${suffix}`]);
    await tx.query("INSERT INTO ingestion_jobs(id,tenant_id,source_id,stage,completed_at) VALUES ($1,$2,$3,'indexed',now())", [`job_${suffix}`, tenant, `src_${suffix}`]);
    await tx.query("INSERT INTO documents(id,tenant_id,scope_id,source_id,kind,current_version) VALUES ($1,$2,$3,$4,'file',1)", [`doc_${suffix}`, tenant, `scp_${suffix}`, `src_${suffix}`]);
    await tx.query("INSERT INTO document_versions(document_id,version,content_ref,provenance,ingestion_job_id) VALUES ($1,1,$2,'{}',$3)", [`doc_${suffix}`, `s3://ads-private/${tenant}/doc_${suffix}/content`, `job_${suffix}`]);
    await tx.query("INSERT INTO chunks(id,tenant_id,scope_id,document_id,document_version,seq,text_content,embedding,embedding_provider,embedding_model,embedding_version) VALUES ($1,$2,$3,$4,1,0,'content',$5::vector,'mock','mock','v1')", [`chk_${suffix}`, tenant, `scp_${suffix}`, `doc_${suffix}`, vector]);
    await tx.query("INSERT INTO records(id,tenant_id,scope_id,source_id,entity_type,external_key,body,version) VALUES ($1,$2,$3,$4,'fixture',$5,'{}',1)", [`rec_${suffix}`, tenant, `scp_${suffix}`, `src_${suffix}`, suffix]);
    await tx.query("INSERT INTO memory_namespace(id,tenant_id,scope_id,kind,statement,provenance) VALUES ($1,$2,$3,'project_fact','fixture','{}')", [`mem_${suffix}`, tenant, `scp_${suffix}`]);
    await tx.query("INSERT INTO retrieval_audit(id,tenant_id,scope_id,requester) VALUES ($1,$2,$3,'fixture')", [`ret_${suffix}`, tenant, `scp_${suffix}`]);
  });
}

async function seedOrchestration(store: PostgresOrchestrationStoreProvider, tenant: string, suffix: string) {
  await store.withTenant(tenant, async (tx) => {
    await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES ($1,$2,$2,'fixture')", [`wf_${suffix}`, tenant]);
    await tx.query("INSERT INTO conversations(id,tenant_id,workspace_id,channel,temporal_workflow_id) VALUES ($1,$2,$2,'api',$3)", [`conv_${suffix}`, tenant, `temporal-${suffix}`]);
    await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,conversation_id) VALUES ($1,$2,$2,'workflow',$3,$4)", [`run_${suffix}`, tenant, `wf_${suffix}`, `conv_${suffix}`]);
    await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES ($1,$2,$3,'fixture','Merge','succeeded')", [`node_${suffix}`, tenant, `run_${suffix}`]);
  });
}

async function adsCounts(store: PostgresOrchestrationStoreProvider, tenant: string) {
  const tables = ["scopes", "sources", "documents", "document_versions", "chunks", "records", "memory_namespace", "ingestion_jobs", "retrieval_audit"];
  return store.withTenant(tenant, async (tx) => {
    const counts: number[] = [];
    for (const table of tables) {
      const condition = table === "document_versions" ? "document_id IN (SELECT id FROM documents WHERE tenant_id=$1)" : "tenant_id=$1";
      const result = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE ${condition}`, [tenant]);
      counts.push(Number(result.rows[0]?.count ?? 0));
    }
    return counts;
  });
}

async function orchestrationCounts(store: PostgresOrchestrationStoreProvider, tenant: string) {
  return store.withTenant(tenant, async (tx) => {
    const counts: number[] = [];
    for (const table of ["workflows", "conversations", "runs", "node_executions"]) {
      const result = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE tenant_id=$1`, [tenant]);
      counts.push(Number(result.rows[0]?.count ?? 0));
    }
    return counts;
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitHealthy(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("ADS deletion integration server did not become healthy");
}
