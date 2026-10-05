import { createHash } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { RunValidationError, WorkflowNotFoundError } from "../runs/run-launcher.service";
import { BenchmarkWorkflowNotInWorkspaceError, type BenchmarkCaseSimulator } from "./benchmark-case-simulator";
import { BenchmarkSimulationController } from "./benchmark-simulation.controller";

const token = "benchmark-service-token";
const body = {
  tenant_id: "ten_01930000-0000-7000-8000-000000000001",
  workspace_id: "ws_01930000-0000-7000-8000-000000000002",
  workflow_id: "wf_01930000-0000-7000-8000-000000000003",
  case_id: "bcs_1",
  input: { name: "Asha" },
  success_criteria: ["Greets Asha"],
};

function controller(simulateCase = vi.fn(async () => ({ verdict: "pass" }))) {
  const simulator = { simulateCase } as unknown as BenchmarkCaseSimulator;
  return { simulateCase, controller: new BenchmarkSimulationController(simulator, createHash("sha256").update(token).digest("hex")) };
}

async function status(promise: Promise<unknown>): Promise<number> {
  try { await promise; return 200; } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe("BenchmarkSimulationController", () => {
  it("passes an authenticated case to the simulator", async () => {
    const { controller: subject, simulateCase } = controller();
    await expect(subject.simulateCase(body, `Bearer ${token}`)).resolves.toEqual({ verdict: "pass" });
    expect(simulateCase).toHaveBeenCalledWith({
      tenantId: body.tenant_id, workspaceId: body.workspace_id, workflowId: body.workflow_id,
      caseId: "bcs_1", input: { name: "Asha" }, successCriteria: ["Greets Asha"],
    });
  });

  it("rejects a missing or wrong service credential before reading the body", async () => {
    const { controller: subject, simulateCase } = controller();
    expect(await status(subject.simulateCase(body, undefined))).toBe(401);
    expect(await status(subject.simulateCase(body, "Bearer wrong"))).toBe(401);
    expect(simulateCase).not.toHaveBeenCalled();
  });

  it("rejects a malformed case", async () => {
    const { controller: subject } = controller();
    for (const invalid of [
      { ...body, success_criteria: [] },
      { ...body, tenant_id: "tenant" },
      { ...body, case_id: "../x" },
      { ...body, extra: true },
      { ...body, input: [] },
    ]) {
      expect(await status(subject.simulateCase(invalid, `Bearer ${token}`))).toBe(400);
    }
  });

  it("maps missing workflows, other workspaces and unrunnable versions", async () => {
    for (const [error, code] of [
      [new WorkflowNotFoundError(body.workflow_id), 404],
      [new BenchmarkWorkflowNotInWorkspaceError(body.workflow_id), 404],
      [new RunValidationError("Workflow has no promoted version"), 409],
    ] as const) {
      const { controller: subject } = controller(vi.fn(async () => { throw error; }));
      expect(await status(subject.simulateCase(body, `Bearer ${token}`))).toBe(code);
    }
  });
});
