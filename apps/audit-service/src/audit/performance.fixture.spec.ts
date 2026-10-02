import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgresAuditStoreProvider } from "@alterx/adapters";
import { connectPostgresTestClient, type PostgresTestClient } from "@alterx/adapters/testing";
import { AUDIT_STORE_PROVIDER } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import { AuditQueryController, AUDIT_QUERY_SERVICE_TOKEN_HASH } from "./audit-query.controller";
import { AuditService } from "./audit.service";

const directory = process.env["PERFORMANCE_AUDIT_FIXTURE_DIRECTORY"];

it.skipIf(directory === undefined)("persists performance assertions through native audit HTTP", async () => {
  let postgres: StartedPostgreSqlContainer | undefined, admin: PostgresTestClient | undefined;
  let app: NestFastifyApplication | undefined, store: PostgresAuditStoreProvider | undefined;
  try {
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
    const module = await Test.createTestingModule({ controllers: [AuditQueryController], providers: [
      AuditService, { provide: AUDIT_STORE_PROVIDER, useValue: store },
      { provide: AUDIT_QUERY_SERVICE_TOKEN_HASH, useValue: createHash("sha256").update("integration-token").digest("hex") },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, "127.0.0.1");
    writeFileSync(resolve(directory!, "ready.json"), JSON.stringify({ baseUrl: await app.getUrl() }));
    const deadline = Date.now() + 180_000;
    while (!existsSync(resolve(directory!, "done"))) {
      if (Date.now() > deadline) throw new Error("Performance caller did not finish");
      await pause(50);
    }
    const chain = await module.get(AuditService).verifyChain();
    expect(chain.valid).toBe(true); expect(chain.checkedEvents).toBeGreaterThan(0);
  } finally {
    await app?.close(); await store?.close(); await admin?.end(); await postgres?.stop();
  }
}, 240_000);
