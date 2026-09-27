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

export { sql } from "drizzle-orm";
export {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

interface PostgresOrchestrationStoreBaseConfig {
  readonly migrationsFolder: string;
}

export interface PostgresOrchestrationStoreStaticConfig
  extends PostgresOrchestrationStoreBaseConfig {
  readonly authentication: "static";
  readonly connectionString: string;
}

export interface PostgresOrchestrationStoreIamConfig
  extends PostgresOrchestrationStoreBaseConfig {
  readonly authentication: "iam";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly region: string;
}

export type PostgresOrchestrationStoreConfig =
  | PostgresOrchestrationStoreStaticConfig
  | PostgresOrchestrationStoreIamConfig;

export interface OrchestrationQueryResult<
  TRow extends QueryResultRow = QueryResultRow,
> {
  readonly rowCount: number;
  readonly rows: readonly TRow[];
}

export interface OrchestrationTransaction {
  query<TRow extends QueryResultRow = QueryResultRow>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<OrchestrationQueryResult<TRow>>;
}

interface IamAuthTokenProvider {
  getAuthToken(): Promise<string>;
}

interface PostgresOrchestrationStoreDependencies {
  readonly pool?: Pool;
  readonly iamAuthTokenProvider?: IamAuthTokenProvider;
  readonly poolFactory?: (config: PoolConfig) => Pool;
}

const POSTGRES_ORCHESTRATION_CAPABILITIES: ProviderCapabilities = {
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

export interface PostgresOrchestrationFeatureDecision {
  readonly ticket: "INGR-1";
  readonly component: "Engine component 31 - Event & Trigger Gateway";
  readonly status: "approved_ungated_foundation_schema";
  readonly featureId: null;
  readonly featureFlag: null;
  readonly reason: "schema/contracts/migrations foundation only; no user-facing rollout behavior";
  readonly owner: "CEO";
  readonly decisionDate: "2026-07-25";
  readonly rollout: "merge allowed after CI/audit green; no runtime feature gate required";
}

export const POSTGRES_ORCHESTRATION_FEATURE_DECISION = {
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
} as const satisfies PostgresOrchestrationFeatureDecision;

const POSTGRES_ORCHESTRATION_METADATA: ProviderMetadata<"RelationalDatabaseProvider"> =
  {
    providerId: "postgres-orchestration-store",
    interfaceName: "RelationalDatabaseProvider",
    displayName: "PostgreSQL Orchestration Store",
    version: "ingress-v1",
    telemetryNamespace: "alterx.adapters.postgres.orchestration-store",
    supportsTenantOverrides: false,
    migration: {
      strategyVersion: "ingress-core-v1",
      rollbackSupported: true,
    },
  };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireConfig(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(
      `Postgres orchestration store config field ${field} is required`,
    );
  }
}

function createPoolConfig(
  config: PostgresOrchestrationStoreConfig,
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
      "Postgres orchestration store config field port must be an integer from 1 to 65535",
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

export class PostgresOrchestrationStoreProvider
  implements RelationalDatabaseProvider
{
  readonly metadata = POSTGRES_ORCHESTRATION_METADATA;
  readonly capabilities = POSTGRES_ORCHESTRATION_CAPABILITIES;

  readonly #pool: Pool;
  readonly #migrationsFolder: string;

  constructor(
    config: PostgresOrchestrationStoreConfig,
    dependencies: PostgresOrchestrationStoreDependencies = {},
  ) {
    requireConfig("migrationsFolder", config.migrationsFolder);
    this.#pool =
      dependencies.pool ??
      (dependencies.poolFactory ?? ((poolConfig) => new Pool(poolConfig)))(
        createPoolConfig(config, dependencies.iamAuthTokenProvider),
      );
    // node-postgres requires an 'error' listener on the pool -- an idle
    // client's background connection fault (e.g. the server terminating the
    // connection during teardown) otherwise surfaces as an unhandled
    // process-level error instead of a catchable rejection. Guarded because
    // injected test-double pools (dependencies.pool) aren't required to
    // implement the full real Pool surface.
    if (typeof this.#pool.on === "function") {
      this.#pool.on("error", () => undefined);
    }
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
    operation: (transaction: OrchestrationTransaction) => Promise<T>,
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
      const transaction: OrchestrationTransaction = {
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

const sharedOrchestrationPools = new Map<string, Pool>();

/**
 * ENGINE-FIX-P3-22 (Wave 3 item 6). orchestration-service's app.module.ts
 * builds ~30 separate DI `useFactory` providers, each independently doing
 * `new PostgresOrchestrationStoreProvider(orchestrationStoreConfig(dbConfig))`
 * -- the constructor's own default (no poolFactory override) means every
 * one of those spins up its own fresh `new Pool(...)`, all pointed at the
 * same database with the same credentials. ~30 pools x pg's default
 * `max: 10` connections is up to 300 connections from one process --
 * same failure shape platform-api's ENGINE-FIX-P3-6 fixed for its 29
 * `new Pool({connectionString})` sites, just via this provider's
 * constructor instead of ad-hoc pool construction.
 *
 * Pass as `{ poolFactory: sharedOrchestrationPoolFactory }` at every call
 * site that should share a connection. Keyed by the resolved connection
 * identity (connectionString for static auth; host/port/database/user for
 * iam auth) rather than one single pool for everything, so call sites
 * that intentionally authenticate as a different role (e.g. the
 * deletion/system store's userOverride) still get their own pool instead
 * of silently reusing the tenant-scoped one.
 *
 * A plain module-level cache, not a DI-provided singleton -- matches
 * ENGINE-FIX-P3-6's own reasoning: routing this through Nest's DI graph
 * instead would mean every one of the ~30 call sites (and every test that
 * constructs one of the services around them in isolation) needs to
 * change how it's wired, not just add one constructor argument.
 */
export function sharedOrchestrationPoolFactory(config: PoolConfig): Pool {
  const key =
    config.connectionString !== undefined
      ? `static:${config.connectionString}`
      : `iam:${config.host}:${config.port}/${config.database}:${config.user}`;
  const existing = sharedOrchestrationPools.get(key);
  if (existing) return existing;
  const pool = new Pool(config);
  sharedOrchestrationPools.set(key, pool);
  return pool;
}
