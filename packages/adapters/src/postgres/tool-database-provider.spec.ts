import { randomBytes } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMockSecretsProvider } from "@alterx/shared-clients";
import { ToolGatewayCredentialMissingError } from "../grpc/toolgw-grpc-transport";
import {
  PostgresToolDatabaseProvider,
  type ToolDatabaseClient,
} from "./tool-database-provider";

describe.sequential("PostgresToolDatabaseProvider", () => {
  let container: StartedPostgreSqlContainer;
  const credentialReference =
    "/alter/test/tenant/ten_018f47a2-7b11-7b11-8a11-1234567890ab/integration/db_accounts/password";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("tool_db")
      .withUsername("tool_test")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE accounts (id integer PRIMARY KEY, owner text NOT NULL)",
      );
      await client.query(
        "INSERT INTO accounts (id, owner) VALUES ($1, $2), ($3, $4)",
        [1, "alice", 2, "bob"],
      );
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await container.stop();
  });

  function provider(): PostgresToolDatabaseProvider {
    return new PostgresToolDatabaseProvider(
      createMockSecretsProvider({
        secrets: { [credentialReference]: container.getConnectionUri() },
      }),
    );
  }

  it("executes a parameterized query using a reference-resolved credential", async () => {
    await expect(
      provider().execute({
        credentialReference,
        databaseId: "db_accounts",
        operation: "select",
        statement: "SELECT id, owner FROM accounts WHERE owner = $1",
        parameters: ["alice"],
      }),
    ).resolves.toEqual({ rowCount: 1, rows: [{ id: 1, owner: "alice" }] });
  });

  it("treats SQL-injection input as a value instead of executable SQL", async () => {
    const result = await provider().execute({
      credentialReference,
      databaseId: "db_accounts",
      operation: "select",
      statement: "SELECT id, owner FROM accounts WHERE owner = $1",
      parameters: ["alice' OR 1=1 --"],
    });

    expect(result).toEqual({ rowCount: 0, rows: [] });
  });

  it("rejects multi-statement, operation, and placeholder mismatches before secret resolution", async () => {
    const getSecret = vi.fn(async () => container.getConnectionUri());
    const target = new PostgresToolDatabaseProvider(
      {
        ...createMockSecretsProvider(),
        getSecret,
      },
    );
    const base = {
      credentialReference,
      databaseId: "db_accounts",
      operation: "select" as const,
      parameters: ["alice"],
    };

    await expect(
      target.execute({
        ...base,
        statement: "SELECT id FROM accounts WHERE owner = $1; DROP TABLE accounts",
      }),
    ).rejects.toThrow("one comment-free operation");
    await expect(
      target.execute({ ...base, statement: "DELETE FROM accounts WHERE owner = $1" }),
    ).rejects.toThrow("permitted operation");
    await expect(
      target.execute({ ...base, statement: "SELECT id FROM accounts WHERE owner = $2" }),
    ).rejects.toThrow("placeholders");
    await expect(
      target.execute({
        ...base,
        operation: "drop" as "select",
        statement: "DROP TABLE accounts WHERE id = $1",
      }),
    ).rejects.toThrow("not supported");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("closes the DB connection when a query fails", async () => {
    const end = vi.fn(async () => undefined);
    const client: ToolDatabaseClient = {
      connect: async () => undefined,
      query: async () => {
        throw new Error("query failed");
      },
      end,
    };
    const target = new PostgresToolDatabaseProvider(
      createMockSecretsProvider({
        secrets: { [credentialReference]: "postgresql://resolved-inside-adapter" },
      }),
      () => client,
    );

    await expect(
      target.execute({
        credentialReference,
        databaseId: "db_accounts",
        operation: "select",
        statement: "SELECT id FROM accounts WHERE owner = $1",
        parameters: ["alice"],
      }),
    ).rejects.toThrow("query failed");
    expect(end).toHaveBeenCalledOnce();
  });
  it.each(["not-a-database-url", "https://example.test/database"])("rejects malformed stored database credentials before creating a client: %s", async value => {
    const createClient = vi.fn(() => { throw new Error("Invalid credential reached a database client"); });
    const target = new PostgresToolDatabaseProvider(createMockSecretsProvider({ secrets: { [credentialReference]: value } }), createClient);
    await expect(target.execute({ credentialReference, databaseId: "db_accounts", operation: "select", statement: "SELECT $1::integer", parameters: [1] })).rejects.toBeInstanceOf(ToolGatewayCredentialMissingError);
    expect(createClient).not.toHaveBeenCalled();
  });
});
