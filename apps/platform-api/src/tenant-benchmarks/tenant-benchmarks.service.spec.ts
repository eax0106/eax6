import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { tenantBenchmarksConfig } from "../config/tenant-benchmarks";
import type { ActorContextType } from "../rbac";
import { TenantBenchmarksController } from "./tenant-benchmarks.controller";
import { TenantBenchmarksService } from "./tenant-benchmarks.service";

const tenant = "ten_01930000-0000-7000-8000-000000000001";
const workspace = "ws_01930000-0000-7000-8000-000000000002";
const workflow = "wf_01930000-0000-7000-8000-000000000003";
const datasetId = "9b2c4d6e-1f3a-4b5c-8d7e-0a1b2c3d4e5f";
const runId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const at = "2026-10-05T12:00:00+00:00";

function actor(role = "editor", workspaceId = workspace): ActorContextType {
  return { user_id: "usr_member", tenant_id: tenant, workspace_id: workspace, roles: [role], permissions: [], session_id: "ses",
    workspaceRoles: [{ workspaceId, role }] };
}

const dataset = { id: datasetId, name: "Leads", description: "", caseCount: 1, createdBy: "usr_member", createdAt: at };
const detail = { ...dataset, cases: [{ id: runId, position: 0, input: { name: "Asha" }, successCriteria: ["Greets Asha"] }] };
const run = {
  id: runId, datasetId, workflowId: workflow, workflowVersionId: null, status: "completed", caseCount: 1, passed: 1, failed: 0,
  errored: 0, passRate: 1, inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.001, error: null, requestedBy: "usr_member",
  createdAt: at, startedAt: at, completedAt: at,
};
const runDetail = { ...run, results: [{ caseId: runId, position: 0, verdict: "pass", score: 0.9, threshold: 0.7, reviewerModel: "r",
  output: {}, steps: [], inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.001, durationMs: 5, error: null }] };

function setup(response: () => Response = () => Response.json({ data: [dataset] })) {
  const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => response());
  const service = new TenantBenchmarksService({ baseUrl: "http://eval.test", tokenRef: "env:INTERNAL_SERVICE_TOKEN", timeoutMs: 1000 },
    async () => "service-token", fetchImpl as unknown as typeof fetch);
  return { service, fetchImpl, controller: new TenantBenchmarksController(service) };
}

async function status(promise: Promise<unknown>): Promise<number> {
  try { await promise; return 200; } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe("TenantBenchmarksService", () => {
  it("lists the workspace's datasets from eval-service with the scope and service credential", async () => {
    const { controller, fetchImpl } = setup();
    await expect(controller.listDatasets(actor("viewer"))).resolves.toEqual({ data: [dataset] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`http://eval.test/internal/benchmarks/datasets?tenant_id=${tenant}&workspace_id=${workspace}`);
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer service-token");
  });

  it("creates a dataset for writers, translating the case shape", async () => {
    const { controller, fetchImpl } = setup(() => Response.json(detail, { status: 201 }));
    await expect(controller.createDataset({ name: " Leads ", cases: [{ input: { name: "Asha" }, successCriteria: ["Greets Asha"] }] }, actor()))
      .resolves.toEqual(detail);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://eval.test/internal/benchmarks/datasets");
    expect(JSON.parse(String(init!.body))).toEqual({ tenant_id: tenant, workspace_id: workspace, name: "Leads", description: "",
      created_by: "usr_member", cases: [{ input: { name: "Asha" }, success_criteria: ["Greets Asha"] }] });
  });

  it("starts a run for writers and reads runs and datasets for every workspace role", async () => {
    const { controller, fetchImpl } = setup(() => Response.json(runDetail, { status: 202 }));
    await expect(controller.startRun(datasetId, { workflowId: workflow }, actor("admin"))).resolves.toEqual(runDetail);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ tenant_id: tenant, workspace_id: workspace,
      workflow_id: workflow, requested_by: "usr_member" });
    await expect(controller.getRun(runId, actor("approver"))).resolves.toEqual(runDetail);
    fetchImpl.mockImplementation(async () => Response.json(detail));
    await expect(controller.getDataset(datasetId, actor("operator"))).resolves.toEqual(detail);
    fetchImpl.mockImplementation(async () => Response.json({ data: [run] }));
    await expect(controller.listRuns({ datasetId, limit: "5" }, actor("viewer"))).resolves.toEqual({ data: [run] });
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe(
      `http://eval.test/internal/benchmarks/runs?limit=5&dataset_id=${datasetId}&tenant_id=${tenant}&workspace_id=${workspace}`);
  });

  it("refuses readers writing, other workspaces and missing actors", async () => {
    const { controller, fetchImpl } = setup();
    expect(await status(controller.createDataset({ name: "x", cases: [{ input: {}, successCriteria: ["ok"] }] }, actor("viewer")))).toBe(403);
    expect(await status(controller.startRun(datasetId, { workflowId: workflow }, actor("operator")))).toBe(403);
    expect(await status(controller.listDatasets(actor("editor", "ws_01930000-0000-7000-8000-0000000000ff")))).toBe(403);
    expect(await status(controller.listDatasets(undefined))).toBe(401);
    const { workspace_id: _omitted, ...noWorkspace } = actor();
    void _omitted;
    expect(await status(controller.listDatasets(noWorkspace))).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed input before calling eval-service", async () => {
    const { controller, fetchImpl } = setup();
    for (const body of [{ name: "", cases: [{ input: {}, successCriteria: ["ok"] }] }, { name: "x", cases: [] },
      { name: "x", cases: [{ input: {}, successCriteria: [" "] }] }, { name: "x", cases: [{ input: [], successCriteria: ["ok"] }] },
      { name: "x", cases: [{ input: {}, successCriteria: ["ok"] }], extra: 1 }]) {
      expect(await status(controller.createDataset(body, actor()))).toBe(400);
    }
    expect(await status(controller.startRun(datasetId, { workflowId: "wf_bad" }, actor()))).toBe(400);
    expect(await status(controller.startRun("not-a-uuid", { workflowId: workflow }, actor()))).toBe(400);
    expect(await status(controller.getRun("../x", actor()))).toBe(400);
    expect(await status(controller.listRuns({ limit: "0" }, actor()))).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps eval-service answers to customer problems", async () => {
    for (const [answer, code] of [[404, 404], [409, 409], [422, 400], [400, 400], [500, 502]] as const) {
      const { controller } = setup(() => new Response("{}", { status: answer }));
      expect(await status(controller.getDataset(datasetId, actor()))).toBe(code);
    }
    const unreachable = setup(() => { throw new TypeError("fetch failed"); });
    expect(await status(unreachable.controller.listDatasets(actor()))).toBe(502);
    const timeout = setup(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    expect(await status(timeout.controller.listDatasets(actor()))).toBe(504);
    const noCredential = new TenantBenchmarksService({ baseUrl: "http://eval.test", tokenRef: "env:X", timeoutMs: 1000 }, async () => "", vi.fn());
    expect(await status(noCredential.listDatasets(actor()))).toBe(502);
  });

  it("reads its eval-service address from the history configuration", () => {
    expect(tenantBenchmarksConfig({ EVAL_HISTORY_BASE_URL: "http://eval.internal:8003/" })).toEqual({
      baseUrl: "http://eval.internal:8003", tokenRef: "env:INTERNAL_SERVICE_TOKEN", timeoutMs: 15_000 });
  });
});
