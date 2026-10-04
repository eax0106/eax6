import { describe, expect, it } from "vitest";

import {
  TriggerNotFoundError,
  TriggerRegistryService,
  TriggerStateTransitionError,
  TriggerValidationError,
  type OrchestrationTenantStore,
  type RegisterTriggerRequest,
} from "./trigger-registry.service";
import { InvalidCronExpressionError } from "./cron-validator";
import { InvalidDlqPolicyError } from "./dlq-policy";

interface TriggerRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  workflow_id: string;
  name: string;
  type: string;
  status: string;
  provider: string | null;
  created_at: string;
}

interface TriggerVersionRow {
  id: string;
  tenant_id: string;
  trigger_id: string;
  version: number;
  workflow_version_id: string | null;
  config: string;
  status: string;
}

interface WebhookSecretRow {
  tenant_id: string;
  trigger_id: string;
  version: number;
  secret_hash: string;
}

function createFakeStore(): {
  readonly store: OrchestrationTenantStore;
  readonly triggers: Map<string, TriggerRow>;
  readonly triggerVersions: TriggerVersionRow[];
  readonly webhookSecrets: WebhookSecretRow[];
  readonly events: readonly unknown[];
} {
  const triggers = new Map<string, TriggerRow>();
  const triggerVersions: TriggerVersionRow[] = [];
  const webhookSecrets: WebhookSecretRow[] = [];
  const events: unknown[] = [];
  let insertOrder = 0;

  const store: OrchestrationTenantStore = {
    async withTenant(_tenantId, operation) {
      return operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) {
          const sql = statement.replace(/\s+/g, " ").trim();

          if (sql.startsWith("INSERT INTO triggers")) {
            const [id, tenantId, workspaceId, workflowId, name, type, provider] =
              values as [string, string, string, string, string, string, string | null];
            // tenant_id and workspace_id are bare `uuid` columns: Postgres
            // rejects anything else, and a fake that accepted a prefixed id
            // is why registering a trigger could 500 in every real stack
            // while this suite stayed green.
            requireBareUuid("tenant_id", tenantId);
            requireBareUuid("workspace_id", workspaceId);
            insertOrder += 1;
            triggers.set(id, {
              id,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              workflow_id: workflowId,
              name,
              type,
              status: "draft",
              provider,
              created_at: String(insertOrder).padStart(10, "0"),
            });
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("INSERT INTO trigger_versions")) {
            const [id, tenantId, triggerId, version, workflowVersionId, config] =
              values as [string, string, string, number, string | null, string];
            triggerVersions.push({
              id,
              tenant_id: tenantId,
              trigger_id: triggerId,
              version,
              workflow_version_id: workflowVersionId,
              config,
              status: "active",
            });
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("SELECT type FROM triggers")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const match =
              row !== undefined && row.tenant_id === tenantId
                ? [{ type: row.type }]
                : [];
            return {
              rowCount: match.length,
              rows: match as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("SELECT type, status, workspace_id, provider, workflow_id FROM triggers")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const match =
              row !== undefined && row.tenant_id === tenantId
                ? [
                    {
                      type: row.type,
                      status: row.status,
                      workspace_id: row.workspace_id,
                    },
                  ]
                : [];
            return {
              rowCount: match.length,
              rows: match as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("SELECT t.id, t.workspace_id, t.workflow_id")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const active = triggerVersions
              .filter(
                (v) =>
                  v.tenant_id === tenantId &&
                  v.trigger_id === triggerId &&
                  v.status === "active",
              )
              .sort((a, b) => b.version - a.version)[0];
            const match =
              row !== undefined && row.tenant_id === tenantId
                ? [
                    {
                      id: row.id,
                      workspace_id: row.workspace_id,
                      workflow_id: row.workflow_id,
                      name: row.name,
                      type: row.type,
                      status: row.status,
                      provider: row.provider,
                      active_version: active?.version ?? null,
                      active_config: active?.config ?? null,
                    },
                  ]
                : [];
            return {
              rowCount: match.length,
              rows: match as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("SELECT id, workspace_id FROM triggers")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const match =
              row !== undefined && row.tenant_id === tenantId
                ? [{ id: row.id, workspace_id: row.workspace_id }]
                : [];
            return {
              rowCount: match.length,
              rows: match as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("SELECT version FROM trigger_versions")) {
            const [tenantId, triggerId] = values as [string, string];
            const versions = triggerVersions
              .filter((v) => v.tenant_id === tenantId && v.trigger_id === triggerId)
              .sort((a, b) => b.version - a.version);
            const top = versions[0];
            return {
              rowCount: top === undefined ? 0 : 1,
              rows: (top === undefined
                ? []
                : [{ version: top.version }]) as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("SELECT COALESCE(MAX(version), 0) AS version")) {
            const [tenantId, triggerId] = values as [string, string];
            const version = webhookSecrets
              .filter(
                (secret) =>
                  secret.tenant_id === tenantId && secret.trigger_id === triggerId,
              )
              .reduce((current, secret) => Math.max(current, secret.version), 0);
            return {
              rowCount: 1,
              rows: [{ version }] as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("INSERT INTO trigger_webhook_secrets")) {
            const [tenantId, triggerId, version, secretHash] = values as [
              string,
              string,
              number,
              string,
            ];
            webhookSecrets.push({
              tenant_id: tenantId,
              trigger_id: triggerId,
              version,
              secret_hash: secretHash,
            });
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("INSERT INTO events")) {
            events.push(values);
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("UPDATE trigger_versions SET status = 'superseded'")) {
            const [tenantId, triggerId] = values as [string, string];
            for (const v of triggerVersions) {
              if (
                v.tenant_id === tenantId &&
                v.trigger_id === triggerId &&
                v.status === "active"
              ) {
                v.status = "superseded";
              }
            }
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("UPDATE triggers SET status")) {
            const [status, tenantId, triggerId] = values as [string, string, string];
            const row = triggers.get(triggerId);
            if (row !== undefined && row.tenant_id === tenantId) {
              row.status = status;
            }
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (
            sql.startsWith(
              "SELECT id, workspace_id, workflow_id, name, type, status, provider FROM triggers WHERE tenant_id = $1 AND id = $2",
            )
          ) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const match =
              row !== undefined && row.tenant_id === tenantId ? [row] : [];
            return {
              rowCount: match.length,
              rows: match as unknown as readonly TRow[],
            };
          }

          if (
            sql.startsWith(
              "SELECT id, workspace_id, workflow_id, name, type, status, provider FROM triggers WHERE tenant_id = $1",
            )
          ) {
            const params = values as string[];
            const tenantId = params[0];
            const workflowId = params[1];
            const matches = [...triggers.values()]
              .filter(
                (row) =>
                  row.tenant_id === tenantId &&
                  (workflowId === undefined || row.workflow_id === workflowId),
              )
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return {
              rowCount: matches.length,
              rows: matches as unknown as readonly TRow[],
            };
          }

          throw new Error(`Unhandled fake SQL statement: ${sql}`);
        },
      });
    },
  };

  return { store, triggers, triggerVersions, webhookSecrets, events };
}

const TENANT_A = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const TENANT_B = "ten_018f47a5-7b2c-7d10-8f11-123456789abd";
const WORKSPACE_A_BARE = "018f47a5-7b2c-7d10-8f11-1234567890ab";
const WORKSPACE_A = `ws_${WORKSPACE_A_BARE}`;

function requireBareUuid(column: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}" (${column})`);
  }
}

function baseRequest(
  overrides: Partial<RegisterTriggerRequest> = {},
): RegisterTriggerRequest {
  return {
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    workflowId: "wf_a",
    name: "test trigger",
    type: "manual",
    ...overrides,
  };
}

describe("TriggerRegistryService", () => {
  it("registers a manual trigger with an active version 1", async () => {
    const { store } = createFakeStore();
    let counter = 0;
    const service = new TriggerRegistryService(store, () => `id-${(counter += 1)}`);

    const result = await service.registerTrigger(baseRequest());

    expect(result.trigger.status).toBe("draft");
    expect(result.triggerVersion.version).toBe(1);
    expect(result.triggerVersion.status).toBe("active");
    expect(result.triggerVersion.nextFireAt).toBeNull();
    expect(result.triggerVersion.config.dlqPolicy).toEqual({
      maxReceiveCount: 5,
      visibilityTimeoutSeconds: 120,
    });
  });

  // platform-api holds the ws_-prefixed id, the service's own inbound paths
  // hold the bare uuid, and the column can only hold one of them.
  it.each([
    ["the ws_ prefixed form platform-api sends", WORKSPACE_A],
    ["the bare uuid an internal caller already holds", WORKSPACE_A_BARE],
  ])("stores the workspace as a bare uuid, given %s", async (_case, workspaceId) => {
    const { store, triggers } = createFakeStore();
    const service = new TriggerRegistryService(store);

    const result = await service.registerTrigger(baseRequest({ workspaceId }));

    expect(triggers.get(result.trigger.id)?.workspace_id).toBe(WORKSPACE_A_BARE);
    expect(result.trigger.workspaceId).toBe(WORKSPACE_A_BARE);
  });

  it("refuses a workspace id that is not a uuid at all", async () => {
    const { store, triggers } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(baseRequest({ workspaceId: "ws_a" })),
    ).rejects.toThrow(TriggerValidationError);
    expect(triggers.size).toBe(0);
  });

  it("requires a cron expression for cron triggers and computes nextFireAt", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(baseRequest({ type: "cron" })),
    ).rejects.toThrow(TriggerValidationError);

    const result = await service.registerTrigger(
      baseRequest({ type: "cron", config: { cronExpression: "0 * * * *" } }),
    );
    expect(result.triggerVersion.nextFireAt).not.toBeNull();
  });

  it("rejects a malformed cron expression", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(
        baseRequest({ type: "cron", config: { cronExpression: "garbage" } }),
      ),
    ).rejects.toThrow(InvalidCronExpressionError);
  });

  it("rejects an invalid DLQ policy", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(
        baseRequest({ config: { dlqPolicy: { maxReceiveCount: -1 } } }),
      ),
    ).rejects.toThrow(InvalidDlqPolicyError);
  });

  it("rejects a malformed workflowVersionId", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(
        baseRequest({ workflowVersionId: "not-a-uuid" }),
      ),
    ).rejects.toThrow(TriggerValidationError);
  });

  it("rejects missing required fields", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger(baseRequest({ name: "" })),
    ).rejects.toThrow(TriggerValidationError);
  });

  it("rejects an unrecognized trigger type", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.registerTrigger({
        ...baseRequest(),
        type: "carrier-pigeon" as never,
      }),
    ).rejects.toThrow(TriggerValidationError);
  });

  it("creates a new trigger version and supersedes the previous active one", async () => {
    const { store, triggerVersions } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest());

    const newVersion = await service.createTriggerVersion({
      tenantId: TENANT_A,
      triggerId: registered.trigger.id,
    });

    expect(newVersion.version).toBe(2);
    expect(newVersion.status).toBe("active");
    const activeCount = triggerVersions.filter((v) => v.status === "active").length;
    expect(activeCount).toBe(1);
    const supersededCount = triggerVersions.filter(
      (v) => v.status === "superseded",
    ).length;
    expect(supersededCount).toBe(1);
  });

  it("throws TriggerNotFoundError when creating a version for a missing trigger", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.createTriggerVersion({ tenantId: TENANT_A, triggerId: "nope" }),
    ).rejects.toThrow(TriggerNotFoundError);
  });

  it("allows valid status transitions", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest());

    const enabled = await service.setTriggerStatus(
      TENANT_A,
      registered.trigger.id,
      "enabled",
    );
    expect(enabled.status).toBe("enabled");

    const disabled = await service.setTriggerStatus(
      TENANT_A,
      registered.trigger.id,
      "disabled",
    );
    expect(disabled.status).toBe("disabled");
  });

  it("rejects an invalid status transition (archived is terminal)", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest());
    await service.setTriggerStatus(TENANT_A, registered.trigger.id, "archived");

    await expect(
      service.setTriggerStatus(TENANT_A, registered.trigger.id, "enabled"),
    ).rejects.toThrow(TriggerStateTransitionError);
  });

  it("throws TriggerNotFoundError for status transitions on a missing trigger", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(
      service.setTriggerStatus(TENANT_A, "nope", "enabled"),
    ).rejects.toThrow(TriggerNotFoundError);
  });

  it("writes a real test event for active trigger version", async () => {
    const { store, events } = createFakeStore();
    const service = new TriggerRegistryService(store, () => "018f47a5-7b2c-7d10-8f11-123456789abc");
    const registered = await service.registerTrigger(baseRequest());

    const result = await service.testTrigger(TENANT_A, registered.trigger.id);

    expect(result).toEqual({
      eventId: "evt_018f47a5-7b2c-7d10-8f11-123456789abc",
      triggerId: registered.trigger.id,
      triggerVersion: 1,
    });
    expect(events).toHaveLength(1);
  });

  it("rotates webhook secrets as hashes and never stores raw secret", async () => {
    const { store, webhookSecrets } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest({ type: "webhook" }));

    const first = await service.rotateWebhookSecret(TENANT_A, registered.trigger.id);
    const second = await service.rotateWebhookSecret(TENANT_A, registered.trigger.id);

    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.secretVersion).toBe(2);
    expect(webhookSecrets).toHaveLength(2);
    expect(webhookSecrets[0]?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(webhookSecrets)).not.toContain(first.secret);
  });

  it("rejects webhook-secret rotation for non-webhook triggers", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest({ type: "manual" }));

    await expect(
      service.rotateWebhookSecret(TENANT_A, registered.trigger.id),
    ).rejects.toThrow(TriggerValidationError);
  });

  it("preserves a platform wfv_ workflow version identifier", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const workflowVersionId = "wfv_018f47a5-7b2c-7d10-8f11-123456789abc";

    const result = await service.registerTrigger(
      baseRequest({ workflowVersionId }),
    );

    expect(result.triggerVersion.workflowVersionId).toBe(workflowVersionId);
  });

  it("gets a trigger by id", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest());

    const fetched = await service.getTrigger(TENANT_A, registered.trigger.id);
    expect(fetched).toEqual(registered.trigger);
  });

  it("throws TriggerNotFoundError for an unknown trigger id", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);

    await expect(service.getTrigger(TENANT_A, "nope")).rejects.toThrow(
      TriggerNotFoundError,
    );
  });

  it("never returns another tenant's trigger even with a known id", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    const registered = await service.registerTrigger(baseRequest());

    await expect(
      service.getTrigger(TENANT_B, registered.trigger.id),
    ).rejects.toThrow(TriggerNotFoundError);
  });

  it("lists triggers scoped to a tenant, optionally filtered by workflowId", async () => {
    const { store } = createFakeStore();
    const service = new TriggerRegistryService(store);
    await service.registerTrigger(baseRequest({ workflowId: "wf_a" }));
    await service.registerTrigger(baseRequest({ workflowId: "wf_b", name: "other" }));
    await service.registerTrigger(baseRequest({ tenantId: TENANT_B }));

    const all = await service.listTriggers(TENANT_A);
    expect(all).toHaveLength(2);

    const scoped = await service.listTriggers(TENANT_A, "wf_a");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.workflowId).toBe("wf_a");
  });
});
