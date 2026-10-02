import { Client } from "pg";

import type { JsonValue, SecretsProvider } from "@alterx/shared-clients";
import { ToolGatewayCredentialMissingError } from "../grpc/toolgw-grpc-transport";

export type DatabaseOperation = "select" | "insert" | "update" | "delete";
const DATABASE_OPERATIONS = new Set<DatabaseOperation>([
  "select",
  "insert",
  "update",
  "delete",
]);

export interface DatabaseOperationRequest {
  readonly credentialReference: string;
  readonly databaseId: string;
  readonly operation: DatabaseOperation;
  readonly statement: string;
  readonly parameters: readonly JsonValue[];
}

export interface DatabaseOperationResult {
  readonly rowCount: number;
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
}

/** Vendor-neutral DB operation port consumed by Sandbox Service. */
export interface DatabaseOperationProvider {
  readonly providerId: string;
  execute(request: DatabaseOperationRequest): Promise<DatabaseOperationResult>;
}

export interface ToolDatabaseClient {
  connect(): Promise<void>;
  query(input: {
    readonly text: string;
    readonly values: readonly unknown[];
  }): Promise<{ readonly rowCount: number | null; readonly rows: readonly unknown[] }>;
  end(): Promise<void>;
}

export type ToolDatabaseClientFactory = (
  connectionString: string,
) => ToolDatabaseClient;

function realClientFactory(connectionString: string): ToolDatabaseClient {
  return new Client({ connectionString }) as unknown as ToolDatabaseClient;
}

function validateParameterizedStatement(request: DatabaseOperationRequest): void {
  if (!DATABASE_OPERATIONS.has(request.operation)) {
    throw new Error("Database operation is not supported");
  }
  const statement = request.statement.trim();
  if (statement.length === 0) {
    throw new Error("Database statement is required");
  }
  if (statement.includes(";") || statement.includes("--") || statement.includes("/*")) {
    throw new Error("Database statement must contain one comment-free operation");
  }
  const firstKeyword = statement.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase();
  if (firstKeyword !== request.operation) {
    throw new Error("Database statement does not match permitted operation");
  }
  const placeholders = [...statement.matchAll(/\$(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const expected = request.parameters.map((_, index) => index + 1);
  const unique = [...new Set(placeholders)].sort((left, right) => left - right);
  if (
    expected.length === 0 ||
    unique.length !== expected.length ||
    unique.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      "Database statement placeholders must exactly match supplied parameters",
    );
  }
}

function pgValue(value: JsonValue): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

function jsonRows(rows: readonly unknown[]): readonly Readonly<Record<string, JsonValue>>[] {
  const converted = JSON.parse(JSON.stringify(rows)) as unknown;
  if (!Array.isArray(converted)) {
    throw new Error("Database returned an invalid row collection");
  }
  return converted as readonly Readonly<Record<string, JsonValue>>[];
}

export class PostgresToolDatabaseProvider
  implements DatabaseOperationProvider
{
  readonly providerId = "postgres";
  readonly #secrets: SecretsProvider;
  readonly #clientFactory: ToolDatabaseClientFactory;

  constructor(
    secrets: SecretsProvider,
    clientFactory: ToolDatabaseClientFactory = realClientFactory,
  ) {
    this.#secrets = secrets;
    this.#clientFactory = clientFactory;
  }

  async execute(
    request: DatabaseOperationRequest,
  ): Promise<DatabaseOperationResult> {
    if (request.credentialReference.trim().length === 0) {
      throw new Error("Database credential reference is required");
    }
    if (request.databaseId.trim().length === 0) {
      throw new Error("Database ID is required");
    }
    validateParameterizedStatement(request);

    // Secret value remains inside adapter boundary. Sandbox Service handles
    // only canonical reference IDs and never receives the resolved DSN.
    const connectionString = await this.#secrets.getSecret(
      request.credentialReference,
    );
    let protocol: string;
    try { protocol = new URL(connectionString).protocol; }
    catch { throw new ToolGatewayCredentialMissingError(); }
    if (protocol !== "postgres:" && protocol !== "postgresql:") throw new ToolGatewayCredentialMissingError();
    const client = this.#clientFactory(connectionString);
    try {
      await client.connect();
      const result = await client.query({
        text: request.statement,
        values: request.parameters.map(pgValue),
      });
      return {
        rowCount: result.rowCount ?? result.rows.length,
        rows: jsonRows(result.rows),
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "28P01" || error.code === "28000")) throw new ToolGatewayCredentialMissingError();
      throw error;
    } finally {
      await client.end();
    }
  }
}
