import "reflect-metadata";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ActorTokenValidator, M2mValidator, RedisReplayStore, RedisRespSetClient, SessionGatewayGuard } from "@alterx/auth";
import { AuditServiceClient, PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { expect, it } from "vitest";

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const other = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const run = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";

it("records service-asserted summary reads through native HTTP and audit gRPC", async () => {
  let postgres: StartedPostgreSqlContainer | undefined, redis: StartedRedisContainer | undefined;
  let admin: PostgresOrchestrationStoreProvider | undefined, store: PostgresOrchestrationStoreProvider | undefined;
  let app: NestFastifyApplication | undefined, issuer: Server | undefined, child: ChildProcess | undefined;
  const directory = mkdtempSync(resolve(tmpdir(), "alter-learning-audit-"));
  try {
    const build = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "apps/orchestration-service/tsconfig.app.json"], { encoding: "utf8", timeout: 120_000 });
    expect(build.status, "Engine build must pass before testing its production controller").toBe(0);
    const require = createRequire(resolve("package.json"));
    const { RunLearningController, RUN_LEARNING_AUDIT } = require(resolve("dist/apps/orchestration-service/runs/run-learning.controller.js"));
    const { RunOutcomeService } = require(resolve("dist/apps/orchestration-service/runs/run-outcome.service.js"));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "learning-audit", alg: "RS256", use: "sig" };
    issuer = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>(resolve => issuer!.listen(0, "127.0.0.1", resolve));
    const jwksUrl = `http://127.0.0.1:${(issuer.address() as { port: number }).port}/jwks`;
    const token = () => {
      const now = Math.floor(Date.now() / 1000);
      const value = [{ alg: "RS256", kid: "learning-audit" }, { iss: "https://audit.test/", aud: "alter-engine", iat: now, exp: now + 60,
        tenant_id: `ten_${other}`, "https://alter.dev/claims/actor_type": "service" }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      return `${value}.${sign("RSA-SHA256", Buffer.from(value), pair.privateKey).toString("base64url")}`;
    };
    writeFileSync(resolve(directory, "config.json"), JSON.stringify({ jwksUrl }), { mode: 0o600 });
    let output = "";
    child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "apps/audit-service/src/audit/run-learning.fixture.spec.ts", "--maxWorkers=1"], {
      env: { ...process.env, RUN_LEARNING_AUDIT_FIXTURE_DIRECTORY: directory }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", data => { output += String(data); }); child.stderr!.on("data", data => { output += String(data); });
    const completion = new Promise<number | null>((resolve, reject) => { child!.once("exit", resolve); child!.once("error", reject); });
    const deadline = Date.now() + 120_000;
    while (!existsSync(resolve(directory, "ready.json"))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("Native audit fixture failed to start: " + output.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database reference]"));
      await pause(50);
    }
    const { address } = JSON.parse(readFileSync(resolve(directory, "ready.json"), "utf8")) as { address: string };
    await expect(new AuditServiceClient({ address, protoPath: resolve("packages/contracts/proto/alter/audit/v1/audit.proto") }).recordEvent({
      tenant_id: `ten_${tenant}`, actor_type: "service", actor_ref: "fixture", action: "fixture.read", target_type: "run", target_ref: run,
      result: "success", reason_code: "", context_json: "{}", occurred_at: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 16 });
    const audit = new AuditServiceClient({ address, protoPath: resolve("packages/contracts/proto/alter/audit/v1/audit.proto"), accessTokenProvider: { getAccessToken: async () => token() } });
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withPassword(randomBytes(24).toString("hex")).start(),
      new RedisContainer("redis:7.4.2-alpine").start(),
    ]);
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE orchestration_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      await tx.query("GRANT USAGE ON SCHEMA public TO orchestration_service");
      await tx.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO orchestration_service");
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = "orchestration_service"; uri.password = password;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    await store.withTenant(tenant, async tx => {
      expect((await tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,status,ended_at) VALUES($1,$2,$2,'workflow','completed',clock_timestamp())", [run, tenant]);
      await tx.query("INSERT INTO run_outcomes(id,tenant_id,workspace_id,run_id,mode,eligible,verdict,human_rescue,critical_external_error,gates_passed,gates_failed,recovery_count,decided_at) VALUES($1,$2,$2,$3,'workflow',true,'completed_verified',false,false,1,0,0,clock_timestamp())", [randomUUID(), tenant, run]);
    });
    const guard = new SessionGatewayGuard(new M2mValidator({ auth0Domain: "audit.test", apiAudience: "alter-engine", jwksUrl }),
      new ActorTokenValidator({ issuer: "alter-platform-api.identity-broker", audience: "alter-engine", jwksUrl }, new RedisReplayStore(new RedisRespSetClient(redis.getConnectionUrl()))), store);
    const module = await Test.createTestingModule({ controllers: [RunLearningController], providers: [
      { provide: RunOutcomeService, useValue: new RunOutcomeService(store) }, { provide: RUN_LEARNING_AUDIT, useValue: audit }, { provide: APP_GUARD, useValue: guard },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0, "127.0.0.1");
    const url = (await app.getUrl()) + `/internal/runs/${run}/outcome-summary`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const request = (tenantId: string, target = url) => fetch(target + `?tenant_id=ten_${tenantId}`, { headers: { authorization: `Bearer ${token()}` } });
    const success = await request(tenant); expect(success.status).toBe(200); expect(await success.json()).toMatchObject({ run_id: run, tenant_id: `ten_${tenant}`, verdict: "completed_verified" });
    const denied = await request(other); expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error_code: "SERVICE_TENANT_MISMATCH" });
    expect((await request(tenant, url.replace(run, "run_018f4d6e-2b4a-7a3e-8c1a-00000000dead"))).status).toBe(404);
    writeFileSync(resolve(directory, "done"), "done");
    expect(await completion, "Native audit fixture must confirm persisted events: " + output.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database reference]").slice(-3000)).toBe(0);
    const rows = JSON.parse(readFileSync(resolve(directory, "rows.json"), "utf8"));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      expect.objectContaining({ tenant_id: tenant, actor_ref: `service:ten_${other}`, action: "run.outcome_summary.read", target_ref: run, result: "success", context: { scope: "tenant_asserted_by_service" } }),
      expect.objectContaining({ tenant_id: other, actor_ref: `service:ten_${other}`, target_ref: run, result: "denied", context: { scope: "tenant_asserted_by_service" } }),
      expect.objectContaining({ tenant_id: tenant, result: "error", context: { scope: "tenant_asserted_by_service" } }),
    ]);
  } finally {
    writeFileSync(resolve(directory, "done"), "done");
    if (child?.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await new Promise<void>(resolve => child!.once("exit", () => resolve())); }
    await app?.close(); await store?.close(); await admin?.close();
    await postgres?.stop(); await redis?.stop();
    if (issuer) await new Promise<void>(resolve => issuer!.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
