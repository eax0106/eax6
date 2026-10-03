import { PlannerClient, type PlannerHttpClient } from "@alterx/adapters";
import { expect, it, vi } from "vitest";
import { PlannerFacadeService } from "./planner-facade.service";
import { CompilerServiceClient } from "./compiler-client";
import type { WorkflowSafeguardsService } from "./workflow-safeguards.service";
import type { TenantResidencyRepository } from "./tenant-residency.repository";

const input = { tenantId: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab", workspaceId: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ab", workflowId: "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890ab", objective: "Triage support mail" };
function fixture(assigned?: string[]) {
  const decompose = vi.fn();
  const prepare = vi.fn();
  const compile = vi.fn((_request, _options, callback) => callback(null, { workflow_version_id: "wfv_018f4d6e-2b4a-7a3e-8c1a-1234567890ab", compiled_dag_json: "{}", node_requirements_json: "{}", policy_bindings_json: "{}" }));
  const http: PlannerHttpClient = { postJson: async (url, body) => {
    if (url.endsWith("/understand")) return { objective: input.objective, current_situation: null, actors: [], systems_involved: [], constraints: [], required_data: [], risk: "low", missing_information: [], success_criteria: ["Inferred old goal."], context_references: [] };
    if (url.endsWith("/decompose")) {
      decompose(body);
      const criteria = JSON.parse((body as { problem_spec_json: string }).problem_spec_json).success_criteria;
      return { task_skeleton_json: JSON.stringify({ version: "1", entry_point: "work", success_criteria: criteria.length ? criteria : undefined, nodes: [{ key: "work", type: "llm", config: { prompt: "Triage support mail" }, depends_on: [], success_criteria: (assigned ?? criteria).length ? (assigned ?? criteria) : undefined }] }), ambiguity_detected: false, clarification_questions: [] };
    }
    prepare(body); return { status: "ready", architecture: {}, binding_decision: {} };
  } };
  const service = new PlannerFacadeService({ getAccessToken: async () => "fixture" },
    { allowedDataResidency: async () => [] } as unknown as TenantResidencyRepository,
    { effectiveFor: async () => ({ customer_visible: false, contains_pii: false, approve_external_actions: false }) } as unknown as WorkflowSafeguardsService,
    new PlannerClient({ baseUrl: "http://edge" }, http), new CompilerServiceClient({ address: "fixture", protoPath: "/dev/null" }, { compileArchitectureWorkflow: compile } as never));
  return { service, decompose, prepare, compile };
}

it("shows inferred criteria beside steps without compiling before Build", async () => {
  const f = fixture();
  expect(await f.service.planWorkflow(input)).toEqual({ type: "plan", successCriteria: ["Inferred old goal."], steps: [{ key: "work", type: "llm", description: "Triage support mail", successCriteria: ["Inferred old goal."] }] });
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled();
});
it.each([{ successCriteria: ["Edited outcome.", "Added outcome."] }, { successCriteria: ["Only remaining outcome."] }, { successCriteria: [] }])("Build makes the whole edited list authoritative: $successCriteria", async ({ successCriteria }) => {
  const f = fixture();
  expect((await f.service.planWorkflow({ ...input, confirm: true, successCriteria } as never)).type).toBe("compiled");
  expect(JSON.parse(f.decompose.mock.calls[0]![0].problem_spec_json).success_criteria).toEqual(successCriteria);
  expect(f.compile).toHaveBeenCalledTimes(1);
});
it("asks about an uncovered added criterion without dropping it or compiling", async () => {
  const f = fixture(["Inferred old goal."]);
  const result = await f.service.planWorkflow({ ...input, confirm: true, successCriteria: ["Inferred old goal.", "Archive the invoice."] } as never);
  expect(result).toEqual({ type: "clarification", questions: [expect.stringContaining("Archive the invoice.")] });
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled();
});
