import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PostgresCostStoreProvider } from "@alterx/adapters";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeCostsController } from "../../../cost-ledger-service/src/node-costs/node-costs.controller";
import { NodeCostsService } from "../../../cost-ledger-service/src/node-costs/node-costs.service";
import { CostLedgerClient } from "../engine/cost-ledger-client";
import type { EngineClient } from "../engine/engine-client";
import type { EngineAuthProvider } from "../engine/auth";
import type { EngineConfig } from "../engine/config";
import type { EnginePath, EngineResponse } from "../engine/types";
import { RunService } from "./run.service";
import type { EnginePage, EngineResource } from "./types";

const TENANT_A = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT_B = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const WORKSPACE_A = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const WORKSPACE_B = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";
const NODE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4";

describe.sequential("RunService per-node cost aggregation", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresCostStoreProvider;
  let costApp: NestFastifyApplication;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("cost_db")
      .withUsername("cost_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresCostStoreProvider({
      authentication: "static",
      connectionString: postgres.getConnectionUri(),
      migrationsFolder: resolve(process.cwd(), "apps/cost-ledger-service/drizzle"),
    });
    await store.migrate();
    const service = new NodeCostsService(store);
    const module = await Test.createTestingModule({
      controllers: [NodeCostsController],
      providers: [{ provide: NodeCostsService, useValue: service }],
    }).compile();
    costApp = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await costApp.listen(0, "127.0.0.1");
  }, 90_000);

  afterAll(async () => {
    await costApp?.close();
    await store?.close();
    await postgres?.stop();
  });

  beforeEach(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await store.withTenant(tenantId.slice(4), (tx) =>
        tx.query("DELETE FROM cost_events WHERE tenant_id = $1", [tenantId.slice(4)]),
      );
    }
  });

  it("returns a real tenant-scoped cost sum in Platform run detail", async () => {
    await seed(TENANT_A, WORKSPACE_A, "37");
    await seed(TENANT_B, WORKSPACE_B, "999");
    const address = costApp.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("cost route did not bind TCP");
    const costClient = new CostLedgerClient(
      {
        baseUrl: "http://engine.test",
        adsCoreBaseUrl: "http://ads.test",
        costLedgerBaseUrl: `http://127.0.0.1:${address.port}`,
        evalFacadeTokenRef: "env:EVAL_FACADE_TOKEN",
        deploymentAdminServiceTokenRef: "env:DEPLOYMENT_ADMIN_TOKEN",
        auditServiceBaseUrl: "http://audit.test",
        auditQueryServiceTokenRef: "env:AUDIT_QUERY_TOKEN",
        m2mTokenUrl: "https://identity.test/oauth/token",
        m2mAudience: "https://engine.test",
        m2mClientId: "platform-api",
        m2mClientSecretRef: "env:secret",
        requestTimeoutMs: 100,
  planningTimeoutMs: 120_000,
      } satisfies EngineConfig,
      { authorize: vi.fn().mockResolvedValue({ m2mAccessToken: "m2m", actorToken: "actor" }) } satisfies EngineAuthProvider,
    );
    const detail = await new RunService(engineStub(), costClient).detail(RUN, actor(), undefined);

    expect(detail.body.node_executions).toEqual([
      { id: NODE, node_cost_minor: "37" },
    ]);
  });

  async function seed(tenantId: string, workspaceId: string, cost: string): Promise<void> {
    await store.withTenant(tenantId.slice(4), (tx) =>
      tx.query(
        `INSERT INTO cost_events (id, tenant_id, workspace_id, mode, run_id, node_execution_id, source, provider, resource, quantity, unit, internal_cost_minor, occurred_at)
         VALUES ($1, $2, $3, 'workflow', $4, $5, 'model_gateway', 'test', 'tokens', 1, 'tokens', $6, now())`,
        [randomUUID(), tenantId.slice(4), workspaceId.slice(3), RUN.slice(4), NODE.slice(5), cost],
      ),
    );
  }
});

function actor() {
  return {
    user_id: "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890a5",
    tenant_id: TENANT_A.slice("ten_".length),
    workspace_id: WORKSPACE_A.slice("ws_".length),
    session_id: "session",
    auth_time: 1_700_000_000,
    roles: ["viewer"],
    permissions: ["runs:read"],
  };
}

function engineStub(): EngineClient {
  return {
    get: async (path: EnginePath): Promise<EngineResponse<EngineResource | EnginePage<EngineResource>>> => {
      if (path === `/api/v1/runs/${RUN}`) return { status: 200, body: { run_id: RUN } };
      if (path.endsWith("/outcome")) return { status: 200, body: {} };
      return {
        status: 200,
        body: { data: path.includes("node-executions") ? [{ id: NODE }] : [], page: { next_cursor: null, has_more: false, limit: 200 } },
      };
    },
  } as unknown as EngineClient;
}
