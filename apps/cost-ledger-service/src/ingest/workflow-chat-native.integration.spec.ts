import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PostgresCostStoreProvider, RunsClient, startCostGrpcTransport } from "@alterx/adapters";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it } from "vitest";
import { AppModule } from "../app.module";

// Launched by the always-run engine chat test through its Model Gateway child.
it.runIf(Boolean(process.env.WORKFLOW_CHAT_NATIVE_COST))("persists the actual Ask Alter model event through native run lookup", async () => {
  const fixture = JSON.parse(readFileSync(process.env.WORKFLOW_CHAT_NATIVE_COST!, "utf8")) as { directory: string; runsAddress: string; tenant: string; workspace: string; observed: { workflowId: string; runId: string; nodeId: string } };
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  const migrationsFolder = resolve("apps/cost-ledger-service/drizzle");
  const admin = new PostgresCostStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
  let store: PostgresCostStoreProvider | undefined, app: NestFastifyApplication | undefined;
  try {
    await admin.migrate();
    const role = `native_chat_cost_${randomBytes(5).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(fixture.tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`GRANT cost_ledger_provisioner TO ${role}`);
      for (const resource of ["tokens", "input_tokens", "output_tokens"]) await tx.query(
        "INSERT INTO model_pricing(provider,model_id,resource,unit_cost_minor,currency) VALUES('native-model','',$1,10,'INR')", [resource]);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password;
    store = new PostgresCostStoreProvider({ authentication: "static", connectionString: uri.href, migrationsFolder });
    const runtime = await store.withTenant(fixture.tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(runtime.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await store.withTenant(fixture.tenant, tx => tx.query("INSERT INTO cost_events(id,tenant_id,workspace_id,mode,parent_id,run_id,node_execution_id,source,provider,resource,quantity,unit,internal_cost_minor,currency,occurred_at) VALUES($1,$2,$3,'workflow',$4,$5,$6,'tool_gateway','native-tool','requests',1,'request',700,'INR',now())", [randomUUID(),fixture.tenant,fixture.workspace,fixture.observed.workflowId.slice(3),fixture.observed.runId.slice(4),fixture.observed.nodeId.slice(5)]));
    const module = await Test.createTestingModule({ imports: [AppModule.register(store,
      new RunsClient({ address: fixture.runsAddress, protoPath: resolve("packages/contracts/proto/alter/runs/v1/runs.proto") }),
      0.3, 83, "native-fixture-pseudonym".repeat(2), "e".repeat(64))] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init();
    const port = await new Promise<number>((done, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address(); if (!address || typeof address === "string") return reject(Error("Missing cost fixture port"));
      server.close(error => error ? reject(error) : done(address.port));
    }); });
    await startCostGrpcTransport(app, { bindAddress: `127.0.0.1:${port}`, protoPath: resolve("packages/contracts/proto/alter/cost/v1/cost.proto") });
    await app.listen(0, "127.0.0.1");
    writeFileSync(join(fixture.directory, "cost-ready.json"), JSON.stringify({ address: `127.0.0.1:${port}`, baseUrl: await app.getUrl() }), { mode: 0o600 });
    const deadline = Date.now() + 60000;
    while (!existsSync(join(fixture.directory, "cost-stop"))) {
      if (Date.now() > deadline) throw Error("Native Model Gateway did not finish the cost check");
      await new Promise(done => setTimeout(done, 25));
    }
    const events = await store.withTenant(fixture.tenant, tx => tx.query("SELECT workspace_id,parent_id,run_id,node_execution_id,source,provider,quantity,internal_cost_minor,currency FROM cost_events WHERE tenant_id=$1 AND parent_id IS NULL", [fixture.tenant]));
    expect(events.rows).toHaveLength(1); expect(events.rows[0], JSON.stringify(events.rows[0])).toMatchObject({ workspace_id: fixture.workspace, parent_id: null, source: "model_gateway", provider: "native-model", quantity: "15", internal_cost_minor: "150", currency: "INR" });
    const outcomes = await store.withTenant(fixture.tenant, tx => tx.query("SELECT verdict FROM model_outcomes WHERE tenant_id=$1", [fixture.tenant]));
    expect(outcomes.rows).toEqual([{ verdict: "success" }]);
    writeFileSync(join(fixture.directory, "cost-persisted.json"), JSON.stringify(events.rows), { mode: 0o600 });
  } finally { if (app) await app.close(); else await store?.close(); await admin.close(); await postgres.stop(); }
}, 120000);
