import type { Pool, PoolClient, PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { AuditEventToAppend } from "@alterx/shared-clients";
import { PostgresAuditStoreProvider } from "./audit-store-provider";

const MIGRATIONS_FOLDER = "apps/audit-service/drizzle";

function event(): AuditEventToAppend {
  return {
    id: "018f47a2-7b11-7b11-8a11-1234567890ab",
    tenantId: "018f47a2-7b11-7b11-8a11-1234567890ac",
    tenantPseudonym: null,
    actorType: "service",
    actorRef: "audit-test",
    action: "audit.append",
    targetType: "audit_event",
    targetRef: null,
    result: "success",
    reasonCode: null,
    context: { request_id: "request-1" },
    occurredAt: new Date("2026-07-24T12:00:00.000Z"),
  };
}

function poolWithClient(client: PoolClient): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function clientWithQuery(
  query: (sql: string) => Promise<unknown>,
): PoolClient {
  return {
    query: vi.fn(query),
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("PostgresAuditStoreProvider failure branches", () => {
  it("rejects and rolls back when the audit chain has multiple tips", async () => {
    const client = clientWithQuery(async (sql) => {
      if (sql.includes("FROM audit_events AS current_event")) {
        return {
          rowCount: 2,
          rows: [
            { entry_hash: Buffer.alloc(32) },
            { entry_hash: Buffer.alloc(32) },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await expect(provider.append(event())).rejects.toThrow(
      "Audit chain has multiple tips",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects and rolls back when an insert returns no row", async () => {
    const client = clientWithQuery(async (sql) => {
      if (sql.includes("FROM audit_events AS current_event")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await expect(provider.append(event())).rejects.toThrow(
      "Audit insert returned no row",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("preserves an insert failure even if rollback also fails", async () => {
    const insertFailure = new Error("insert failed");
    const client = clientWithQuery(async (sql) => {
      if (sql.includes("FROM audit_events AS current_event")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        throw insertFailure;
      }
      if (sql === "ROLLBACK") {
        throw new Error("rollback failed");
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await expect(provider.append(event())).rejects.toBe(insertFailure);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("PostgresAuditStoreProvider.queryEvents", () => {
  it("builds the tenant-scoped filter and does not treat a null tenantId as unscoped by accident", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const client = clientWithQuery(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith("SELECT * FROM audit_events")) {
        capturedSql = sql;
        capturedParams = (args[0] as unknown[] | undefined) ?? [];
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await provider.queryEvents({
      tenantId: "018f47a2-7b11-7b11-8a11-1234567890ab",
      limit: 50,
    });

    expect(capturedSql).toContain("tenant_id = $1");
    expect(capturedParams[0]).toBe("018f47a2-7b11-7b11-8a11-1234567890ab");
  });

  it("omits the tenant_id predicate entirely for a null tenantId (genuine cross-tenant query)", async () => {
    let capturedSql = "";
    const client = clientWithQuery(async (sql: string) => {
      capturedSql = sql;
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await provider.queryEvents({ tenantId: null, limit: 50 });

    expect(capturedSql).not.toContain("tenant_id =");
  });

  it("clamps limit to the [1, 200] range", async () => {
    let capturedParams: unknown[] = [];
    const client = clientWithQuery(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith("SELECT * FROM audit_events")) {
        capturedParams = (args[0] as unknown[] | undefined) ?? [];
      }
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await provider.queryEvents({ tenantId: null, limit: 9_999 });
    // requested limit + 1 (the extra row is the has-more probe) is the last param
    expect(capturedParams.at(-1)).toBe(201);

    await provider.queryEvents({ tenantId: null, limit: 0 });
    expect(capturedParams.at(-1)).toBe(2);
  });

  it("rolls back and propagates on query failure", async () => {
    const failure = new Error("query failed");
    const client = clientWithQuery(async (sql: string) => {
      if (sql.startsWith("SELECT * FROM audit_events")) throw failure;
      return { rowCount: 0, rows: [] };
    });
    const provider = new PostgresAuditStoreProvider(
      {
        authentication: "static",
        connectionString: "postgresql://test.invalid/audit",
        migrationsFolder: MIGRATIONS_FOLDER,
      },
      { pool: poolWithClient(client) },
    );

    await expect(provider.queryEvents({ tenantId: null, limit: 50 })).rejects.toBe(failure);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("PostgresAuditStoreProvider IAM authentication", () => {
  const iamConfig = {
    authentication: "iam" as const,
    host: "alter-prod-data.cluster-example.ap-south-1.rds.amazonaws.com",
    port: 5432,
    database: "audit_db",
    user: "audit_service",
    region: "ap-south-1",
    migrationsFolder: MIGRATIONS_FOLDER,
  };

  it("requests a fresh IAM token for every new physical connection", async () => {
    const getAuthToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("short-lived-token-1")
      .mockResolvedValueOnce("short-lived-token-2");
    let capturedConfig: PoolConfig | undefined;
    const provider = new PostgresAuditStoreProvider(iamConfig, {
      iamAuthTokenProvider: { getAuthToken },
      poolFactory: (config) => {
        capturedConfig = config;
        return { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
      },
    });

    expect(capturedConfig).toMatchObject({
      host: iamConfig.host,
      port: 5432,
      database: "audit_db",
      user: "audit_service",
      ssl: { rejectUnauthorized: true },
    });
    const password = capturedConfig?.password;
    expect(password).toBeTypeOf("function");
    if (typeof password !== "function") {
      throw new Error("Expected async password callback");
    }
    await expect(password()).resolves.toBe("short-lived-token-1");
    await expect(password()).resolves.toBe("short-lived-token-2");
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it("propagates IAM token generation failure without caching a token", async () => {
    const tokenFailure = new Error("IAM token generation failed");
    const getAuthToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(tokenFailure);
    let capturedConfig: PoolConfig | undefined;
    new PostgresAuditStoreProvider(iamConfig, {
      iamAuthTokenProvider: { getAuthToken },
      poolFactory: (config) => {
        capturedConfig = config;
        return {} as Pool;
      },
    });

    const password = capturedConfig?.password;
    if (typeof password !== "function") {
      throw new Error("Expected async password callback");
    }
    await expect(password()).rejects.toBe(tokenFailure);
    await expect(password()).rejects.toBe(tokenFailure);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it(
    "constructs the production RDS signer when no test token provider is supplied",
    () => {
      let capturedConfig: PoolConfig | undefined;
      new PostgresAuditStoreProvider(iamConfig, {
        poolFactory: (config) => {
          capturedConfig = config;
          return {} as Pool;
        },
      });

      expect(capturedConfig?.password).toBeTypeOf("function");
    },
  );

  it.each([
    ["host", { host: "" }],
    ["database", { database: "" }],
    ["user", { user: "" }],
    ["region", { region: "" }],
    ["port", { port: 0 }],
    ["port", { port: 5432.5 }],
    ["port", { port: 65_536 }],
  ])("rejects invalid IAM %s metadata", (field, override) => {
    expect(
      () =>
        new PostgresAuditStoreProvider(
          { ...iamConfig, ...override },
          { poolFactory: () => ({} as Pool) },
        ),
    ).toThrow(field);
  });
});

describe("static connections require TLS", () => {
  const remote = "postgresql://svc:pw@ep-x-pooler.ap-southeast-1.aws.neon.tech/audit_db";

  function captureConfig(connectionString: string): PoolConfig | undefined {
    let captured: PoolConfig | undefined;
    new PostgresAuditStoreProvider(
      { authentication: "static", connectionString, migrationsFolder: "apps/audit-service/drizzle" },
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
  });

  it("verifies the certificate when the connection string requires TLS", () => {
    expect(captureConfig(`${remote}?sslmode=require`)?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("leaves a loopback connection alone", () => {
    expect(captureConfig("postgresql://u:p@localhost:5433/audit_db")?.ssl).toBeUndefined();
  });
});
