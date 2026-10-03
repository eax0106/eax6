import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityModule } from "../security.module";
import { orchestrationStore, identityTenantGatewayEnvironment } from "../orchestration-infrastructure.module";
import { WorkflowReadController } from "../workflow-read/workflow-read.controller";
import { WorkflowFoldersController } from "./workflow-folders.controller";
import { OrchestrationDeletionService } from "../deletion/deletion.service";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowFoldersService } from "./workflow-folders.service";

const tenant = uuidV7(), workspace = uuidV7(), otherWorkspace = uuidV7(), otherTenant = uuidV7();
const ten = `ten_${tenant}`, ws = `ws_${workspace}`, otherWs = `ws_${otherWorkspace}`, otherTen = `ten_${otherTenant}`;
const migrationsFolder = resolve("apps/orchestration-service/drizzle");

describe.sequential("Workflow folders on ordinary PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let folders: WorkflowFoldersService, workflows: WorkflowReadService, deletion: OrchestrationDeletionService;
  const role = `folders_${randomBytes(5).toString("hex")}`;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD 'folder-fixture-only' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = "folder-fixture-only";
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    folders = new WorkflowFoldersService(store); workflows = new WorkflowReadService(store); deletion = new OrchestrationDeletionService(store, admin);
  }, 120000);
  beforeEach(async () => {
    for (const id of [ten, otherTen]) await deletion.deleteSubjectData(id, `del_${uuidV7()}`);
  });
  afterAll(async () => { await store?.close(); await admin?.close(); await postgres?.stop(); });

  it("delivers folders through signed engine HTTP and the native public relay", async () => {
    const redis = await new RedisContainer("redis:7.4.2-alpine").start();
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "folders-native", alg: "RS256", use: "sig" };
    const issuer = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>(done => issuer.listen(0, "127.0.0.1", done));
    const jwks = `http://127.0.0.1:${(issuer.address() as { port: number }).port}/jwks`;
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = "folder-fixture-only";
    for (const [key, value] of Object.entries({ NODE_ENV: "test", AUTH0_DOMAIN: "folders.test", AUTH0_API_AUDIENCE: "alter-engine", API_AUDIENCE: "alter-engine", AUTH0_JWKS_URL: jwks,
      ACTOR_TOKEN_ISSUER: "alter-platform-api.identity-broker", ACTOR_TOKEN_AUDIENCE: "alter-engine", ACTOR_TOKEN_JWKS_URL: jwks,
      REDIS_ENDPOINT: redis.getConnectionUrl(), AWS_REGION: "ap-south-1", ALTER_ARTIFACTS_BUCKET_PARAM: "/fixture/artifacts", ORCHESTRATION_DATABASE_AUTHENTICATION: "static", ORCHESTRATION_DATABASE_URL: uri.href })) vi.stubEnv(key, value);
    let app: NestFastifyApplication | undefined, guardStore: PostgresOrchestrationStoreProvider | undefined;
    const directory = await mkdtemp(resolve(tmpdir(), "alter-folders-native-"));
    try {
      guardStore = orchestrationStore(identityTenantGatewayEnvironment(process.env));
      const module = await Test.createTestingModule({ imports: [SecurityModule], controllers: [WorkflowFoldersController, WorkflowReadController],
        providers: [{ provide: WorkflowFoldersService, useValue: folders }, { provide: WorkflowReadService, useValue: workflows }] }).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0, "127.0.0.1");
      const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: jwk.kid }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`; };
      const user = `usr_${uuidV7()}`;
      const headers = (overrides: Record<string, unknown> = {}) => {
        const now = Math.floor(Date.now() / 1000);
        return { "content-type": "application/json", authorization: `Bearer ${jwt({ iss: "https://folders.test/", aud: "alter-engine", iat: now, exp: now + 60 })}`,
          "x-alter-actor-token": jwt({ user_id: user, tenant_id: ten, workspace_id: ws, roles: ["admin"], permissions: ["workflows:read", "workflows:write"], session_id: "native-folders", auth_time: now, jti: uuidV7(), iss: "alter-platform-api.identity-broker", aud: "alter-engine", iat: now, exp: now + 60, ...overrides }) };
      };
      const url = `${await app.getUrl()}/api/v1/workflow-folders`;
      expect((await fetch(url)).status).toBe(401);
      const created = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ name: "Native HTTP" }) });
      expect(created.status).toBe(201); const folder = await created.json() as { id: string; etag: string };
      const reused = headers(); expect((await fetch(url, { headers: reused })).status).toBe(200); expect((await fetch(url, { headers: reused })).status).toBe(401);
      const viewer = { roles: ["viewer"], permissions: ["workflows:read"] };
      expect((await fetch(url, { headers: headers(viewer) })).status).toBe(200);
      expect((await fetch(url, { method: "POST", headers: headers(viewer), body: JSON.stringify({ name: "Refused" }) })).status).toBe(403);
      expect((await fetch(`${url}/${folder.id}`, { method: "PATCH", headers: headers({ workspace_id: otherWs }), body: JSON.stringify({ name: "Refused" }) })).status).toBe(404);
      const removeHeaders: Record<string, string> = headers(); delete removeHeaders["content-type"];
      expect((await fetch(`${url}/${folder.id}`, { method: "DELETE", headers: removeHeaders })).status).toBe(428);
      const workflow = await workflows.createWorkflow({ tenantId: ten, workspaceId: ws, name: "Native placement" });
      const other = await folders.create(ten, otherWs, { name: "Other workspace" });
      const reportPath = resolve(directory, "report.json");
      const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      await promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "apps/platform-api/src/workflow-folders/workflow-folders.integration.spec.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`],
        { env: { ...process.env, WORKFLOW_FOLDERS_NATIVE_BRIDGE: JSON.stringify({ baseUrl: await app.getUrl(), tenantId: ten, workspaceId: ws, otherWorkspaceId: otherWs, userId: user, workflowId: workflow.id, otherFolderId: other.id, privateKey }) }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }).catch(async () => {
          const report = JSON.parse(await readFile(reportPath, "utf8").catch(() => "{}")) as { testResults?: { assertionResults?: { failureMessages?: string[] }[] }[] };
          const failures = report.testResults?.flatMap(file => file.assertionResults?.flatMap(test => test.failureMessages ?? []) ?? []).join("\n") ?? "Native relay did not produce its report";
          throw Error(failures.replaceAll(privateKey, "[fixture key]").replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer [fixture token]"));
        });
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { success: boolean; numFailedTests: number; numPassedTests: number; numPendingTests: number };
      expect(report).toMatchObject({ success: true, numFailedTests: 0, numPassedTests: 1, numPendingTests: 0 });
    } finally { await app?.close(); await guardStore?.close(); vi.unstubAllEnvs(); await new Promise<void>(done => issuer.close(() => done())); await redis.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 180000);

  it("keeps CRUD, preconditions, moves and atomic folder deletion in the actual workspace", async () => {
    expect((await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const first = await folders.create(ten, ws, { name: " Finance " }), second = await folders.create(ten, otherWs, { name: "Other workspace" }), third = await folders.create(otherTen, ws, { name: "Other tenant" });
    expect(first.name).toBe("Finance");
    expect((await folders.list(ten, ws)).map(folder => folder.id)).toEqual([first.id]);
    expect((await folders.list(ten, otherWs)).map(folder => folder.id)).toEqual([second.id]);
    expect((await folders.list(otherTen, ws)).map(folder => folder.id)).toEqual([third.id]);
    await expect(folders.create("bad", ws, { name: "Invalid" })).rejects.toThrow();
    await expect(folders.create(ten, ws, { name: " " })).rejects.toThrow();
    await expect(folders.rename(ten, otherWs, first.id, { name: "Rejected" }, first.etag)).rejects.toMatchObject({ status: 404 });
    await expect(folders.rename(ten, ws, first.id, { name: "Rejected" })).rejects.toMatchObject({ status: 428 });
    const renamed = await folders.rename(ten, ws, first.id, { name: "Invoices" }, first.etag);
    await expect(folders.remove(ten, ws, first.id, first.etag)).rejects.toMatchObject({ status: 412 });
    const workflow = await workflows.createWorkflow({ tenantId: ten, workspaceId: ws, name: "Invoice triage" });
    const keptFolder = await folders.create(ten, ws, { name: "Separate folder" });
    const keptWorkflow = await workflows.createWorkflow({ tenantId: ten, workspaceId: ws, name: "Separate workflow" });
    const keptPlacement = await folders.move(ten, ws, keptWorkflow.id, { folderId: keptFolder.id }, (await folders.placement(ten, ws, keptWorkflow.id)).etag);
    const ungrouped = await folders.placement(ten, ws, workflow.id);
    expect(ungrouped.folderId).toBeNull();
    await expect(folders.move(ten, otherWs, workflow.id, { folderId: second.id }, ungrouped.etag)).rejects.toMatchObject({ status: 404 });
    await expect(folders.move(ten, ws, workflow.id, { folderId: second.id }, ungrouped.etag)).rejects.toMatchObject({ status: 404 });
    await expect(folders.move(ten, ws, workflow.id, { folderId: first.id })).rejects.toMatchObject({ status: 428 });
    const grouped = await folders.move(ten, ws, workflow.id, { folderId: first.id }, ungrouped.etag);
    await expect(folders.move(ten, ws, workflow.id, { folderId: null }, ungrouped.etag)).rejects.toMatchObject({ status: 412 });
    const run = `run_${uuidV7()}`;
    await store.withTenant(tenant, tx => tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id) VALUES($1,$2,$3,'workflow',$4)", [run, tenant, workspace, workflow.id]));
    const failing = new WorkflowFoldersService({ withTenant: (id, operation) => store.withTenant(id, tx => operation({ query: async (sql, values) => {
      if (sql.startsWith("DELETE FROM workflow_folders")) throw Error("folder-delete-fixture");
      return tx.query(sql, values);
    } })) });
    await expect(failing.remove(ten, ws, first.id, renamed.etag)).rejects.toThrow("folder-delete-fixture");
    expect(await folders.placement(ten, ws, workflow.id)).toEqual(grouped);
    await expect(folders.remove(ten, ws, first.id, renamed.etag)).resolves.toBeUndefined();
    expect(await folders.list(ten, ws)).toEqual([keptFolder]);
    expect(await folders.placement(ten, ws, keptWorkflow.id)).toEqual(keptPlacement);
    expect((await folders.placement(ten, ws, workflow.id)).folderId).toBeNull();
    expect((await folders.placement(ten, ws, workflow.id)).etag).not.toBe(grouped.etag);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM conversations WHERE tenant_id=$1 AND workflow_id=$2", [tenant, workflow.id]))).rows).toHaveLength(1);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM runs WHERE tenant_id=$1 AND id=$2", [tenant, run]))).rows).toEqual([{ id: run }]);
    const remaining = (await workflows.listWorkflows(ten, ws, undefined, 50)).data;
    expect(remaining).toHaveLength(2);
    expect(remaining).toContainEqual(expect.objectContaining({ id: workflow.id, folderId: null }));
    expect(remaining).toContainEqual(expect.objectContaining({ id: keptWorkflow.id, folderId: keptFolder.id }));
    expect((await folders.list(ten, otherWs)).map(folder => folder.id)).toEqual([second.id]);
    await expect(store.withTenant(tenant, tx => tx.query("UPDATE workflows SET folder_id=$3 WHERE tenant_id=$1 AND id=$2", [tenant, workflow.id, second.id]))).rejects.toThrow();
    const direct = await store.withTenant(tenant, tx => tx.query("SELECT id FROM workflow_folders WHERE tenant_id=$1", [otherTenant]));
    expect(direct.rows).toEqual([]);
  });

  it("rolls migration back and reapplies without destroying existing workflows or chats", async () => {
    const workflow = await workflows.createWorkflow({ tenantId: ten, workspaceId: ws, name: "Preserved" });
    const folder = await folders.create(ten, ws, { name: "Before rollback" });
    await folders.move(ten, ws, workflow.id, { folderId: folder.id }, (await folders.placement(ten, ws, workflow.id)).etag);
    const apply = async (file: string) => admin.withTenant(tenant, async tx => {
      for (const sql of readFileSync(resolve(migrationsFolder, file), "utf8").split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await tx.query(sql);
    });
    await apply("rollback/0052_restore_workflow_folders.sql");
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM workflows WHERE tenant_id=$1", [tenant]))).rows).toEqual([{ id: workflow.id }]);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM conversations WHERE tenant_id=$1 AND workflow_id=$2", [tenant, workflow.id]))).rows).toHaveLength(1);
    await apply("0052_workflow_folders.sql");
    await admin.withTenant(tenant, tx => tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON workflow_folders TO ${role}`));
    expect(await folders.placement(ten, ws, workflow.id)).toMatchObject({ folderId: null });
    expect(await folders.list(ten, ws)).toEqual([]);
    expect((await folders.create(ten, ws, { name: "After reapply" })).name).toBe("After reapply");
  });

  it("registers folders for workspace and tenant erasure, preserving other workspaces and tenants", async () => {
    const removed = await folders.create(ten, ws, { name: "Erase" }), kept = await folders.create(ten, otherWs, { name: "Keep" });
    const outside = await folders.create(otherTen, ws, { name: "Other tenant" });
    const workflow = await workflows.createWorkflow({ tenantId: ten, workspaceId: ws, name: "Erase with workspace" });
    await folders.move(ten, ws, workflow.id, { folderId: removed.id }, (await folders.placement(ten, ws, workflow.id)).etag);
    expect((await deletion.locateWorkspaceData(ten, ws)).find(location => location.table === "workflow_folders")?.rowCount).toBe(1);
    expect(await deletion.listSubjectIds()).toContain(otherTen);
    await deletion.deleteWorkspaceData(ten, ws, `del_${uuidV7()}`);
    expect((await deletion.verifyWorkspaceDeletion(ten, ws, `del_${uuidV7()}`)).deleted).toBe(true);
    expect((await folders.list(ten, otherWs)).map(folder => folder.id)).toEqual([kept.id]);
    await deletion.deleteSubjectData(ten, `del_${uuidV7()}`);
    expect((await deletion.verifyDeletion(ten, `del_${uuidV7()}`)).deleted).toBe(true);
    expect((await folders.list(otherTen, ws)).map(folder => folder.id)).toEqual([outside.id]);
  });
});
