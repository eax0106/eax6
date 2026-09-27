import { describe, expect, it } from "vitest";

import {
  WorkflowNotFoundError,
  WorkflowReadService,
  WorkflowValidationError,
  type OrchestrationTenantStore,
} from "./workflow-read.service";

interface WorkflowRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowVersionRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  version: number;
  status: string;
  dag_schema_version: string;
  traffic_percent: number | null;
  evaluation_run_id: string | null;
  tested_at: string | null;
  evaluation_failed_at: string | null;
  created_at: string;
}

function createFakeStore(
  seed: readonly WorkflowRow[] = [],
  versionSeed: readonly WorkflowVersionRow[] = [],
): {
  readonly store: OrchestrationTenantStore;
  readonly workflows: Map<string, WorkflowRow>;
} {
  const workflows = new Map<string, WorkflowRow>(seed.map((row) => [row.id, row]));
  const versions = [...versionSeed];

  const store: OrchestrationTenantStore = {
    async withTenant(_tenantId, operation) {
      return operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ) {
          const sql = statement.replace(/\s+/g, " ").trim();

          if (sql.includes("FROM workflow_versions")) {
            const [queryTenantId, workflowId, cursor, rawLimit] = values as [
              string,
              string,
              number | null,
              number,
            ];
            const rows = versions
              .filter(
                (row) =>
                  row.tenant_id === queryTenantId &&
                  row.workflow_id === workflowId &&
                  (cursor === null || row.version < cursor),
              )
              .sort((left, right) => right.version - left.version)
              .slice(0, rawLimit);
            return { rowCount: rows.length, rows: rows as unknown as readonly TRow[] };
          }

          if (sql.includes("FROM workflows WHERE tenant_id = $1 AND workspace_id = $2")) {
            const [queryTenantId, workspaceId, cursor, rawLimit] = values as [string, string, string | null, number];
            const rows = [...workflows.values()]
              .filter((row) => row.tenant_id === queryTenantId && row.workspace_id === workspaceId && (cursor === null || row.id > cursor))
              .sort((left, right) => left.id.localeCompare(right.id))
              .slice(0, rawLimit);
            return { rowCount: rows.length, rows: rows as unknown as readonly TRow[] };
          }

          if (sql.startsWith("SELECT")) {
            const [queryTenantId, workflowId] = values as [string, string];
            const row = workflows.get(workflowId);
            if (row === undefined || row.tenant_id !== queryTenantId) {
              return { rowCount: 0, rows: [] as unknown as readonly TRow[] };
            }
            return { rowCount: 1, rows: [row] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("INSERT")) {
            const [workflowId, tenantId, workspaceId, name] = values as [
              string,
              string,
              string,
              string,
            ];
            const row: WorkflowRow = {
              id: workflowId,
              tenant_id: tenantId,
              workspace_id: workspaceId,
              name,
              status: "draft",
              created_at: "created",
              updated_at: "created",
            };
            workflows.set(workflowId, row);
            return { rowCount: 1, rows: [row] as unknown as readonly TRow[] };
          }

          if (sql.startsWith("UPDATE")) {
            const [queryTenantId, workflowId, name, status] = values as [
              string,
              string,
              string | null,
              string | null,
            ];
            const row = workflows.get(workflowId);
            if (row === undefined || row.tenant_id !== queryTenantId) {
              return { rowCount: 0, rows: [] as unknown as readonly TRow[] };
            }
            const updated: WorkflowRow = {
              ...row,
              name: name ?? row.name,
              status: status ?? row.status,
              updated_at: "updated",
            };
            workflows.set(workflowId, updated);
            return { rowCount: 1, rows: [updated] as unknown as readonly TRow[] };
          }

          throw new Error(`Unexpected query in fake store: ${sql}`);
        },
      });
    },
  };

  return { store, workflows };
}

const TENANT_A_BARE = "018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const TENANT_A = `ten_${TENANT_A_BARE}`;
const TENANT_B = "ten_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_A = "ws_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaac";
const WORKFLOW_A = "wf_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaab";

function seedRow(): WorkflowRow {
  return {
    id: WORKFLOW_A,
    tenant_id: TENANT_A_BARE,
    workspace_id: "018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaac",
    name: "Original Name",
    status: "draft",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("WorkflowReadService", () => {
  it("lists only calling workspace with bounded cursor pagination", async () => {
    const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
    const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
    const first = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
    const second = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
    const { store } = createFakeStore([
      { id: first, tenant_id: tenant, workspace_id: workspace, name: "one", status: "active", created_at: "created", updated_at: "updated" },
      { id: second, tenant_id: tenant, workspace_id: workspace, name: "two", status: "draft", created_at: "created", updated_at: "updated" },
      { id: "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a3", tenant_id: tenant, workspace_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac", name: "other", status: "draft", created_at: "created", updated_at: "updated" },
    ]);
    const service = new WorkflowReadService(store);
    await expect(service.listWorkflows(`ten_${tenant}`, `ws_${workspace}`, undefined, 1)).resolves.toMatchObject({
      data: [{ id: first }],
      page: { has_more: true, next_cursor: first, limit: 1 },
    });
    await expect(service.listWorkflows(`ten_${tenant}`, `ws_${workspace}`, first, 10)).resolves.toMatchObject({
      data: [{ id: second }],
      page: { has_more: false, next_cursor: null },
    });
  });

  it("creates a real draft workflow in the authenticated tenant and workspace", async () => {
    const { store, workflows } = createFakeStore();
    const service = new WorkflowReadService(store);

    const workflow = await service.createWorkflow({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      name: "Discovery follow-up",
    });

    expect(workflow.id).toMatch(/^wf_[0-9a-f-]{36}$/);
    expect(workflow.status).toBe("draft");
    expect(workflow.tenantId).toBe(TENANT_A_BARE);
    expect(workflow.workspaceId).toBe(WORKSPACE_A.slice("ws_".length));
    expect(workflows.get(workflow.id)).toMatchObject({ status: "draft", name: "Discovery follow-up" });
  });

  it("rejects a workspace outside the authenticated ID contract", async () => {
    const { store } = createFakeStore();
    const service = new WorkflowReadService(store);

    await expect(
      service.createWorkflow({ tenantId: TENANT_A, workspaceId: "bad", name: "Nope" }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("returns the real workflow row for its own tenant", async () => {
    const { store } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    const workflow = await service.getWorkflow(TENANT_A, WORKFLOW_A);

    expect(workflow.id).toBe(WORKFLOW_A);
    expect(workflow.name).toBe("Original Name");
  });

  it("real cross-tenant read is not_found, never leaks the other tenant's row", async () => {
    const { store } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    await expect(service.getWorkflow(TENANT_B, WORKFLOW_A)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it("updates name and status for its own tenant", async () => {
    const { store } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    const updated = await service.updateWorkflow({
      tenantId: TENANT_A,
      workflowId: WORKFLOW_A,
      name: "Renamed",
      status: "active",
    });

    expect(updated.name).toBe("Renamed");
    expect(updated.status).toBe("active");
  });

  it("real cross-tenant update is not_found, never mutates the other tenant's row", async () => {
    const { store, workflows } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    await expect(
      service.updateWorkflow({ tenantId: TENANT_B, workflowId: WORKFLOW_A, name: "Hijacked" }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(workflows.get(WORKFLOW_A)?.name).toBe("Original Name");
  });

  it("rejects an invalid status", async () => {
    const { store } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    await expect(
      service.updateWorkflow({
        tenantId: TENANT_A,
        workflowId: WORKFLOW_A,
        status: "bogus" as never,
      }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("rejects an empty tenantId", async () => {
    const { store } = createFakeStore([seedRow()]);
    const service = new WorkflowReadService(store);

    await expect(service.getWorkflow("", WORKFLOW_A)).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
  });
});

// C8: the Deployment Manager reads a workflow's version history from here.
// platform-api has proxied GET /api/v1/workflows/:id/versions to this
// service since it was written, and the route never existed.
describe("WorkflowReadService.listVersions", () => {
  const TENANT_B_BARE = "018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

  function version(
    number: number,
    overrides: Partial<WorkflowVersionRow> = {},
  ): WorkflowVersionRow {
    return {
      id: `wfv_018f4d6e-aaaa-7aaa-8aaa-00000000000${number}`,
      tenant_id: TENANT_A_BARE,
      workflow_id: WORKFLOW_A,
      version: number,
      status: "compiled",
      dag_schema_version: "v1",
      traffic_percent: null,
      evaluation_run_id: null,
      tested_at: null,
      evaluation_failed_at: null,
      created_at: `2026-09-0${number}T00:00:00.000Z`,
      ...overrides,
    };
  }

  it("returns a workflow's versions newest first, the order a history reads in", async () => {
    const { store } = createFakeStore(
      [],
      [version(1), version(3, { status: "promoted" }), version(2)],
    );
    const service = new WorkflowReadService(store);

    const page = await service.listVersions(TENANT_A, WORKFLOW_A, undefined, 50);

    expect(page.data.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(page.data[0]).toMatchObject({ status: "promoted", dagSchemaVersion: "v1" });
    expect(page.page).toEqual({ next_cursor: null, has_more: false, limit: 50 });
  });

  it("carries the fields a deployment screen reads, and not the compiled DAG", async () => {
    const { store } = createFakeStore(
      [],
      [
        version(1, {
          status: "canary",
          traffic_percent: 10,
          evaluation_run_id: "run_018f4d6e-aaaa-7aaa-8aaa-00000000000e",
          tested_at: "2026-09-01T01:00:00.000Z",
        }),
      ],
    );
    const service = new WorkflowReadService(store);

    const page = await service.listVersions(TENANT_A, WORKFLOW_A, undefined, 50);

    expect(page.data[0]).toEqual({
      id: "wfv_018f4d6e-aaaa-7aaa-8aaa-000000000001",
      workflowId: WORKFLOW_A,
      version: 1,
      status: "canary",
      dagSchemaVersion: "v1",
      trafficPercent: 10,
      evaluationRunId: "run_018f4d6e-aaaa-7aaa-8aaa-00000000000e",
      testedAt: "2026-09-01T01:00:00.000Z",
      evaluationFailedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("pages on the version number it last returned", async () => {
    const { store } = createFakeStore([], [version(1), version(2), version(3)]);
    const service = new WorkflowReadService(store);

    const first = await service.listVersions(TENANT_A, WORKFLOW_A, undefined, 2);
    expect(first.data.map((item) => item.version)).toEqual([3, 2]);
    expect(first.page).toMatchObject({ next_cursor: "2", has_more: true });

    const second = await service.listVersions(
      TENANT_A,
      WORKFLOW_A,
      first.page.next_cursor ?? undefined,
      2,
    );
    expect(second.data.map((item) => item.version)).toEqual([1]);
    expect(second.page.has_more).toBe(false);
  });

  it("never returns another tenant's versions", async () => {
    const { store } = createFakeStore(
      [],
      [version(1, { tenant_id: TENANT_B_BARE }), version(2)],
    );
    const service = new WorkflowReadService(store);

    const page = await service.listVersions(TENANT_A, WORKFLOW_A, undefined, 50);

    expect(page.data.map((item) => item.version)).toEqual([2]);
  });

  it("never returns another workflow's versions", async () => {
    const { store } = createFakeStore(
      [],
      [version(1, { workflow_id: "wf_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaad" }), version(2)],
    );
    const service = new WorkflowReadService(store);

    const page = await service.listVersions(TENANT_A, WORKFLOW_A, undefined, 50);

    expect(page.data.map((item) => item.version)).toEqual([2]);
  });

  it.each([0, 201, 1.5])("refuses limit %s", async (limit) => {
    const { store } = createFakeStore([], [version(1)]);
    const service = new WorkflowReadService(store);

    await expect(
      service.listVersions(TENANT_A, WORKFLOW_A, undefined, limit),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("refuses a cursor that is not a version number", async () => {
    const { store } = createFakeStore([], [version(1)]);
    const service = new WorkflowReadService(store);

    await expect(
      service.listVersions(TENANT_A, WORKFLOW_A, "wfv_something", 50),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });
});
