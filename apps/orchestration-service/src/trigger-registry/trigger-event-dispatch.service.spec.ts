import { describe, expect, it, vi } from "vitest";

import type { RunsCreateRunRequest } from "@alterx/contracts";

import type { OrchestrationTenantStore } from "../runs/run-launcher.service";
import {
  RunLauncherService,
  type RunRow,
} from "../runs/run-launcher.service";
import {
  TriggerEventDispatchService,
  TriggerEventValidationError,
} from "./trigger-event-dispatch.service";

interface DispatchLookupRow {
  readonly workspace_id: string;
  readonly status: string;
  readonly workflow_id: string;
  readonly active_version: number | null;
  readonly wfv_id: string | null;
  readonly compiled_dag: unknown;
}

interface RecordedRow {
  readonly event: Record<string, unknown>;
  readonly run: Record<string, unknown>;
}

/** Scripted in-memory orchestration store: drives a scripted lookup then
 *  records the INSERT statements, and exposes transaction call counts. */
class ScriptedStore implements OrchestrationTenantStore {
  lookups: DispatchLookupRow[] = [];
  reads = 0;
  txs = 0;
  rows: RecordedRow[] = [];
  eventsRowCount = 1;

  async withTenant<T>(
    _tenantId: string,
    operation: (tx: {
      query<TRow extends Record<string, unknown>>(
        statement: string,
        values?: readonly unknown[],
      ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    this.txs += 1;
    return operation({
      query: async <TRow extends Record<string, unknown>>(
        statement: string,
        values?: readonly unknown[],
      ) => {
        if (statement.trimStart().startsWith("SELECT")) {
          const row = this.lookups[this.reads];
          this.reads += 1;
          return {
            rowCount: row === undefined ? 0 : 1,
            rows: (row === undefined
              ? []
              : [row]) as unknown as readonly TRow[],
          };
        }
        const run = values?.at(0);
        const event = values?.at(1);
        if (statement.includes("INSERT INTO runs")) {
          this.rows.push({ event: {}, run: { run: run, values } });
          return {
            rowCount: 1,
            rows: [
              { id: run, ...Object.fromEntries(
                Object.entries(rowToRunRow()).map(([k, v]) => [k, v]),
              ) },
            ] as unknown as readonly TRow[],
          };
        }
        if (statement.includes("INSERT INTO events")) {
          this.rows.push({ event: { values }, run: {} });
          return {
            rowCount: this.eventsRowCount,
            rows: (this.eventsRowCount === 1
              ? [{ event_id: event }]
              : []) as unknown as readonly TRow[],
          };
        }
        throw new Error(`unexpected statement: ${statement}`);
      },
    });
  }
}

function rowToRunRow(): RunRow {
  return {
    id: "run_stub",
    tenant_id: "ten_stub",
    workspace_id: "ws_stub",
    workflow_id: "wf_stub",
    workflow_version_id: "wfv_stub",
    project_id: null,
    provisioning_session_id: null,
    provisioning_cycle_id: null,
    provisioning_template_id: null,
    provisioning_closed_at: null,
    parent_kind: "workflow",
    status: "pending",
    started_at: null,
    ended_at: null,
    created_at: "2026-08-15T00:00:00.000Z",
    triggering_event_id: null,
  };
}

function request(overrides: Partial<RunsCreateRunRequest> = {}): RunsCreateRunRequest {
  return {
    tenant_id: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
    workspace_id: "ws_018f47a5-7b2c-7d10-8f11-123456789abd",
    trigger_id: "trg_018f47a5-7b2c-7d10-8f11-123456789abe",
    trigger_version: 1,
    event_type: "trigger.delivered",
    schema_version: "v1",
    source: "alter.trigger.delivered",
    idempotency_key: "sha256-abc",
    payload_json: '{"hello":"world"}',
    ...overrides,
  };
}

describe("TriggerEventDispatchService", () => {
  function setup(lookup: DispatchLookupRow | undefined) {
    const store = new ScriptedStore();
    store.lookups.push(
      lookup ?? {
        workspace_id: "018f47a5-7b2c-7d10-8f11-123456789abd",
        status: "enabled",
        workflow_id: "wf_4dd940f7-08c2-458c-a0f2-8cf50c5cb1d1",
        active_version: 1,
        wfv_id: "wfv_5ee940f7-08c2-458c-a0f2-8cf50c5cb1d1",
        compiled_dag: { schema_version: "v1", entry_node_keys: ["node_a"], nodes: [{ key: "node_a", type: "ToolCall", config: {}, metadata: { ui: {} } }], edges: [], waves: [{ key: "wave_0", order: 0, node_keys: ["node_a"], depends_on: [] }] },
      },
    );
    const launcher = {
      startAndTransition: vi.fn(async () => rowToRunRow()),
    } as unknown as RunLauncherService;
    const service = new TriggerEventDispatchService(store, launcher);
    return { store, launcher, service };
  }

  it("inserts the events row then the runs row in one transaction", async () => {
    const { store, launcher, service } = setup(undefined);
    const response = await service.createRun(request());

    expect(response).toEqual({ run_id: expect.stringMatching(/^run_/), event_inserted: true });
    expect(store.txs).toBe(1);
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]!.run).toEqual({});
    expect(store.rows[1]!.event).toEqual({});
    expect(launcher.startAndTransition).toHaveBeenCalledTimes(1);
  });

  it("returns a terminal no-op for a missing trigger without inserting rows", async () => {
    const { store, launcher, service } = setup(undefined);
    store.lookups = [];
    const response = await service.createRun(request());
    expect(response).toEqual({ run_id: "", event_inserted: false });
    expect(store.rows).toHaveLength(0);
    expect(launcher.startAndTransition).not.toHaveBeenCalled();
  });

  it("returns a terminal no-op for a disabled trigger", async () => {
    const { store, launcher, service } = setup(undefined);
    store.lookups[0] = { ...store.lookups[0]!, status: "disabled" };
    const response = await service.createRun(request());
    expect(response).toEqual({ run_id: "", event_inserted: false });
    expect(store.rows).toHaveLength(0);
    expect(launcher.startAndTransition).not.toHaveBeenCalled();
  });

  it("returns a terminal no-op for a workspace pending deletion (D2 hold) without inserting rows", async () => {
    const { store, launcher, service } = setup(undefined);
    store.lookups[1] = { held: true } as unknown as DispatchLookupRow;
    const response = await service.createRun(request());
    expect(response).toEqual({ run_id: "", event_inserted: false });
    expect(store.rows).toHaveLength(0);
    expect(launcher.startAndTransition).not.toHaveBeenCalled();
  });

  it("returns a terminal no-op when the active version is unbound", async () => {
    const { store, service } = setup(undefined);
    store.lookups[0] = { ...store.lookups[0]!, wfv_id: null };
    const response = await service.createRun(request());
    expect(response).toEqual({ run_id: "", event_inserted: false });
    expect(store.rows).toHaveLength(0);
  });

  it("returns a terminal no-op for a duplicate idempotency key", async () => {
    const store = new ScriptedStore();
    store.eventsRowCount = 0;
    store.lookups.push({
      workspace_id: "018f47a5-7b2c-7d10-8f11-123456789abd",
      status: "enabled",
      workflow_id: "wf_4dd940f7-08c2-458c-a0f2-8cf50c5cb1d1",
      active_version: 1,
      wfv_id: "wfv_5ee940f7-08c2-458c-a0f2-8cf50c5cb1d1",
      compiled_dag: { schema_version: "v1", entry_node_keys: ["node_a"], nodes: [{ key: "node_a", type: "ToolCall", config: {}, metadata: { ui: {} } }], edges: [], waves: [{ key: "wave_0", order: 0, node_keys: ["node_a"], depends_on: [] }] },
    });
    const launcher = {
      startAndTransition: vi.fn(async () => rowToRunRow()),
    } as unknown as RunLauncherService;
    const service = new TriggerEventDispatchService(store, launcher);
    const response = await service.createRun(request());
    expect(response).toEqual({ run_id: "", event_inserted: false });
    expect(store.rows).toHaveLength(1);
    expect(launcher.startAndTransition).not.toHaveBeenCalled();
  });

  it("rejects a trigger from another workspace", async () => {
    const { service } = setup(undefined);
    await expect(
      service.createRun(request({ workspace_id: "ws_00000000-0000-0000-0000-000000000000" })),
    ).rejects.toThrow(TriggerEventValidationError);
  });

  it("rejects a malformed payload", async () => {
    const { service } = setup(undefined);
    await expect(
      service.createRun(request({ payload_json: "not json" })),
    ).rejects.toThrow(TriggerEventValidationError);
  });

  // proto3 cannot distinguish an unset string field from an empty one, and
  // the gRPC loader delivers an omitted field as undefined rather than "".
  // Omitting one raised a TypeError inside the validator, which the transport
  // reported as INTERNAL with the message "Run workspace lookup could not be
  // completed" -- naming a lookup that had not yet run, on the engine's main
  // run-dispatch entry point.
  it.each(["event_type", "schema_version", "source", "idempotency_key"])(
    "rejects an omitted %s as validation, not as a TypeError",
    async (field) => {
      const { service } = setup(undefined);
      const payload = request() as unknown as Record<string, unknown>;
      delete payload[field];

      await expect(
        service.createRun(payload as unknown as RunsCreateRunRequest),
      ).rejects.toThrow(new TriggerEventValidationError(`${field} is required`));
    },
  );

  it("validates the carried trigger_version", async () => {
    const { service } = setup(undefined);
    await expect(
      service.createRun(request({ trigger_version: 0 })),
    ).rejects.toThrow(TriggerEventValidationError);
  });
});
