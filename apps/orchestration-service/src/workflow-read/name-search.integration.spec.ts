import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectReadService } from "../project-read/project-read.service";
import { WorkflowReadService, WorkflowValidationError } from "./workflow-read.service";

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const OTHER_WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const id = (prefix: string, n: number) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;

// Task B3.4: global search asks the engine by name instead of filtering the
// first page in the browser. The filter is SQL, so it is proven on Postgres.
describe.sequential("workflow and project name search, real Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let adminStore: PostgresOrchestrationStoreProvider;
  let tenantStore: PostgresOrchestrationStoreProvider;
  const role = `name_search_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("orchestration_db")
      .withUsername("orchestration_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    adminStore = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await adminStore.migrate();
    await adminStore.withTenant(TENANT, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      const names = ["Invoice triage", "Weekly invoice digest", "Support triage", "100% refunds", "a_b report", "ab report"];
      for (const [index, name] of names.entries()) {
        await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, $4)", [id("wf", index + 1), TENANT, WORKSPACE, name]);
        await tx.query("INSERT INTO projects (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, $4)", [id("prj", index + 1), TENANT, WORKSPACE, name]);
      }
      await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, 'Invoice elsewhere')", [id("wf", 99), TENANT, OTHER_WORKSPACE]);
    });
    tenantStore = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      migrationsFolder,
    });
  }, 120_000);

  afterAll(async () => {
    await tenantStore?.close();
    await adminStore?.withTenant(TENANT, async (tx) => {
      await tx.query(`DROP OWNED BY ${role}`);
      await tx.query(`DROP ROLE IF EXISTS ${role}`);
    });
    await adminStore?.close();
    await postgres?.stop();
  }, 60_000);

  const workflows = () => new WorkflowReadService(tenantStore);
  const names = (page: { data: readonly { name: string }[] }) => page.data.map((item) => item.name);

  it("matches part of a name case-insensitively, in the caller's workspace only", async () => {
    const page = await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "INVOICE");
    expect(names(page).sort()).toEqual(["Invoice triage", "Weekly invoice digest"]);
    const projects = await new ProjectReadService(tenantStore).listProjects(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "triage");
    expect(names(projects).sort()).toEqual(["Invoice triage", "Support triage"]);
  });

  it("treats %, _ and \\ as the characters typed, not patterns", async () => {
    expect(names(await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "%"))).toEqual(["100% refunds"]);
    expect(names(await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "a_b"))).toEqual(["a_b report"]);
    expect(names(await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "\\"))).toEqual([]);
  });

  it("still pages the filtered list and lists everything without a query", async () => {
    const first = await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 1, "triage");
    expect(first.page.has_more).toBe(true);
    const second = await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, first.page.next_cursor ?? undefined, 1, "triage");
    expect(second.page.has_more).toBe(false);
    expect([...names(first), ...names(second)].sort()).toEqual(["Invoice triage", "Support triage"]);
    expect((await workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50)).data).toHaveLength(6);
  });

  it("refuses an empty or oversized query", async () => {
    await expect(workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "  ")).rejects.toBeInstanceOf(WorkflowValidationError);
    await expect(workflows().listWorkflows(`ten_${TENANT}`, `ws_${WORKSPACE}`, undefined, 50, "x".repeat(201))).rejects.toBeInstanceOf(WorkflowValidationError);
  });
});
