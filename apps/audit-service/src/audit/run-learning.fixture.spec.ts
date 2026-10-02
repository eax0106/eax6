import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgresAuditStoreProvider, startAuditGrpcTransport } from "@alterx/adapters";
import { connectPostgresTestClient, type PostgresTestClient } from "@alterx/adapters/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import { AppModule } from "../app.module";
import { AUDIT_PROTO_PATH } from "./grpc.constants";
import { AuditService } from "./audit.service";

const directory = process.env["RUN_LEARNING_AUDIT_FIXTURE_DIRECTORY"];

it.skipIf(directory === undefined)("persists run-learning events through the native audit service", async () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let admin: PostgresTestClient | undefined;
  let app: NestFastifyApplication | undefined;
  let store: PostgresAuditStoreProvider | undefined;
  try {
    const config = JSON.parse(readFileSync(resolve(directory!, "config.json"), "utf8")) as { jwksUrl: string };
    process.env["AUTH0_DOMAIN"] = "audit.test";
    process.env["API_AUDIENCE"] = "alter-engine";
    process.env["AUTH0_JWKS_URL"] = config.jwksUrl;
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("audit_db").withPassword(randomBytes(24).toString("hex")).start();
    admin = await connectPostgresTestClient(postgres.getConnectionUri());
    const password = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE audit_service LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query("ALTER DATABASE audit_db OWNER TO audit_service");
    await admin.query("GRANT CREATE, USAGE ON SCHEMA public TO audit_service");
    const uri = new URL(postgres.getConnectionUri()); uri.username = "audit_service"; uri.password = password;
    store = new PostgresAuditStoreProvider({ authentication: "static", connectionString: uri.href,
      migrationsFolder: resolve("apps/audit-service/drizzle") });
    await store.migrate();
    expect((await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='audit_service'")).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const module = await Test.createTestingModule({ imports: [AppModule.register(store)] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    await startAuditGrpcTransport(app, { bindAddress: `127.0.0.1:${port}`, protoPath: AUDIT_PROTO_PATH });
    await app.listen(0, "127.0.0.1");
    writeFileSync(resolve(directory!, "ready.json"), JSON.stringify({ address: `127.0.0.1:${port}` }));
    const deadline = Date.now() + 120_000;
    while (!existsSync(resolve(directory!, "done"))) {
      if (Date.now() > deadline) throw new Error("Run-learning caller did not finish");
      await pause(50);
    }
    const rows = await admin.query("SELECT tenant_id::text,actor_ref,action,target_ref,result,context FROM audit_events ORDER BY chain_position");
    writeFileSync(resolve(directory!, "rows.json"), JSON.stringify(rows.rows));
    expect(rows.rows).toHaveLength(3);
    await expect(module.get(AuditService).verifyChain()).resolves.toEqual({ valid: true, checkedEvents: 3 });
  } finally {
    if (app) await app.close();
    else await store?.close();
    await admin?.end();
    await postgres?.stop();
  }
}, 180_000);
