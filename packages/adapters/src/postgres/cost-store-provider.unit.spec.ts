import type { Pool, PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresCostStoreProvider } from "./cost-store-provider";

const migrationsFolder = "apps/cost-ledger-service/drizzle";

/**
 * The cost store had no unit spec, so nothing held its static path to the same
 * rule as the audit and orchestration stores: a password-carrying connection
 * string reaching a remote host must ask for TLS.
 */
describe("PostgresCostStoreProvider static connections", () => {
  const remote = "postgresql://svc:pw@db.managed-postgres.example.com/cost_db";

  function captureConfig(connectionString: string): PoolConfig | undefined {
    let captured: PoolConfig | undefined;
    new PostgresCostStoreProvider(
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

  it("requires a connection string", () => {
    expect(
      () =>
        new PostgresCostStoreProvider(
          { authentication: "static", connectionString: "", migrationsFolder },
          { poolFactory: () => ({ on: vi.fn() }) as unknown as Pool },
        ),
    ).toThrow(/connectionString/);
  });

  it("refuses a remote connection string that does not ask for TLS", () => {
    expect(() => captureConfig(remote)).toThrow(/sslmode/);
  });

  it("verifies the certificate when the connection string requires TLS", () => {
    expect(captureConfig(`${remote}?sslmode=require`)?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each([
    ["loopback", "postgresql://u:p@127.0.0.1:5435/cost_db"],
    ["a container DNS name", "postgresql://u:p@cost-db:5432/cost_db"],
    ["a private address", "postgresql://u:p@192.168.20.5:5432/cost_db"],
  ])("connects without TLS over %s", (_name, connectionString) => {
    expect(captureConfig(connectionString)?.ssl).toBeUndefined();
  });
});
