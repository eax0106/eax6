import { TenantIdSchema } from "@alterx/contracts";
import type {
  CronScheduleManager,
  CronScheduleUpsertRequest,
} from "@alterx/shared-clients";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { computeNextCronFireTime, validateCronExpression } from "./cron-validator";
import { defaultDlqPolicy, validateDlqPolicy, type DlqPolicy } from "./dlq-policy";
import {
  TRIGGER_CRON_FIRE_DETAIL_TYPE,
  TRIGGER_CRON_FIRE_EVENT_TYPE,
  TRIGGER_CRON_FIRE_SOURCE,
  TRIGGER_DISPATCH_SCHEMA_VERSION,
  TRIGGER_DISPATCH_WORKFLOW_TYPE,
  triggerScheduleId,
} from "./trigger-dispatch.constants";

export class TriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerValidationError";
  }
}

export class TriggerNotFoundError extends Error {
  constructor(triggerId: string) {
    super(`Trigger ${triggerId} was not found`);
    this.name = "TriggerNotFoundError";
  }
}

export class TriggerStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Trigger cannot transition from "${from}" to "${to}"`);
    this.name = "TriggerStateTransitionError";
  }
}

export type TriggerType = "webhook" | "cron" | "manual";
export type TriggerStatus = "draft" | "enabled" | "disabled" | "archived";
export type TriggerVersionStatus = "active" | "superseded" | "disabled";

export interface TriggerVersionConfig {
  readonly cronExpression?: string;
  readonly dlqPolicy: DlqPolicy;
  readonly [key: string]: unknown;
}

export interface Trigger {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly type: TriggerType;
  readonly status: TriggerStatus;
  readonly provider: string | null;
}

export interface TriggerVersion {
  readonly id: string;
  readonly tenantId: string;
  readonly triggerId: string;
  readonly version: number;
  readonly workflowVersionId: string | null;
  readonly config: TriggerVersionConfig;
  readonly status: TriggerVersionStatus;
  readonly nextFireAt: string | null;
}

export interface RegisterTriggerRequest {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly type: TriggerType;
  readonly provider?: string;
  readonly workflowVersionId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface RegisterTriggerResult {
  readonly trigger: Trigger;
  readonly triggerVersion: TriggerVersion;
}

export interface CreateTriggerVersionRequest {
  readonly tenantId: string;
  readonly triggerId: string;
  readonly workflowVersionId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface TriggerTestResult {
  readonly eventId: string;
  readonly triggerId: string;
  readonly triggerVersion: number;
}

export interface TriggerWebhookSecretRotation {
  readonly triggerId: string;
  readonly secret: string;
  readonly secretVersion: number;
}

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

const WORKFLOW_VERSION_ID_PATTERN =
  /^wfv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new TriggerValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

/**
 * `triggers.workspace_id` is a bare `uuid` column, while callers disagree
 * about the form they hold: platform-api sends the `ws_`-prefixed id the API
 * boundary uses, and the service's own inbound paths (WhatsApp dispatch, the
 * ingress checks) already hold the bare uuid. Inserting the prefixed value
 * made Postgres reject the row, so registering a trigger answered 500 for
 * every type and every config. Both spellings are accepted and stored the one
 * way the column can hold, rather than making either caller convert.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bareWorkspaceUuid(workspaceId: string): string {
  const bare = workspaceId.startsWith("ws_")
    ? workspaceId.slice("ws_".length)
    : workspaceId;
  if (!UUID_PATTERN.test(bare)) {
    throw new TriggerValidationError(
      "workspaceId must be a UUID, with or without the ws_ prefix",
    );
  }
  return bare;
}

function requireNonEmpty(field: string, value: string | undefined): void {
  if (value === undefined || value.trim().length === 0) {
    throw new TriggerValidationError(`${field} is required`);
  }
}

function requireValidWorkflowVersionId(workflowVersionId: string | undefined): void {
  if (workflowVersionId === undefined) {
    return;
  }
  if (!WORKFLOW_VERSION_ID_PATTERN.test(workflowVersionId)) {
    throw new TriggerValidationError(
      "workflowVersionId must be a wfv_ prefixed UUIDv7",
    );
  }
}

function buildVersionConfig(
  type: TriggerType,
  rawConfig: Readonly<Record<string, unknown>> | undefined,
): TriggerVersionConfig {
  const config = rawConfig ?? {};
  const dlqPolicy = validateDlqPolicy(config.dlqPolicy ?? {});

  if (type === "cron") {
    const cronExpression = config.cronExpression;
    if (typeof cronExpression !== "string" || cronExpression.trim().length === 0) {
      throw new TriggerValidationError(
        "cron triggers require a non-empty config.cronExpression",
      );
    }
    validateCronExpression(cronExpression);
    return { ...config, cronExpression, dlqPolicy };
  }

  return { ...config, dlqPolicy };
}

function computeNextFireAt(config: TriggerVersionConfig): string | null {
  if (config.cronExpression === undefined) {
    return null;
  }
  return computeNextCronFireTime(config.cronExpression).toISOString();
}

export class TriggerRegistryService {
  constructor(
    private readonly store: OrchestrationTenantStore,
    private readonly mintId: () => string = mintV7Id,
    private readonly scheduleManager?: CronScheduleManager,
  ) {}

  async registerTrigger(
    request: RegisterTriggerRequest,
  ): Promise<RegisterTriggerResult> {
    requireNonEmpty("tenantId", request.tenantId);
    requireNonEmpty("workspaceId", request.workspaceId);
    requireNonEmpty("workflowId", request.workflowId);
    requireNonEmpty("name", request.name);
    if (!["webhook", "cron", "manual"].includes(request.type)) {
      throw new TriggerValidationError(
        `type must be one of webhook, cron, manual`,
      );
    }
    requireValidWorkflowVersionId(request.workflowVersionId);
    const config = buildVersionConfig(request.type, request.config);
    const nextFireAt = computeNextFireAt(config);
    const tenantId = bareTenantUuid(request.tenantId);
    const workspaceId = bareWorkspaceUuid(request.workspaceId);

    return this.store.withTenant(tenantId, async (tx) => {
      const triggerId = `trg_${this.mintId()}`;
      const triggerVersionId = `trv_${this.mintId()}`;

      await tx.query(
        `INSERT INTO triggers (id, tenant_id, workspace_id, workflow_id, name, type, status, provider)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)`,
        [
          triggerId,
          tenantId,
          workspaceId,
          request.workflowId,
          request.name,
          request.type,
          request.provider ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO trigger_versions (id, tenant_id, trigger_id, version, workflow_version_id, config, status, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())`,
        [
          triggerVersionId,
          tenantId,
          triggerId,
          1,
          request.workflowVersionId ?? null,
          JSON.stringify(config),
        ],
      );

      return {
        trigger: {
          id: triggerId,
          tenantId: request.tenantId,
          // The stored value, so registering and reading a trigger describe
          // its workspace the same way; every read returns the bare column.
          workspaceId,
          workflowId: request.workflowId,
          name: request.name,
          type: request.type,
          status: "draft",
          provider: request.provider ?? null,
        },
        triggerVersion: {
          id: triggerVersionId,
          tenantId: request.tenantId,
          triggerId,
          version: 1,
          workflowVersionId: request.workflowVersionId ?? null,
          config,
          status: "active",
          nextFireAt,
        },
      };
    });
  }

  async createTriggerVersion(
    request: CreateTriggerVersionRequest,
  ): Promise<TriggerVersion> {
    requireNonEmpty("tenantId", request.tenantId);
    requireNonEmpty("triggerId", request.triggerId);
    requireValidWorkflowVersionId(request.workflowVersionId);
    const tenantId = bareTenantUuid(request.tenantId);

    const created = await this.store.withTenant(tenantId, async (tx) => {
      const triggerResult = await tx.query<{
        type: TriggerType;
        status: TriggerStatus;
        workspace_id: string;
      }>(
        `SELECT type, status, workspace_id FROM triggers WHERE tenant_id = $1 AND id = $2`,
        [tenantId, request.triggerId],
      );
      const triggerRow = triggerResult.rows[0];
      if (triggerRow === undefined) {
        throw new TriggerNotFoundError(request.triggerId);
      }
      const config = buildVersionConfig(triggerRow.type, request.config);
      const nextFireAt = computeNextFireAt(config);

      const currentVersionResult = await tx.query<{ version: number }>(
        `SELECT version FROM trigger_versions
         WHERE tenant_id = $1 AND trigger_id = $2
         ORDER BY version DESC LIMIT 1`,
        [tenantId, request.triggerId],
      );
      const currentVersion = currentVersionResult.rows[0]?.version ?? 0;
      const nextVersion = currentVersion + 1;

      await tx.query(
        `UPDATE trigger_versions SET status = 'superseded'
         WHERE tenant_id = $1 AND trigger_id = $2 AND status = 'active'`,
        [tenantId, request.triggerId],
      );

      const triggerVersionId = `trv_${this.mintId()}`;
      await tx.query(
        `INSERT INTO trigger_versions (id, tenant_id, trigger_id, version, workflow_version_id, config, status, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())`,
        [
          triggerVersionId,
          tenantId,
          request.triggerId,
          nextVersion,
          request.workflowVersionId ?? null,
          JSON.stringify(config),
        ],
      );

      return {
        version: {
          id: triggerVersionId,
          tenantId: request.tenantId,
          triggerId: request.triggerId,
          version: nextVersion,
          workflowVersionId: request.workflowVersionId ?? null,
          config,
          status: "active" as const,
          nextFireAt,
        },
        type: triggerRow.type,
        triggerStatus: triggerRow.status,
        workspaceId: triggerRow.workspace_id,
      };
    });

    if (
      created.type === "cron" &&
      created.triggerStatus === "enabled" &&
      this.scheduleManager !== undefined
    ) {
      await this.scheduleManager.upsertCronSchedule(
        buildCronScheduleUpsert(
          tenantId,
          request.tenantId,
          created.workspaceId,
          request.triggerId,
          created.version.version,
          created.version.config,
        ),
      );
    }

    return created.version;
  }

  async setTriggerStatus(
    tenantIdInput: string,
    triggerId: string,
    targetStatus: TriggerStatus,
  ): Promise<Trigger> {
    requireNonEmpty("tenantId", tenantIdInput);
    requireNonEmpty("triggerId", triggerId);
    const tenantId = bareTenantUuid(tenantIdInput);

    const outcome = await this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        workflow_id: string;
        name: string;
        type: TriggerType;
        status: TriggerStatus;
        provider: string | null;
        active_version: number | null;
        active_config: unknown;
      }>(
        `SELECT t.id, t.workspace_id, t.workflow_id, t.name, t.type, t.status,
                t.provider, tv.version AS active_version, tv.config AS active_config
         FROM triggers t
         LEFT JOIN trigger_versions tv
           ON tv.tenant_id = t.tenant_id AND tv.trigger_id = t.id
          AND tv.status = 'active'
         WHERE t.tenant_id = $1 AND t.id = $2
         ORDER BY tv.version DESC LIMIT 1`,
        [tenantId, triggerId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new TriggerNotFoundError(triggerId);
      }
      assertValidStatusTransition(row.status, targetStatus);

      await tx.query(
        `UPDATE triggers SET status = $1, updated_at = now()
         WHERE tenant_id = $2 AND id = $3`,
        [targetStatus, tenantId, triggerId],
      );

      return {
        trigger: {
          id: row.id,
          tenantId: tenantIdInput,
          workspaceId: row.workspace_id,
          workflowId: row.workflow_id,
          name: row.name,
          type: row.type,
          status: targetStatus,
          provider: row.provider,
        },
        type: row.type,
        workspaceId: row.workspace_id,
        activeVersion: row.active_version,
        activeConfig: parseVersionConfig(row.active_config),
      };
    });

    await this.#syncCronSchedule(tenantIdInput, tenantId, {
      type: outcome.type,
      workspaceId: outcome.workspaceId,
      triggerId,
      targetStatus,
      activeVersion: outcome.activeVersion,
      activeConfig: outcome.activeConfig,
    });

    return outcome.trigger;
  }

  /**
   * INGR-7: keeps the Temporal cron Schedule in step with the trigger's
   * committed lifecycle. Only cron triggers get schedules; enabling one
   * upserts (replaces) the schedule with the active version's expression,
   * disabling/archiving deletes it. Runs after the DB commit; a failure is
   * NOT swallowed -- the DB state is already committed, and throwing lets
   * the caller see that the schedule side of the transition did not land.
   */
  async #syncCronSchedule(
    tenantIdInput: string,
    tenantId: string,
    context: {
      readonly type: TriggerType;
      readonly workspaceId: string;
      readonly triggerId: string;
      readonly targetStatus: TriggerStatus;
      readonly activeVersion: number | null;
      readonly activeConfig: TriggerVersionConfig | null;
    },
  ): Promise<void> {
    if (this.scheduleManager === undefined || context.type !== "cron") {
      return;
    }
    if (context.targetStatus === "disabled" || context.targetStatus === "archived") {
      await this.scheduleManager.deleteCronSchedule(
        triggerScheduleId(tenantId, context.triggerId),
      );
      return;
    }
    if (
      context.targetStatus === "enabled" &&
      context.activeVersion !== null &&
      context.activeConfig !== null
    ) {
      await this.scheduleManager.upsertCronSchedule(
        buildCronScheduleUpsert(
          tenantId,
          tenantIdInput,
          context.workspaceId,
          context.triggerId,
          context.activeVersion,
          context.activeConfig,
        ),
      );
    }
  }

  async testTrigger(
    tenantIdInput: string,
    triggerId: string,
  ): Promise<TriggerTestResult> {
    requireNonEmpty("tenantId", tenantIdInput);
    requireNonEmpty("triggerId", triggerId);
    const tenantId = bareTenantUuid(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const trigger = await tx.query<{
        id: string;
        workspace_id: string;
      }>(
        `SELECT id, workspace_id FROM triggers
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, triggerId],
      );
      const row = trigger.rows[0];
      if (row === undefined) throw new TriggerNotFoundError(triggerId);
      const version = await tx.query<{ version: number }>(
        `SELECT version FROM trigger_versions
         WHERE tenant_id = $1 AND trigger_id = $2 AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [tenantId, triggerId],
      );
      const active = version.rows[0];
      if (active === undefined) {
        throw new TriggerValidationError("trigger has no active version");
      }
      const eventId = `evt_${this.mintId()}`;
      await tx.query(
        `INSERT INTO events
           (event_id, event_type, schema_version, tenant_id, workspace_id, source,
            idempotency_key, occurred_at, trigger_id, trigger_version, payload, signature_status)
         VALUES ($1, 'trigger.test', 'v1', $2, $3, 'trigger-registry', $4,
                 clock_timestamp(), $5, $6, $7::jsonb, 'verified')`,
        [
          eventId,
          tenantId,
          row.workspace_id,
          `trigger-test:${triggerId}:${eventId}`,
          triggerId,
          active.version,
          JSON.stringify({ kind: "trigger_test", trigger_id: triggerId }),
        ],
      );
      return { eventId, triggerId, triggerVersion: active.version };
    });
  }

  async rotateWebhookSecret(
    tenantIdInput: string,
    triggerId: string,
  ): Promise<TriggerWebhookSecretRotation> {
    requireNonEmpty("tenantId", tenantIdInput);
    requireNonEmpty("triggerId", triggerId);
    const tenantId = bareTenantUuid(tenantIdInput);
    return this.store.withTenant(tenantId, async (tx) => {
      const trigger = await tx.query<{ type: TriggerType }>(
        "SELECT type FROM triggers WHERE tenant_id = $1 AND id = $2",
        [tenantId, triggerId],
      );
      const row = trigger.rows[0];
      if (row === undefined) throw new TriggerNotFoundError(triggerId);
      if (row.type !== "webhook") {
        throw new TriggerValidationError("only webhook triggers have webhook secrets");
      }
      const current = await tx.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version
         FROM trigger_webhook_secrets
         WHERE tenant_id = $1 AND trigger_id = $2`,
        [tenantId, triggerId],
      );
      const secretVersion = (current.rows[0]?.version ?? 0) + 1;
      const secret = randomBytes(32).toString("base64url");
      await tx.query(
        `INSERT INTO trigger_webhook_secrets
           (tenant_id, trigger_id, version, secret_hash)
         VALUES ($1, $2, $3, $4)`,
        [
          tenantId,
          triggerId,
          secretVersion,
          createHash("sha256").update(secret).digest("hex"),
        ],
      );
      return { triggerId, secret, secretVersion };
    });
  }

  async getTrigger(tenantIdInput: string, triggerId: string): Promise<Trigger> {
    requireNonEmpty("tenantId", tenantIdInput);
    requireNonEmpty("triggerId", triggerId);
    const tenantId = bareTenantUuid(tenantIdInput);

    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        workflow_id: string;
        name: string;
        type: TriggerType;
        status: TriggerStatus;
        provider: string | null;
      }>(
        `SELECT id, workspace_id, workflow_id, name, type, status, provider
         FROM triggers WHERE tenant_id = $1 AND id = $2`,
        [tenantId, triggerId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new TriggerNotFoundError(triggerId);
      }
      return {
        id: row.id,
        tenantId: tenantIdInput,
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        name: row.name,
        type: row.type,
        status: row.status,
        provider: row.provider,
      };
    });
  }

  async listTriggers(
    tenantIdInput: string,
    workflowId?: string,
    workspaceId?: string,
  ): Promise<readonly Trigger[]> {
    requireNonEmpty("tenantId", tenantIdInput);
    const tenantId = bareTenantUuid(tenantIdInput);

    const conditions = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];
    if (workflowId !== undefined) { values.push(workflowId); conditions.push(`workflow_id = $${values.length}`); }
    if (workspaceId !== undefined) { values.push(workspaceId); conditions.push(`workspace_id = $${values.length}`); }
    return this.store.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        workspace_id: string;
        workflow_id: string;
        name: string;
        type: TriggerType;
        status: TriggerStatus;
        provider: string | null;
      }>(
        `SELECT id, workspace_id, workflow_id, name, type, status, provider
         FROM triggers WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
        values,
      );
      return result.rows.map((row) => ({
        id: row.id,
        tenantId: tenantIdInput,
        workspaceId: row.workspace_id,
        workflowId: row.workflow_id,
        name: row.name,
        type: row.type,
        status: row.status,
        provider: row.provider,
      }));
    });
  }
}

const VALID_TRANSITIONS: Record<TriggerStatus, readonly TriggerStatus[]> = {
  draft: ["enabled", "archived"],
  enabled: ["disabled", "archived"],
  disabled: ["enabled", "archived"],
  archived: [],
};

function assertValidStatusTransition(
  from: TriggerStatus,
  to: TriggerStatus,
): void {
  if (from === to) {
    return;
  }
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new TriggerStateTransitionError(from, to);
  }
}

function parseVersionConfig(value: unknown): TriggerVersionConfig | null {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return raw as TriggerVersionConfig;
}

function buildCronScheduleUpsert(
  tenantId: string,
  tenantIdInput: string,
  workspaceId: string,
  triggerId: string,
  triggerVersion: number,
  config: TriggerVersionConfig,
): CronScheduleUpsertRequest {
  const cronExpression = config.cronExpression;
  if (cronExpression === undefined) {
    throw new TriggerValidationError(
      "cron trigger's active version has no cronExpression to schedule",
    );
  }
  return {
    scheduleId: triggerScheduleId(tenantId, triggerId),
    cronExpression,
    workflowType: TRIGGER_DISPATCH_WORKFLOW_TYPE,
    input: {
      source: TRIGGER_CRON_FIRE_SOURCE,
      detail_type: TRIGGER_CRON_FIRE_DETAIL_TYPE,
      event_type: TRIGGER_CRON_FIRE_EVENT_TYPE,
      schema_version: TRIGGER_DISPATCH_SCHEMA_VERSION,
      tenant_id: tenantIdInput,
      workspace_id: workspaceId.startsWith("ws_")
        ? workspaceId
        : `ws_${workspaceId}`,
      trigger_id: triggerId,
      trigger_version: triggerVersion,
      payload: {},
      dlq_max_receive_count: config.dlqPolicy.maxReceiveCount,
    },
  };
}

export { defaultDlqPolicy };

/**
 * UUIDv7-forced id, matching the run/event id conventions elsewhere and
 * the prefixedUuidV7 contract the dispatch detail carries. The registry
 * mints trigger/version ids with this so every id the dispatch pipeline
 * sees is schema-valid.
 */
function mintV7Id(): string {
  const id = randomUUID();
  return `${id.slice(0, 14)}7${id.slice(15)}`;
}
