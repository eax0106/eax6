import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Signer } from "@aws-sdk/rds-signer";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { staticPoolConfig } from "./static-connection";
import {
  Pool,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import type { ProviderCapabilities } from "@alterx/contracts";
import type {
  ProviderHealth,
  ProviderMetadata,
  RelationalDatabaseProvider,
} from "@alterx/shared-clients";

interface PostgresCostStoreBaseConfig {
  readonly migrationsFolder: string;
}

export interface PostgresCostStoreStaticConfig
  extends PostgresCostStoreBaseConfig {
  readonly authentication: "static";
  readonly connectionString: string;
}

export interface PostgresCostStoreIamConfig
  extends PostgresCostStoreBaseConfig {
  readonly authentication: "iam";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly region: string;
}

export type PostgresCostStoreConfig =
  | PostgresCostStoreStaticConfig
  | PostgresCostStoreIamConfig;

export interface CostQueryResult<TRow extends QueryResultRow = QueryResultRow> {
  readonly rowCount: number;
  readonly rows: readonly TRow[];
}

export interface CostTransaction {
  query<TRow extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<CostQueryResult<TRow>>;
}

interface IamAuthTokenProvider {
  getAuthToken(): Promise<string>;
}

interface PostgresCostStoreDependencies {
  readonly pool?: Pool;
  readonly iamAuthTokenProvider?: IamAuthTokenProvider;
  readonly poolFactory?: (config: PoolConfig) => Pool;
}

const POSTGRES_COST_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tool_calling: false,
  vision: false,
  structured_output: true,
  long_context: false,
  regional_availability: ["ap-south-1"],
  data_residency: ["IN"],
  batch_support: true,
  maximum_payload: 1_048_576,
  supported_languages: [],
  cost_model: { rates: [] },
};

export interface PostgresCostFeatureDecision {
  readonly ticket: "OUT-1";
  readonly component: "Engine Output Phase - Cost Ledger";
  readonly status: "approved_ungated_foundation_schema";
  readonly featureId: null;
  readonly featureFlag: null;
  readonly reason: "schema/migrations/adapter foundation only; no ingest or query service logic yet";
  readonly owner: "CEO";
  readonly decisionDate: "2026-07-31";
  readonly rollout: "merge allowed after CI/self-audit green; no runtime feature gate required";
}

export const POSTGRES_COST_FEATURE_DECISION = {
  ticket: "OUT-1",
  component: "Engine Output Phase - Cost Ledger",
  status: "approved_ungated_foundation_schema",
  featureId: null,
  featureFlag: null,
  reason:
    "schema/migrations/adapter foundation only; no ingest or query service logic yet",
  owner: "CEO",
  decisionDate: "2026-07-31",
  rollout:
    "merge allowed after CI/self-audit green; no runtime feature gate required",
} as const satisfies PostgresCostFeatureDecision;

const POSTGRES_COST_METADATA: ProviderMetadata<"RelationalDatabaseProvider"> = {
  providerId: "postgres-cost-store",
  interfaceName: "RelationalDatabaseProvider",
  displayName: "PostgreSQL Cost Store",
  version: "output-v1",
  telemetryNamespace: "alterx.adapters.postgres.cost-store",
  supportsTenantOverrides: false,
  migration: {
    strategyVersion: "cost-ledger-core-v1",
    rollbackSupported: true,
  },
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireConfig(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Postgres cost store config field ${field} is required`);
  }
}

function createPoolConfig(
  config: PostgresCostStoreConfig,
  iamAuthTokenProvider?: IamAuthTokenProvider,
): PoolConfig {
  if (config.authentication === "static") {
    requireConfig("connectionString", config.connectionString);
    return staticPoolConfig(config.connectionString);
  }

  requireConfig("host", config.host);
  requireConfig("database", config.database);
  requireConfig("user", config.user);
  requireConfig("region", config.region);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error(
      "Postgres cost store config field port must be an integer from 1 to 65535",
    );
  }

  const tokenProvider =
    iamAuthTokenProvider ??
    new Signer({
      hostname: config.host,
      port: config.port,
      username: config.user,
      region: config.region,
    });

  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: () => tokenProvider.getAuthToken(),
    ssl: { rejectUnauthorized: true },
  };
}

export class PostgresCostStoreProvider implements RelationalDatabaseProvider {
  readonly metadata = POSTGRES_COST_METADATA;
  readonly capabilities = POSTGRES_COST_CAPABILITIES;

  readonly #pool: Pool;
  readonly #migrationsFolder: string;

  constructor(
    config: PostgresCostStoreConfig,
    dependencies: PostgresCostStoreDependencies = {},
  ) {
    requireConfig("migrationsFolder", config.migrationsFolder);
    this.#pool =
      dependencies.pool ??
      (dependencies.poolFactory ?? ((poolConfig) => new Pool(poolConfig)))(
        createPoolConfig(config, dependencies.iamAuthTokenProvider),
      );
    this.#migrationsFolder = config.migrationsFolder;
  }

  async migrate(): Promise<void> {
    await migrate(drizzle(this.#pool), {
      migrationsFolder: this.#migrationsFolder,
    });
  }

  async rollback(): Promise<void> {
    const rollbackFolder = join(this.#migrationsFolder, "rollback");
    const files = (await readdir(rollbackFolder))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .reverse();
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");
      for (const file of files) {
        await client.query(await readFile(join(rollbackFolder, file), "utf8"));
      }
      await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async withTenant<T>(
    tenantId: string,
    operation: (transaction: CostTransaction) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new Error("tenantId must be a UUID");
    }

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
      const transaction: CostTransaction = {
        query: async <TRow extends QueryResultRow>(
          statement: string,
          values?: readonly unknown[],
        ) => {
          const result = await client.query<TRow>(
            statement,
            values as unknown[] | undefined,
          );
          return {
            rowCount: result.rowCount ?? 0,
            rows: result.rows,
          };
        },
      };
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs a callback as the BYPASSRLS `cost_ledger_provisioner` role -- required
   * for right-to-delete's tenant_id nulling on billing_rollups (doc 04 SS1/SS6:
   * "Pseudonymized survivors only in cost_db and audit_db") and for the raw
   * cost_events 24-month retention purge, both of which must operate across
   * tenant boundaries by design.
   */
  async withProvisioner<T>(
    operation: (transaction: CostTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE cost_ledger_provisioner");
      const transaction: CostTransaction = {
        query: async <TRow extends QueryResultRow>(
          statement: string,
          values?: readonly unknown[],
        ) => {
          const result = await client.query<TRow>(
            statement,
            values as unknown[] | undefined,
          );
          return {
            rowCount: result.rowCount ?? 0,
            rows: result.rows,
          };
        },
      };
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.#pool.query("SELECT 1");
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      };
    } catch {
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      };
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
