import { describe, expect, it } from "vitest";

import { createMockCronScheduleManager } from "@alterx/shared-clients";

import {
  TriggerRegistryService,
  type OrchestrationTenantStore,
  type RegisterTriggerRequest,
} from "./trigger-registry.service";
import { triggerScheduleId } from "./trigger-dispatch.constants";

const TENANT_INPUT = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const TENANT_BARE = "018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE_ID = "ws_018f47a5-7b2c-7d10-8f11-123456789abd";
const WORKFLOW_ID = "wf_018f47a5-7b2c-7d10-8f11-123456789abe";

interface TriggerRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  workflow_id: string;
  name: string;
  type: string;
  status: string;
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

/** Minimal scripted store handling exactly the statements the registry's
 *  INGR-7 schedule paths issue. */
function createStore(): {
  readonly store: OrchestrationTenantStore;
  readonly triggers: Map<string, TriggerRow>;
  readonly versions: TriggerVersionRow[];
  readonly statusUpdates: string[];
} {
  const triggers = new Map<string, TriggerRow>();
  const versions: TriggerVersionRow[] = [];
  const statusUpdates: string[] = [];

  const store: OrchestrationTenantStore = {
    async withTenant(_tenantId, operation) {
      return operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) {
          const sql = statement.replace(/\s+/g, " ").trim();

          if (sql.startsWith("INSERT INTO triggers")) {
            const [id, tenantId, workspaceId, workflowId, name, type] =
              values as [string, string, string, string, string, string];
            triggers.set(id, {
              id,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              workflow_id: workflowId,
              name,
              type,
              status: "draft",
            });
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("SELECT type, status, workspace_id, provider, workflow_id FROM triggers")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            return {
              rowCount: row === undefined ? 0 : 1,
              rows:
                row === undefined || row.tenant_id !== tenantId
                  ? []
                  : ([
                      {
                        type: row.type,
                        status: row.status,
                        workspace_id: row.workspace_id,
                      },
                    ] as unknown as readonly TRow[]),
            };
          }

          if (sql.startsWith("INSERT INTO trigger_versions")) {
            const [id, tenantId, triggerId, version, workflowVersionId, config] =
              values as [string, string, string, number, string | null, string];
            versions.push({
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

          if (sql.startsWith("SELECT version FROM trigger_versions")) {
            const [tenantId, triggerId] = values as [string, string];
            const top = versions
              .filter(
                (v) => v.tenant_id === tenantId && v.trigger_id === triggerId,
              )
              .sort((a, b) => b.version - a.version)[0];
            return {
              rowCount: top === undefined ? 0 : 1,
              rows: (top === undefined
                ? []
                : [{ version: top.version }]) as unknown as readonly TRow[],
            };
          }

          if (sql.startsWith("UPDATE trigger_versions SET status = 'superseded'")) {
            const [tenantId, triggerId] = values as [string, string];
            for (const v of versions) {
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

          if (sql.startsWith("SELECT t.id, t.workspace_id, t.workflow_id")) {
            const [tenantId, triggerId] = values as [string, string];
            const row = triggers.get(triggerId);
            const active = versions
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
                      provider: null,
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

          if (sql.startsWith("UPDATE triggers SET status")) {
            const [status, tenantId, triggerId] = values as [string, string, string];
            const row = triggers.get(triggerId);
            if (row !== undefined && row.tenant_id === tenantId) {
              row.status = status;
              statusUpdates.push(status);
            }
            return { rowCount: 1, rows: [] as unknown as readonly TRow[] };
          }

          throw new Error(`Unhandled fake SQL statement: ${sql}`);
        },
      });
    },
  };

  return { store, triggers, versions, statusUpdates };
}

function baseRequest(
  overrides: Partial<RegisterTriggerRequest> = {},
): RegisterTriggerRequest {
  return {
    tenantId: TENANT_INPUT,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    name: "cron trigger",
    type: "cron",
    config: { cronExpression: "0 9 * * *" },
    ...overrides,
  };
}

describe("TriggerRegistryService schedule lifecycle (INGR-7)", () => {
  it("upserts a Temporal schedule when an enabled cron trigger's version is created", async () => {
    const { store, triggers } = createStore();
    const schedules = createMockCronScheduleManager();
    const service = new TriggerRegistryService(store, () => "00000000-0000-7000-8000-000000000000", schedules);

    await service.registerTrigger(baseRequest());
    const triggerId = [...triggers.keys()][0]!;
    await service.setTriggerStatus(TENANT_INPUT, triggerId, "enabled");
    await service.createTriggerVersion({
      tenantId: TENANT_INPUT,
      triggerId,
      workflowVersionId: "wfv_018f47a5-7b2c-7d10-8f11-123456789abf",
      config: { cronExpression: "30 9 * * *" },
    });

    const upserts = schedules.listSchedules();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.scheduleId).toBe(triggerScheduleId(TENANT_BARE, triggerId));
    expect(upserts[0]!.cronExpression).toBe("30 9 * * *");
    expect(upserts[0]!.workflowType).toBe("triggerDispatchWorkflow");
    expect(upserts[0]!.input).toMatchObject({
      tenant_id: TENANT_INPUT,
      workspace_id: WORKSPACE_ID,
      trigger_id: triggerId,
      trigger_version: 2,
      dlq_max_receive_count: 5,
    });
  });

  it("upserts a schedule on enable and deletes it on disable", async () => {
    const { store, triggers } = createStore();
    const schedules = createMockCronScheduleManager();
    const service = new TriggerRegistryService(store, () => "00000000-0000-7000-8000-000000000000", schedules);

    await service.registerTrigger(baseRequest());
    const triggerId = [...triggers.keys()][0]!;

    await service.setTriggerStatus(TENANT_INPUT, triggerId, "enabled");
    expect(schedules.listSchedules()).toHaveLength(1);

    await service.setTriggerStatus(TENANT_INPUT, triggerId, "disabled");
    expect(schedules.listSchedules()).toHaveLength(0);
    expect(schedules.deletedScheduleIds()).toEqual([
      triggerScheduleId(TENANT_BARE, triggerId),
    ]);
  });

  it("deletes the schedule when a cron trigger is archived", async () => {
    const { store, triggers } = createStore();
    const schedules = createMockCronScheduleManager();
    const service = new TriggerRegistryService(store, () => "00000000-0000-7000-8000-000000000000", schedules);

    await service.registerTrigger(baseRequest());
    const triggerId = [...triggers.keys()][0]!;
    await service.setTriggerStatus(TENANT_INPUT, triggerId, "enabled");
    await service.setTriggerStatus(TENANT_INPUT, triggerId, "archived");

    expect(schedules.deletedScheduleIds()).toEqual([
      triggerScheduleId(TENANT_BARE, triggerId),
    ]);
  });

  it("never touches schedules for non-cron triggers", async () => {
    const { store, triggers } = createStore();
    const schedules = createMockCronScheduleManager();
    const service = new TriggerRegistryService(store, () => "00000000-0000-7000-8000-000000000000", schedules);

    await service.registerTrigger(baseRequest({ type: "webhook" }));
    const triggerId = [...triggers.keys()][0]!;
    await service.setTriggerStatus(TENANT_INPUT, triggerId, "enabled");
    await service.setTriggerStatus(TENANT_INPUT, triggerId, "disabled");

    expect(schedules.listSchedules()).toHaveLength(0);
    expect(schedules.deletedScheduleIds()).toHaveLength(0);
  });

  it("does not schedule a draft cron trigger until it is enabled", async () => {
    const { store, triggers } = createStore();
    const schedules = createMockCronScheduleManager();
    const service = new TriggerRegistryService(store, () => "00000000-0000-7000-8000-000000000000", schedules);

    await service.registerTrigger(baseRequest());
    const triggerId = [...triggers.keys()][0]!;
    await service.createTriggerVersion({
      tenantId: TENANT_INPUT,
      triggerId,
      workflowVersionId: "wfv_018f47a5-7b2c-7d10-8f11-123456789abf",
      config: { cronExpression: "0 9 * * *" },
    });

    expect(schedules.listSchedules()).toHaveLength(0);
  });

  it("propagates a schedule failure instead of swallowing it", async () => {
    const { store, triggers, statusUpdates } = createStore();
    const failing = {
      upsertCronSchedule: async (): Promise<void> => {
        throw new Error("temporal unavailable");
      },
      deleteCronSchedule: async (): Promise<void> => {},
    } satisfies {
      upsertCronSchedule: (request: unknown) => Promise<void>;
      deleteCronSchedule: (scheduleId: string) => Promise<void>;
    };
    const service = new TriggerRegistryService(
      store,
      () => "00000000-0000-7000-8000-000000000000",
      failing as never,
    );

    await service.registerTrigger(baseRequest());
    const triggerId = [...triggers.keys()][0]!;
    await expect(
      service.setTriggerStatus(TENANT_INPUT, triggerId, "enabled"),
    ).rejects.toThrow("temporal unavailable");

    // The DB transition committed before the schedule side effect ran.
    expect(statusUpdates).toEqual(["enabled"]);
  });
});
