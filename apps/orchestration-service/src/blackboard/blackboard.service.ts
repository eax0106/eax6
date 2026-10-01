import {
  NonEmptyStringSchema,
  RunIdSchema,
  TenantIdSchema,
} from "@alterx/contracts";
import type { CacheProvider, JsonValue } from "@alterx/shared-clients";

const DEFAULT_HOT_CONTEXT_TTL_SECONDS = 24 * 60 * 60;
const MAX_CONTEXT_KEYS_PER_INHERITANCE = 256;
const MAX_CONTEXT_VALUE_BYTES = 262_144;
const MAX_JSON_DEPTH = 64;
const CONTEXT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: OrchestrationTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export interface BlackboardServiceOptions {
  readonly hotContextTtlSeconds?: number;
}

export interface BlackboardWriteRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly key: string;
  readonly value: JsonValue;
}

export interface BlackboardReadRequest {
  readonly tenantId: string;
  readonly runId: string;
  readonly key: string;
}

export interface BlackboardInheritanceRequest {
  readonly tenantId: string;
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly keys: readonly string[];
}

export interface BlackboardInheritanceResult {
  readonly inheritedKeys: readonly string[];
}

interface RevisionRow extends Record<string, unknown> {
  readonly revision: number;
}

interface CheckpointRow extends RevisionRow {
  readonly context_key: string;
  readonly value_json: JsonValue;
}

interface CacheEnvelope {
  readonly tenantId: string;
  readonly revision: number;
  readonly value: JsonValue;
}

export class BlackboardValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid Blackboard request: ${reason}`);
    this.name = "BlackboardValidationError";
  }
}

export class BlackboardRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Blackboard run not found: ${runId}`);
    this.name = "BlackboardRunNotFoundError";
  }
}

export class BlackboardCheckpointNotFoundError extends Error {
  constructor(keys: readonly string[]) {
    super(`Blackboard checkpoints not found: ${keys.join(", ")}`);
    this.name = "BlackboardCheckpointNotFoundError";
  }
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new BlackboardValidationError(
      "tenantId must be a ten_ prefixed UUIDv7",
    );
  }
  return parsed.data.slice("ten_".length);
}

function requireRunId(runId: string, field: string): void {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new BlackboardValidationError(
      `${field} must be a run_ prefixed UUIDv7`,
    );
  }
}

function requireContextKey(key: string): void {
  if (
    !NonEmptyStringSchema.safeParse(key).success ||
    !CONTEXT_KEY_PATTERN.test(key)
  ) {
    throw new BlackboardValidationError(
      "key must be 1-128 characters using letters, numbers, dot, underscore, or hyphen",
    );
  }
}

function hotContextKey(runId: string, key: string): string {
  return `bb:${runId}:${key}`;
}

function assertJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new BlackboardValidationError(
      `value nesting exceeds ${MAX_JSON_DEPTH} levels`,
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BlackboardValidationError("value numbers must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new BlackboardValidationError("value must contain JSON-compatible data");
  }
  if (seen.has(value)) {
    throw new BlackboardValidationError("value must not contain circular references");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new BlackboardValidationError("value must contain plain JSON objects");
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    assertJsonValue(child, depth + 1, seen);
  }
  seen.delete(value);
}

export function serializeValue(value: JsonValue): string {
  assertJsonValue(value, 0, new WeakSet());
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_VALUE_BYTES) {
    throw new BlackboardValidationError(
      `value exceeds ${MAX_CONTEXT_VALUE_BYTES} UTF-8 bytes`,
    );
  }
  return serialized;
}

function parseCacheEnvelope(raw: string): CacheEnvelope | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof Reflect.get(parsed, "tenantId") !== "string" ||
      !Number.isInteger(Reflect.get(parsed, "revision")) ||
      (Reflect.get(parsed, "revision") as number) < 1 ||
      !Object.prototype.hasOwnProperty.call(parsed, "value")
    ) {
      return undefined;
    }
    return parsed as CacheEnvelope;
  } catch {
    return undefined;
  }
}

export class BlackboardService {
  readonly #store: OrchestrationTenantStore;
  readonly #cache: CacheProvider;
  readonly #hotContextTtlSeconds: number;

  constructor(
    store: OrchestrationTenantStore,
    cache: CacheProvider,
    options: BlackboardServiceOptions = {},
  ) {
    const ttlSeconds =
      options.hotContextTtlSeconds ?? DEFAULT_HOT_CONTEXT_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new BlackboardValidationError(
        "hotContextTtlSeconds must be a positive integer",
      );
    }
    this.#store = store;
    this.#cache = cache;
    this.#hotContextTtlSeconds = ttlSeconds;
  }

  async writeValue(request: BlackboardWriteRequest): Promise<void> {
    const bareTenant = bareTenantUuid(request.tenantId);
    requireRunId(request.runId, "runId");
    requireContextKey(request.key);
    const serializedValue = serializeValue(request.value);

    const revision = await this.#store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<RevisionRow>(
        `INSERT INTO blackboard_checkpoints
           (tenant_id, run_id, context_key, value_json)
         SELECT $1, $2, $3, $4::jsonb
         FROM runs
         WHERE tenant_id = $1 AND id = $2
         ON CONFLICT (tenant_id, run_id, context_key)
         DO UPDATE SET
           value_json = EXCLUDED.value_json,
           revision = blackboard_checkpoints.revision + 1,
           updated_at = clock_timestamp()
         RETURNING revision`,
        [bareTenant, request.runId, request.key, serializedValue],
      );
      const storedRevision = result.rows[0]?.revision;
      if (storedRevision === undefined) {
        throw new BlackboardRunNotFoundError(request.runId);
      }
      return storedRevision;
    });

    await this.#writeHotValue(
      request.tenantId,
      request.runId,
      request.key,
      revision,
      request.value,
    );
  }

  async readValue(
    request: BlackboardReadRequest,
  ): Promise<JsonValue | undefined> {
    const bareTenant = bareTenantUuid(request.tenantId);
    requireRunId(request.runId, "runId");
    requireContextKey(request.key);

    const revision = await this.#store.withTenant(bareTenant, async (tx) => {
      const result = await tx.query<RevisionRow>(
        `SELECT revision
         FROM blackboard_checkpoints
         WHERE tenant_id = $1 AND run_id = $2 AND context_key = $3`,
        [bareTenant, request.runId, request.key],
      );
      return result.rows[0]?.revision;
    });
    if (revision === undefined) {
      return undefined;
    }

    const cached = await this.#readHotValue(request.runId, request.key);
    if (
      cached !== undefined &&
      cached.tenantId === request.tenantId &&
      cached.revision === revision
    ) {
      return cached.value;
    }

    const checkpoint = await this.#store.withTenant(
      bareTenant,
      async (tx) => {
        const result = await tx.query<CheckpointRow>(
          `SELECT context_key, value_json, revision
           FROM blackboard_checkpoints
           WHERE tenant_id = $1 AND run_id = $2 AND context_key = $3`,
          [bareTenant, request.runId, request.key],
        );
        return result.rows[0];
      },
    );
    if (checkpoint === undefined) {
      return undefined;
    }

    await this.#writeHotValue(
      request.tenantId,
      request.runId,
      request.key,
      checkpoint.revision,
      checkpoint.value_json,
    );
    return checkpoint.value_json;
  }

  async inheritContext(
    request: BlackboardInheritanceRequest,
  ): Promise<BlackboardInheritanceResult> {
    const bareTenant = bareTenantUuid(request.tenantId);
    requireRunId(request.parentRunId, "parentRunId");
    requireRunId(request.childRunId, "childRunId");
    if (request.parentRunId === request.childRunId) {
      throw new BlackboardValidationError(
        "parentRunId and childRunId must differ",
      );
    }
    const keys = [...new Set(request.keys)];
    if (keys.length > MAX_CONTEXT_KEYS_PER_INHERITANCE) {
      throw new BlackboardValidationError(
        `keys must contain at most ${MAX_CONTEXT_KEYS_PER_INHERITANCE} entries`,
      );
    }
    for (const key of keys) {
      requireContextKey(key);
    }
    if (keys.length === 0) {
      return { inheritedKeys: [] };
    }

    const inherited = await this.#store.withTenant(
      bareTenant,
      async (tx) => {
        const runs = await tx.query<{ readonly id: string }>(
          `SELECT id
           FROM runs
           WHERE tenant_id = $1 AND id = ANY($2::text[])`,
          [bareTenant, [request.parentRunId, request.childRunId]],
        );
        const visibleRunIds = new Set(runs.rows.map((row) => row.id));
        for (const runId of [request.parentRunId, request.childRunId]) {
          if (!visibleRunIds.has(runId)) {
            throw new BlackboardRunNotFoundError(runId);
          }
        }

        const result = await tx.query<CheckpointRow>(
          `INSERT INTO blackboard_checkpoints
             (tenant_id, run_id, context_key, value_json)
           SELECT tenant_id, $3, context_key, value_json
           FROM blackboard_checkpoints
           WHERE tenant_id = $1
             AND run_id = $2
             AND context_key = ANY($4::text[])
           ON CONFLICT (tenant_id, run_id, context_key)
           DO UPDATE SET
             value_json = EXCLUDED.value_json,
             revision = blackboard_checkpoints.revision + 1,
             updated_at = clock_timestamp()
           RETURNING context_key, value_json, revision`,
          [
            bareTenant,
            request.parentRunId,
            request.childRunId,
            keys,
          ],
        );
        const inheritedKeys = new Set(
          result.rows.map((row) => row.context_key),
        );
        const missingKeys = keys.filter((key) => !inheritedKeys.has(key));
        if (missingKeys.length > 0) {
          throw new BlackboardCheckpointNotFoundError(missingKeys);
        }
        return result.rows;
      },
    );

    for (const checkpoint of inherited) {
      await this.#writeHotValue(
        request.tenantId,
        request.childRunId,
        checkpoint.context_key,
        checkpoint.revision,
        checkpoint.value_json,
      );
    }
    return { inheritedKeys: inherited.map((row) => row.context_key) };
  }

  async #readHotValue(
    runId: string,
    key: string,
  ): Promise<CacheEnvelope | undefined> {
    try {
      const raw = await this.#cache.getValue(hotContextKey(runId, key));
      return raw === undefined ? undefined : parseCacheEnvelope(raw);
    } catch {
      return undefined;
    }
  }

  async #writeHotValue(
    tenantId: string,
    runId: string,
    key: string,
    revision: number,
    value: JsonValue,
  ): Promise<void> {
    try {
      await this.#cache.setValue(
        hotContextKey(runId, key),
        JSON.stringify({ tenantId, revision, value } satisfies CacheEnvelope),
        this.#hotContextTtlSeconds,
      );
    } catch {
      // Redis is disposable acceleration. Durable checkpoint already exists.
    }
  }
}
