import { describe, expect, it, vi } from "vitest";

import { RunNotFoundError, RunValidationError, type OrchestrationTenantStore } from "./run-launcher.service";
import { NodeExecutionNotFoundError, RunWorkspaceLookupService } from "./run-workspace-lookup.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-abcdefabcdef";

function fakeRecoveryStore(
  attempt: number | undefined,
  hasRecoveryAction: boolean,
): { store: OrchestrationTenantStore; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("FROM conversation_messages")) return { rowCount: 0, rows: [] };
    if (statement.includes("FROM node_executions")) {
      return {
        rowCount: attempt === undefined ? 0 : 1,
        rows: attempt === undefined ? [] : [{ attempt }],
      };
    }
    return { rowCount: 1, rows: [{ exists: hasRecoveryAction }] };
  });
  return {
    query,
    store: {
      withTenant: async (tenantId, operation) => {
        expect(tenantId).toBe(BARE_TENANT);
        return operation({ query } as unknown as Parameters<typeof operation>[0]);
      },
    },
  };
}

function fakeStore(workspaceId: string | undefined): {
  store: OrchestrationTenantStore;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({
    rowCount: workspaceId === undefined ? 0 : 1,
    rows:
      workspaceId === undefined
        ? []
        : [{ workspace_id: workspaceId, workflow_id: WORKFLOW }],
  }));
  return {
    query,
    store: {
      withTenant: async (tenantId, operation) => {
        expect(tenantId).toBe(BARE_TENANT);
        return operation({ query } as unknown as Parameters<typeof operation>[0]);
      },
    },
  };
}

describe("RunWorkspaceLookupService", () => {
  it("resolves the real workspace_id for a run this tenant owns", async () => {
    const { store, query } = fakeStore(WORKSPACE);
    const service = new RunWorkspaceLookupService(store);

    await expect(service.getWorkspaceId(TENANT, RUN)).resolves.toBe(WORKSPACE);
    expect(query).toHaveBeenCalledWith(
      "SELECT workspace_id, workflow_id FROM runs WHERE tenant_id = $1 AND id = $2",
      [BARE_TENANT, RUN],
    );
  });

  it("returns the existing run workflow_id with its workspace", async () => {
    const { store } = fakeStore(WORKSPACE);
    const service = new RunWorkspaceLookupService(store);

    await expect(service.getRunWorkspace(TENANT, RUN)).resolves.toEqual({
      workspaceId: WORKSPACE,
      workflowId: WORKFLOW,
    });
  });
  it("uses the required prefixed workspace identity at the actual transport binding", async () => {
    const { store } = fakeStore(WORKSPACE);
    expect(await new RunWorkspaceLookupService(store).getRunWorkspaceResponse(TENANT, RUN)).toEqual({ workspace_id: `ws_${WORKSPACE}`, workflow_id: WORKFLOW });
  });

  it("raises RunNotFoundError for a run this tenant cannot see", async () => {
    const { store } = fakeStore(undefined);
    const service = new RunWorkspaceLookupService(store);

    await expect(service.getWorkspaceId(TENANT, RUN)).rejects.toThrow(RunNotFoundError);
  });

  it("rejects a malformed tenant_id before touching the store", async () => {
    const { store, query } = fakeStore(WORKSPACE);
    const service = new RunWorkspaceLookupService(store);

    await expect(service.getWorkspaceId("not-a-tenant", RUN)).rejects.toThrow(
      RunValidationError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a malformed run_id before touching the store", async () => {
    const { store, query } = fakeStore(WORKSPACE);
    const service = new RunWorkspaceLookupService(store);

    await expect(service.getWorkspaceId(TENANT, "not-a-run")).rejects.toThrow(
      RunValidationError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  describe("getRecoveryInfo", () => {
    it("is_retry=false, is_recovery=false for a real first-attempt node with no recovery row", async () => {
      const { store } = fakeRecoveryStore(1, false);
      const service = new RunWorkspaceLookupService(store);

      await expect(service.getRecoveryInfo(TENANT, RUN, NODE_EXECUTION)).resolves.toEqual({
        isRetry: false,
        isRecovery: false,
      });
    });

    it("is_retry=true for a real re-attempt (attempt > 1)", async () => {
      const { store } = fakeRecoveryStore(2, false);
      const service = new RunWorkspaceLookupService(store);

      await expect(service.getRecoveryInfo(TENANT, RUN, NODE_EXECUTION)).resolves.toEqual({
        isRetry: true,
        isRecovery: false,
      });
    });

    it("is_recovery=true when a real recovery_actions row exists for this node execution", async () => {
      const { store } = fakeRecoveryStore(1, true);
      const service = new RunWorkspaceLookupService(store);

      await expect(service.getRecoveryInfo(TENANT, RUN, NODE_EXECUTION)).resolves.toEqual({
        isRetry: false,
        isRecovery: true,
      });
    });

    it("raises NodeExecutionNotFoundError for a node execution this tenant cannot see", async () => {
      const { store } = fakeRecoveryStore(undefined, false);
      const service = new RunWorkspaceLookupService(store);

      await expect(service.getRecoveryInfo(TENANT, RUN, NODE_EXECUTION)).rejects.toThrow(
        NodeExecutionNotFoundError,
      );
    });

    it("rejects a malformed node_execution_id before touching the store", async () => {
      const { store, query } = fakeRecoveryStore(1, false);
      const service = new RunWorkspaceLookupService(store);

      await expect(
        service.getRecoveryInfo(TENANT, RUN, "not-a-node-execution"),
      ).rejects.toThrow(RunValidationError);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
