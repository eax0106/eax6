import { Signer } from "@aws-sdk/rds-signer";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { staticPoolConfig } from "./static-connection";
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from "pg";

import type { ProviderCapabilities } from "@alterx/contracts";
import {
  auditGenesisHash,
  calculateAuditEntryHash,
  type AuditChainCheckpoint,
  type AuditEventQuery,
  type AuditEventQueryResult,
  type AuditEventToAppend,
  type AuditStoreProvider,
  type DeletionCertificateToStore,
  type DeletionLedgerEntry,
  type ProviderHealth,
  type ProviderMetadata,
  type StoredAuditEvent,
} from "@alterx/shared-clients";

interface PostgresAuditStoreBaseConfig {
  readonly migrationsFolder: string;
  readonly retentionConnectionString?: string;
}

export interface PostgresAuditStoreStaticConfig
  extends PostgresAuditStoreBaseConfig {
  readonly authentication: "static";
  readonly connectionString: string;
}

export interface PostgresAuditStoreIamConfig
  extends PostgresAuditStoreBaseConfig {
  readonly authentication: "iam";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly region: string;
}

export type PostgresAuditStoreConfig =
  | PostgresAuditStoreStaticConfig
  | PostgresAuditStoreIamConfig;

interface IamAuthTokenProvider {
  getAuthToken(): Promise<string>;
}

interface PostgresAuditStoreDependencies {
  readonly pool?: Pool;
  readonly retentionPool?: Pool;
  readonly iamAuthTokenProvider?: IamAuthTokenProvider;
  readonly poolFactory?: (config: PoolConfig) => Pool;
}

interface DatabaseAuditRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly tenant_pseudonym: string | null;
  readonly actor_type: StoredAuditEvent["actorType"];
  readonly actor_ref: string;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_ref: string | null;
  readonly result: StoredAuditEvent["result"];
  readonly reason_code: string | null;
  readonly context: StoredAuditEvent["context"];
  readonly occurred_at: Date;
  readonly prev_hash: Buffer;
  readonly entry_hash: Buffer;
  readonly erased_at: Date | null;
  readonly chain_position: string;
}

const POSTGRES_AUDIT_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tool_calling: false,
  vision: false,
  structured_output: true,
  long_context: false,
  regional_availability: ["ap-south-1"],
  data_residency: ["IN"],
  batch_support: false,
  maximum_payload: 8_192,
  supported_languages: [],
  cost_model: { rates: [] },
};

const POSTGRES_AUDIT_METADATA: ProviderMetadata<"AuditStoreProvider"> = {
  providerId: "postgres-audit-store",
  interfaceName: "AuditStoreProvider",
  displayName: "PostgreSQL Audit Store",
  version: "foundation-v1",
  telemetryNamespace: "alterx.adapters.postgres.audit-store",
  supportsTenantOverrides: false,
  migration: {
    strategyVersion: "audit-events-v1",
    rollbackSupported: true,
  },
};

function requireConfig(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Postgres audit store config field ${field} is required`);
  }
}

function createPoolConfig(
  config: PostgresAuditStoreConfig,
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
      "Postgres audit store config field port must be an integer from 1 to 65535",
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

function toStoredAuditEvent(row: DatabaseAuditRow): StoredAuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantPseudonym: row.tenant_pseudonym,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    action: row.action,
    targetType: row.target_type,
    targetRef: row.target_ref,
    result: row.result,
    reasonCode: row.reason_code,
    context: row.context,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
    erasedAt: row.erased_at ?? null,
    chainPosition: Number(row.chain_position),
  };
}

async function enableInternalAuditAccess(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.audit_internal', 'on', true)");
}

export class PostgresAuditStoreProvider implements AuditStoreProvider {
  readonly metadata = POSTGRES_AUDIT_METADATA;
  readonly capabilities = POSTGRES_AUDIT_CAPABILITIES;

  readonly #pool: Pool;
  readonly #retentionPool: Pool | undefined;
  readonly #migrationsFolder: string;

  constructor(
    config: PostgresAuditStoreConfig,
    dependencies: PostgresAuditStoreDependencies = {},
  ) {
    requireConfig("migrationsFolder", config.migrationsFolder);
    this.#pool =
      dependencies.pool ??
      (dependencies.poolFactory ?? ((poolConfig) => new Pool(poolConfig)))(
        createPoolConfig(config, dependencies.iamAuthTokenProvider),
      );
    this.#migrationsFolder = config.migrationsFolder;
    if (config.retentionConnectionString !== undefined && new URL(config.retentionConnectionString).username !== "audit_retention") {
      throw new Error("Audit retention connection must use audit_retention");
    }
    this.#retentionPool = dependencies.retentionPool ?? (config.retentionConnectionString === undefined
      ? undefined : new Pool(staticPoolConfig(config.retentionConnectionString)));
  }

  async migrate(): Promise<void> {
    if (this.#retentionPool !== undefined) {
      const role = await this.#retentionPool.query<{ username: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        "SELECT session_user AS username, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = session_user",
      );
      const configured = role.rows[0];
      if (configured?.username !== "audit_retention" || configured.rolsuper || configured.rolbypassrls || configured.rolcreaterole) {
        throw new Error("Audit retention connection must use its restricted login");
      }
    }
    await migrate(drizzle(this.#pool), {
      migrationsFolder: this.#migrationsFolder,
    });
  }

  async append(event: AuditEventToAppend, seal?: AuditChainCheckpoint): Promise<StoredAuditEvent> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await enableInternalAuditAccess(client);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('alter.audit.global-chain.v1', 0))",
      );

      const tipResult = await client.query<{ entry_hash: Buffer; chain_position: string }>(`
        SELECT current_event.entry_hash, current_event.chain_position FROM audit_events AS current_event
        ORDER BY current_event.chain_position DESC LIMIT 1
      `);
      if (tipResult.rowCount !== 0 && tipResult.rowCount !== 1) {
        throw new Error("Audit chain has multiple tips");
      }

      const tip = tipResult.rows[0];
      const checkpointResult = await client.query<{ last_entry_hash: Buffer; last_position: string; signature: Buffer }>(
        "SELECT last_entry_hash, last_position, signature FROM audit_chain_checkpoints WHERE id = 'global' AND signature IS NOT NULL",
      );
      const currentSeal = checkpointResult.rows[0];
      if (currentSeal !== undefined && (tip === undefined || Number(tip.chain_position) < Number(currentSeal.last_position)) &&
          (seal?.signature === undefined || seal.lastPosition !== Number(currentSeal.last_position) ||
           !seal.lastEntryHash.equals(currentSeal.last_entry_hash) || !seal.signature.equals(currentSeal.signature))) {
        throw new Error("Audit checkpoint changed; retry append with a validated seal");
      }
      const prevHash = seal?.signature !== undefined && seal.lastPosition !== undefined &&
        (tip === undefined || Number(tip.chain_position) < seal.lastPosition)
        ? seal.lastEntryHash : tip?.entry_hash ?? auditGenesisHash();
      const pendingEvent = { ...event, prevHash, erasedAt: null as Date | null };
      const entryHash = calculateAuditEntryHash(pendingEvent);
      const inserted = await client.query<DatabaseAuditRow>(
        `
          INSERT INTO audit_events (
            id, tenant_id, tenant_pseudonym, actor_type, actor_ref, action,
            target_type, target_ref, result, reason_code, context, occurred_at,
            prev_hash, entry_hash
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14
          )
          RETURNING *
        `,
        [
          event.id,
          event.tenantId,
          event.tenantPseudonym,
          event.actorType,
          event.actorRef,
          event.action,
          event.targetType,
          event.targetRef,
          event.result,
          event.reasonCode,
          event.context,
          event.occurredAt,
          prevHash,
          entryHash,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Audit insert returned no row");
      }

      await client.query("COMMIT");
      return toStoredAuditEvent(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<StoredAuditEvent | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await enableInternalAuditAccess(client);
      const result = await client.query<DatabaseAuditRow>(
        "SELECT * FROM audit_events WHERE id = $1",
        [id],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? undefined : toStoredAuditEvent(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readGlobalChain(): Promise<readonly StoredAuditEvent[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await enableInternalAuditAccess(client);
      const result = await client.query<DatabaseAuditRow>(
        "SELECT * FROM audit_events",
      );
      await client.query("COMMIT");
      return result.rows.map(toStoredAuditEvent);
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * ENGINE-FIX-P3-13: bounded forward walk from a checkpoint hash via
   * prev_hash/entry_hash links (both unique-indexed), never the whole
   * table. Recursion is capped inside the recursive term (WHERE depth <
   * $2), which actually bounds how far Postgres recurses -- an outer LIMIT
   * on a recursive CTE only bounds the output, not the computation.
   */
  async readChainSince(
    afterEntryHash: Buffer,
    limit: number,
    afterPosition?: number,
  ): Promise<readonly StoredAuditEvent[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await enableInternalAuditAccess(client);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Audit verification limit invalid");
      let position = afterPosition ?? 0;
      if (afterPosition !== undefined && (!Number.isSafeInteger(afterPosition) || afterPosition < 0)) {
        throw new Error("Audit checkpoint position invalid");
      }
      if (afterPosition === undefined && !afterEntryHash.equals(auditGenesisHash())) {
        const anchor = await client.query<{ chain_position: string }>(
          "SELECT chain_position FROM audit_events WHERE entry_hash = $1", [afterEntryHash]);
        if (anchor.rows[0] === undefined) throw new Error("Audit checkpoint anchor missing");
        position = Number(anchor.rows[0].chain_position);
      }
      const result = await client.query<DatabaseAuditRow>(
        "SELECT * FROM audit_events WHERE chain_position > $1 ORDER BY chain_position LIMIT $2",
        [position, limit],
      );
      await client.query("COMMIT");
      return result.rows.map(toStoredAuditEvent);
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getChainCheckpoint(): Promise<AuditChainCheckpoint | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await enableInternalAuditAccess(client);
      const result = await client.query<{
        last_entry_hash: Buffer;
        checked_events: string;
        verified_at: Date;
        signature: Buffer | null;
        last_position: string | null;
      }>(
        `SELECT last_entry_hash, checked_events, verified_at, signature, last_position
           FROM audit_chain_checkpoints WHERE id = 'global'`,
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            lastEntryHash: row.last_entry_hash,
            ...(row.last_position === null ? {} : { lastPosition: Number(row.last_position) }),
            checkedEvents: Number(row.checked_events),
            verifiedAt: row.verified_at,
            ...(row.signature === null ? {} : { signature: row.signature }),
          };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setChainCheckpoint(checkpoint: AuditChainCheckpoint): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await enableInternalAuditAccess(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('alter.audit.global-chain.v1', 0))");
      const saved = await client.query(
        `INSERT INTO audit_chain_checkpoints (id, last_entry_hash, checked_events, verified_at, signature, last_position)
         VALUES ('global', $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET last_entry_hash = EXCLUDED.last_entry_hash,
               checked_events = EXCLUDED.checked_events,
               verified_at = EXCLUDED.verified_at,
               signature = EXCLUDED.signature,
               last_position = EXCLUDED.last_position
         WHERE audit_chain_checkpoints.signature IS NULL OR
           (EXCLUDED.signature IS NOT NULL AND EXCLUDED.last_position >= audit_chain_checkpoints.last_position)`,
        [checkpoint.lastEntryHash, checkpoint.checkedEvents, checkpoint.verifiedAt, checkpoint.signature ?? null, checkpoint.lastPosition ?? null],
      );
      if (saved.rowCount !== 1) throw new Error("Audit checkpoint advancement became stale");
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Dedicated session only; database clock stamps erasure, never caller time. */
  async minimiseTenantEvents(tenantId: string, pseudonym: string, _erasedAt: Date, seal?: AuditChainCheckpoint): Promise<number> {
    if (seal?.signature === undefined || seal.lastPosition === undefined) throw new Error("Signed audit prefix required");
    const bare = tenantId.startsWith("ten_") ? tenantId.slice(4) : tenantId;
    return this.retentionMutation("SELECT minimise_audit_tenant($1, $2, $3, $4) AS n", [bare, pseudonym, seal.lastPosition, seal.lastEntryHash]);
  }

  async expireSkeletons(cutoff: Date, anchorHash: Buffer, anchorPosition?: number): Promise<number> {
    if (anchorPosition === undefined) throw new Error("Signed audit prefix required");
    return this.retentionMutation("SELECT expire_audit_skeletons($1, $2, $3) AS n", [cutoff, anchorHash, anchorPosition]);
  }

  private async retentionMutation(sql: string, parameters: readonly unknown[]): Promise<number> {
    if (this.#retentionPool === undefined) throw new Error("Dedicated audit retention connection is required");
    const result = await this.#retentionPool.query<{ n: number }>(sql, [...parameters]);
    return result.rows[0]?.n ?? 0;
  }

  async queryEvents(query: AuditEventQuery): Promise<AuditEventQueryResult> {
    const limit = Math.min(Math.max(query.limit, 1), 200);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await enableInternalAuditAccess(client);

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (query.tenantId !== null) {
        conditions.push(`tenant_id = $${paramIndex++}`);
        params.push(query.tenantId);
      }
      if (query.actorTypes !== undefined && query.actorTypes.length > 0) {
        conditions.push(`actor_type = ANY($${paramIndex++})`);
        params.push(query.actorTypes);
      }
      if (query.action !== undefined) {
        conditions.push(`action = $${paramIndex++}`);
        params.push(query.action);
      }
      if (query.result !== undefined) {
        conditions.push(`result = $${paramIndex++}`);
        params.push(query.result);
      }
      if (query.occurredAfter !== undefined) {
        conditions.push(`occurred_at >= $${paramIndex++}`);
        params.push(query.occurredAfter);
      }
      if (query.occurredBefore !== undefined) {
        conditions.push(`occurred_at <= $${paramIndex++}`);
        params.push(query.occurredBefore);
      }
      if (query.cursor !== undefined) {
        // Keyset pagination on (occurred_at, id) -- matches the ORDER BY
        // below exactly, so pages never skip or repeat a row even when
        // multiple events share the same occurred_at timestamp.
        conditions.push(
          `(occurred_at, id) > (SELECT occurred_at, id FROM audit_events WHERE id = $${paramIndex++})`,
        );
        params.push(query.cursor);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit + 1);
      const result = await client.query<DatabaseAuditRow>(
        `SELECT * FROM audit_events ${whereClause} ORDER BY occurred_at, id LIMIT $${paramIndex}`,
        params,
      );
      await client.query("COMMIT");

      const hasMore = result.rows.length > limit;
      const page = hasMore ? result.rows.slice(0, limit) : result.rows;
      return {
        events: page.map(toStoredAuditEvent),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async storeDeletionCertificate(certificate: DeletionCertificateToStore): Promise<void> {
    await this.#pool.query(
      `INSERT INTO deletion_certificates
         (id, tenant_pseudonym, manifest, requested_at, completed_at, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [certificate.id, certificate.tenantPseudonym, certificate.manifest,
        certificate.requestedAt, certificate.completedAt, certificate.verifiedBy],
    );
  }

  async appendDeletionLedger(entry: DeletionLedgerEntry): Promise<void> {
    await this.#pool.query(
      `INSERT INTO deletion_ledger
         (id, subject_pseudonym, subject_selectors, deleted_at)
       VALUES ($1,$2,$3,$4)`,
      [entry.id, entry.subjectPseudonym, entry.subjectSelectors, entry.deletedAt],
    );
  }

  async storeDeletionCompletion(
    certificate: DeletionCertificateToStore,
    entry: DeletionLedgerEntry,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO deletion_ledger
           (id, subject_pseudonym, subject_selectors, deleted_at)
         VALUES ($1,$2,$3,$4)`,
        [entry.id, entry.subjectPseudonym, entry.subjectSelectors, entry.deletedAt],
      );
      await client.query(
        `INSERT INTO deletion_certificates
           (id, tenant_pseudonym, manifest, requested_at, completed_at, verified_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [certificate.id, certificate.tenantPseudonym, certificate.manifest,
          certificate.requestedAt, certificate.completedAt, certificate.verifiedBy],
      );
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDeletionLedgerSince(since: Date): Promise<readonly DeletionLedgerEntry[]> {
    const result = await this.#pool.query<{
      id: string;
      subject_pseudonym: string;
      subject_selectors: Readonly<Record<string, import("@alterx/shared-clients").JsonValue>>;
      deleted_at: Date;
    }>(
      `SELECT id, subject_pseudonym, subject_selectors, deleted_at
       FROM deletion_ledger WHERE deleted_at >= $1 ORDER BY deleted_at, id`,
      [since],
    );
    return result.rows.map((row) => ({
      id: row.id,
      subjectPseudonym: row.subject_pseudonym,
      subjectSelectors: row.subject_selectors,
      deletedAt: row.deleted_at,
    }));
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
    await this.#retentionPool?.end();
    await this.#pool.end();
  }
}
