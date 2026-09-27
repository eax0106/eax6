import type { Pool, PoolClient, PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  POSTGRES_ORCHESTRATION_FEATURE_DECISION,
  PostgresOrchestrationStoreProvider,
  sharedOrchestrationPoolFactory,
} from "./orchestration-store-provider";

const migrationsFolder = "apps/orchestration-service/drizzle";
const tenantId = "00000000-0000-7000-8000-000000000001";

function poolWithClient(client: PoolClient): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ "?column?": 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function clientWithQuery(
  query: (sql: string, values?: readonly unknown[]) => Promise<unknown>,
): PoolClient {
  return {
    query: vi.fn(query),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PostgresOrchestrationStoreProvider", () => {
  it("validates static and IAM configuration", async () => {
    expect(
      () =>
        new PostgresOrchestrationStoreProvider({
          authentication: "static",
          connectionString: "",
          migrationsFolder,
        }),
    ).toThrow(/connectionString/);
    expect(
      () =>
        new PostgresOrchestrationStoreProvider({
          authentication: "static",
          connectionString: "postgresql://test.invalid/orchestration",
          migrationsFolder: "",
        }),
    ).toThrow(/migrationsFolder/);

    for (const [field, override] of [
      ["host", { host: "" }],
      ["database", { database: "" }],
      ["user", { user: "" }],
      ["region", { region: "" }],
      ["port", { port: 0 }],
      ["port", { port: 5432.5 }],
      ["port", { port: 65_536 }],
    ] as const) {
      const config = Object.assign(
        {
          authentication: "iam" as const,
          host: "db.example.com",
          port: 5432,
          database: "orchestration_db",
          user: "orchestration_service",
          region: "ap-south-1",
          migrationsFolder,
        },
        override,
      );
      expect(
        () =>
          new PostgresOrchestrationStoreProvider(
            config,
            { poolFactory: () => ({}) as Pool },
          ),
      ).toThrow(field);
    }

    const getAuthToken = vi.fn().mockResolvedValue("iam-token");
    let poolConfig: PoolConfig | undefined;
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "iam",
        host: "db.example.com",
        port: 5432,
        database: "orchestration_db",
        user: "orchestration_service",
        region: "ap-south-1",
        migrationsFolder,
      },
      {
        iamAuthTokenProvider: { getAuthToken },
        poolFactory: (config) => {
          poolConfig = config;
          return { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
        },
      },
    );

    expect(poolConfig).toMatchObject({
      host: "db.example.com",
      port: 5432,
      database: "orchestration_db",
      user: "orchestration_service",
      ssl: { rejectUnauthorized: true },
    });
    const password = poolConfig?.password;
    if (typeof password !== "function") {
      throw new Error("Expected async password callback");
    }
    await expect(password()).resolves.toBe("iam-token");
    await provider.close();

    let signerPoolConfig: PoolConfig | undefined;
    const signerProvider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "iam",
        host: "db.example.com",
        port: 5432,
        database: "orchestration_db",
        user: "orchestration_service",
        region: "ap-south-1",
        migrationsFolder,
      },
      {
        poolFactory: (config) => {
          signerPoolConfig = config;
          return { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
        },
      },
    );
    expect(signerPoolConfig?.password).toBeTypeOf("function");
    await signerProvider.close();

    const defaultPoolProvider = new PostgresOrchestrationStoreProvider({
      authentication: "static",
      connectionString: "postgresql://127.0.0.1:1/orchestration",
      migrationsFolder,
    });
    await defaultPoolProvider.close();
  });

  it("records the CEO-approved ungated INGR-1 foundation decision", async () => {
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      {
        pool: {
          end: vi.fn().mockResolvedValue(undefined),
        } as unknown as Pool,
      },
    );

    expect(provider.metadata.featureFlag).toBeUndefined();
    expect(POSTGRES_ORCHESTRATION_FEATURE_DECISION).toEqual({
      ticket: "INGR-1",
      component: "Engine component 31 - Event & Trigger Gateway",
      status: "approved_ungated_foundation_schema",
      featureId: null,
      featureFlag: null,
      reason:
        "schema/contracts/migrations foundation only; no user-facing rollout behavior",
      owner: "CEO",
      decisionDate: "2026-07-25",
      rollout:
        "merge allowed after CI/audit green; no runtime feature gate required",
    });
    await provider.close();
  });

  it("runs tenant operations in a transaction and commits", async () => {
    const client = clientWithQuery(async () => ({ rowCount: 1, rows: [] }));
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: poolWithClient(client) },
    );

    await expect(
      provider.withTenant(tenantId, async (transaction) => {
        await expect(
          transaction.query("SELECT $1::text AS value", ["value"]),
        ).resolves.toEqual({ rowCount: 1, rows: [] });
        return "done";
      }),
    ).resolves.toBe("done");
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "SELECT $1::text AS value",
      ["value"],
    );
    expect(client.query).toHaveBeenNthCalledWith(4, "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back failed tenant operations without hiding original error", async () => {
    const failure = new Error("operation failed");
    const client = clientWithQuery(async () => ({ rowCount: 1, rows: [] }));
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: poolWithClient(client) },
    );

    await expect(
      provider.withTenant(tenantId, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects invalid tenant IDs before opening a connection", async () => {
    const connect = vi.fn();
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      {
        pool: {
          connect,
          end: vi.fn().mockResolvedValue(undefined),
        } as unknown as Pool,
      },
    );

    await expect(
      provider.withTenant("ten_not-a-uuid", async () => undefined),
    ).rejects.toThrow("tenantId must be a UUID");
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports healthy and unhealthy database state", async () => {
    const healthyPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
    const healthy = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: healthyPool },
    );
    await expect(healthy.healthCheck()).resolves.toMatchObject({
      status: "healthy",
    });
    expect(healthy.metadata.interfaceName).toBe("RelationalDatabaseProvider");

    const unhealthyPool = {
      query: vi.fn().mockRejectedValue(new Error("offline")),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
    const unhealthy = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: unhealthyPool },
    );
    await expect(unhealthy.healthCheck()).resolves.toMatchObject({
      status: "unhealthy",
    });

    await healthy.close();
    await unhealthy.close();
    expect(healthyPool.end).toHaveBeenCalledOnce();
    expect(unhealthyPool.end).toHaveBeenCalledOnce();
  });

  it("executes rollback files in reverse order", async () => {
    const client = clientWithQuery(async () => ({ rowCount: 0, rows: [] }));
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: poolWithClient(client) },
    );

    await provider.rollback();
    const statements = vi
      .mocked(client.query)
      .mock.calls.map(([statement]) => String(statement));
    expect(statements[0]).toBe("BEGIN");
    const rollbackSql = statements.slice(1, -2).join("\n");
    // Reverse order asserted as a relative property rather than by naming
    // whichever rollback happens to be newest. Pinning statements[1] to the
    // newest file's first line meant any migration added after it broke this
    // test for a reason unrelated to ordering -- 0036 did exactly that, and it
    // only surfaced once an unrelated change pulled this spec into the
    // affected set.
    const taskSkeletonAt = rollbackSql.indexOf("DROP COLUMN task_skeleton");
    const testGateAt = rollbackSql.indexOf(
      "UPDATE workflow_versions SET status = 'compiled' WHERE status = 'tested'",
    );
    expect(taskSkeletonAt).toBeGreaterThanOrEqual(0);
    expect(testGateAt).toBeGreaterThanOrEqual(0);
    expect(taskSkeletonAt).toBeLessThan(testGateAt);
    for (const expected of [
      "DROP CONSTRAINT workflow_versions_tested_evidence_check",
      "CHECK (status IN ('compiled', 'canary', 'promoted', 'rolled_back', 'retired'))",
      "ALTER TABLE workflow_versions DROP COLUMN evaluation_failed_at",
      "ALTER TABLE workflow_versions DROP COLUMN tested_at",
      "ALTER TABLE workflow_versions DROP COLUMN evaluation_run_id",
      'DROP TABLE IF EXISTS "run_dispatch_queue"',
      'DROP INDEX IF EXISTS "idx_runs_tenant_deadline"',
      'DROP INDEX IF EXISTS "idx_runs_triggering_event"',
      'DROP COLUMN IF EXISTS "draft_dag"',
      'DROP TABLE IF EXISTS "project_plans"',
      'DROP TABLE IF EXISTS "trigger_webhook_secrets"',
      'DROP TABLE IF EXISTS "escalations";',
      'DROP TABLE IF EXISTS "workflow_template_variable_values"',
      'DROP INDEX IF EXISTS "idx_deployments_tenant_project_active"',
      'DELETE FROM "runs" WHERE "parent_kind" = \'project\'',
      'DROP TABLE IF EXISTS whatsapp_accounts',
      'DROP TABLE IF EXISTS "artifacts"',
      'DROP TABLE IF EXISTS "approvals"',
      'DROP TABLE IF EXISTS "run_outcomes"',
      'DROP TABLE IF EXISTS "verification_results"',
      'DROP TABLE IF EXISTS "run_stream_events"',
      'DROP TABLE IF EXISTS "node_executions"',
      "workflow_versions_reject_tenant_id_change",
      "conversation_goal_states_reject_tenant_id_change",
      "runs_reject_tenant_id_change",
      "workflows_reject_tenant_id_change",
    ]) {
      expect(rollbackSql).toContain(expected);
    }
    expect(statements.at(-2)).toBe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves rollback failure and releases the connection", async () => {
    const failure = new Error("rollback file failed");
    const client = clientWithQuery(async (statement) => {
      if (statement.includes("runs_reject_tenant_id_change")) {
        throw failure;
      }
      if (statement === "ROLLBACK") {
        throw new Error("rollback transaction failed");
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresOrchestrationStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/orchestration",
        migrationsFolder,
      },
      { pool: poolWithClient(client) },
    );

    await expect(provider.rollback()).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("sharedOrchestrationPoolFactory", () => {
  it("returns the same pool for the same static connection string", () => {
    const config: PoolConfig = {
      connectionString: "postgresql://test.invalid/shared-pool-static-a",
    };
    const first = sharedOrchestrationPoolFactory(config);
    const second = sharedOrchestrationPoolFactory({ ...config });

    expect(second).toBe(first);
    void first.end();
  });

  it("returns different pools for different connection strings", () => {
    const first = sharedOrchestrationPoolFactory({
      connectionString: "postgresql://test.invalid/shared-pool-static-b",
    });
    const second = sharedOrchestrationPoolFactory({
      connectionString: "postgresql://test.invalid/shared-pool-static-c",
    });

    expect(second).not.toBe(first);
    void first.end();
    void second.end();
  });

  it("returns the same pool for the same IAM host/port/database/user", () => {
    const config: PoolConfig = {
      host: "orchestration-db.internal",
      port: 5432,
      database: "orchestration_db",
      user: "orchestration_shared_a",
    };
    const first = sharedOrchestrationPoolFactory(config);
    const second = sharedOrchestrationPoolFactory({ ...config });

    expect(second).toBe(first);
    void first.end();
  });

  it("returns a different pool for a different IAM user, even with the same host/port/database", () => {
    // This is the actual bug under test -- app.module.ts's deletion/system
    // store intentionally authenticates as a different role than the
    // tenant-scoped stores. Sharing by connection identity, not one pool
    // for everything, is what keeps that privilege separation intact.
    const base = {
      host: "orchestration-db.internal",
      port: 5432,
      database: "orchestration_db",
    };
    const tenantScoped = sharedOrchestrationPoolFactory({
      ...base,
      user: "orchestration_tenant_role",
    });
    const systemScoped = sharedOrchestrationPoolFactory({
      ...base,
      user: "orchestration_system_role",
    });

    expect(systemScoped).not.toBe(tenantScoped);
    void tenantScoped.end();
    void systemScoped.end();
  });
});

describe("static connections require TLS", () => {
  const remote = "postgresql://svc:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/orchestration_db";

  function captureConfig(connectionString: string): PoolConfig | undefined {
    let captured: PoolConfig | undefined;
    new PostgresOrchestrationStoreProvider(
      { authentication: "static", connectionString, migrationsFolder },
      {
        poolFactory: (config) => {
          captured = config;
          return { on: vi.fn() } as unknown as Pool;
        },
      },
    );
    return captured;
  }

  it("refuses a remote connection string that does not ask for TLS", () => {
    expect(() => captureConfig(remote)).toThrow(/sslmode/);
    expect(() => captureConfig(`${remote}?sslmode=disable`)).toThrow(/sslmode/);
  });

  it("verifies the certificate when the connection string requires TLS", () => {
    expect(captureConfig(`${remote}?sslmode=verify-full`)?.ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("leaves a loopback connection alone, so local and testcontainers still connect", () => {
    expect(captureConfig("postgresql://u:p@127.0.0.1:5433/orchestration_db")?.ssl).toBeUndefined();
  });
});
