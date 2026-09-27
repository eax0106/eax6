import { PlannerClient, type PlannerHttpClient } from "@alterx/adapters";
import { describe, expect, it, vi } from "vitest";

import { compilerServiceAddress, PlannerFacadeService } from "./planner-facade.service";
import { TenantDataResidencyError, type TenantResidencyRepository } from "./tenant-residency.repository";
import { WorkflowSafeguardsError, type WorkflowSafeguardsService } from "./workflow-safeguards.service";
import { CompilerServiceClient } from "./compiler-client";
import type {
  CompilerCompileArchitectureWorkflowRequest,
  CompilerCompileWorkflowRequest,
  CompilerCompileWorkflowResponse,
} from "@alterx/contracts";

const TENANT_ID = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKSPACE_ID = "ws_018f47a5-7b2c-7d10-8f11-123456789abc";
const WORKFLOW_ID = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";

function realProblemSpec(objective: string): Record<string, unknown> {
  return {
    objective,
    current_situation: null,
    actors: [],
    systems_involved: [],
    constraints: [],
    required_data: [],
    risk: "low",
    missing_information: [],
    success_criteria: [],
    context_references: [],
  };
}

/** Fakes the real HTTP surface PlannerClient dispatches to -- routed by
 * URL suffix, mirroring exactly what apps/intelligence-service/src/
 * planner/router.py and architecture_synthesizer/router.py expose. */
class FakePlannerHttpClient implements PlannerHttpClient {
  readonly calls: { readonly url: string; readonly body: unknown }[] = [];
  understandResponse: unknown;
  decomposeResponse: unknown;
  prepareCompilerInputResponse: unknown;

  async postJson(url: string, body: unknown): Promise<unknown> {
    this.calls.push({ url, body });
    if (url.endsWith("/internal/problem-understanding/understand")) {
      return this.understandResponse;
    }
    if (url.endsWith("/planner/decompose")) {
      return this.decomposeResponse;
    }
    if (url.endsWith("/internal/architecture-synthesis/prepare-compiler-input")) {
      return this.prepareCompilerInputResponse;
    }
    throw new Error(`FakePlannerHttpClient has no stubbed response for ${url}`);
  }
}

/** Fakes the raw gRPC client CompilerServiceClient's own constructor
 * already accepts as an injectable override (see compiler-client.ts). */
class FakeCompilerGrpcClient {
  readonly compileArchitectureWorkflowCalls: CompilerCompileArchitectureWorkflowRequest[] = [];
  response: CompilerCompileWorkflowResponse = {
    workflow_version_id: "wfv_018f47a5-7b2c-7d10-8f11-123456789fff",
    compiled_dag_json: "{}",
    node_requirements_json: "{}",
    policy_bindings_json: "{}",
  };
  error: Error | undefined;

  compileWorkflow(
    _request: CompilerCompileWorkflowRequest,
    _options: unknown,
    callback: (error: Error | null, response?: CompilerCompileWorkflowResponse) => void,
  ): void {
    callback(new Error("not stubbed"));
  }

  compileArchitectureWorkflow(
    request: CompilerCompileArchitectureWorkflowRequest,
    _options: unknown,
    callback: (error: Error | null, response?: CompilerCompileWorkflowResponse) => void,
  ): void {
    this.compileArchitectureWorkflowCalls.push(request);
    if (this.error) {
      callback(this.error);
      return;
    }
    callback(null, this.response);
  }
}

const NO_SAFEGUARDS = { customer_visible: false, contains_pii: false, approve_external_actions: false };

function service(
  http: FakePlannerHttpClient,
  grpc: FakeCompilerGrpcClient,
  allowedDataResidency: TenantResidencyRepository["allowedDataResidency"] = vi.fn().mockResolvedValue([]),
  effectiveFor: WorkflowSafeguardsService["effectiveFor"] = vi.fn().mockResolvedValue(NO_SAFEGUARDS),
): PlannerFacadeService {
  const plannerClient = new PlannerClient({ baseUrl: "http://intelligence.internal" }, http);
  const compilerClient = new CompilerServiceClient(
    { address: "orchestration.internal:50071", protoPath: "/dev/null" },
    grpc as never,
  );
  return new PlannerFacadeService(
    { getAccessToken: vi.fn().mockResolvedValue("m2m-token") },
    { allowedDataResidency } as TenantResidencyRepository,
    { effectiveFor } as unknown as WorkflowSafeguardsService,
    plannerClient,
    compilerClient,
  );
}

function readyHttp(): FakePlannerHttpClient {
  const http = new FakePlannerHttpClient();
  http.understandResponse = realProblemSpec("Email the customers");
  http.decomposeResponse = {
    task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
    ambiguity_detected: false,
    clarification_questions: [],
  };
  http.prepareCompilerInputResponse = { status: "ready", architecture: {}, binding_decision: {} };
  return http;
}

function prepareBody(http: FakePlannerHttpClient): { constraints?: Record<string, unknown> } {
  const call = http.calls.find((candidate) =>
    candidate.url.endsWith("/internal/architecture-synthesis/prepare-compiler-input"),
  );
  return call!.body as { constraints?: Record<string, unknown> };
}

describe("PlannerFacadeService.planWorkflow constraints", () => {
  it("sends the effective safeguards and the tenant's own residency to synthesis", async () => {
    const http = readyHttp();
    const residency = vi.fn().mockResolvedValue(["eu"]);
    const effectiveFor = vi
      .fn()
      .mockResolvedValue({ customer_visible: true, contains_pii: true, approve_external_actions: true });

    await service(http, new FakeCompilerGrpcClient(), residency, effectiveFor).planWorkflow({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      objective: "Email the customers",
    });

    expect(residency).toHaveBeenCalledWith(TENANT_ID);
    expect(effectiveFor).toHaveBeenCalledWith(TENANT_ID, WORKSPACE_ID, WORKFLOW_ID);
    // "Approve external actions" is external_action_approval_required, never
    // human_approval_required, which would also hold delivered output.
    expect(prepareBody(http).constraints).toEqual({
      customer_visible: true,
      contains_pii: true,
      external_action_approval_required: true,
      allowed_data_residency: ["eu"],
    });
  });

  it("sends every safeguard off only when the workspace and workflow ask for none", async () => {
    const http = readyHttp();

    await service(http, new FakeCompilerGrpcClient()).planWorkflow({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      objective: "Email the customers",
    });

    expect(prepareBody(http).constraints).toEqual({
      customer_visible: false,
      contains_pii: false,
      external_action_approval_required: false,
      allowed_data_residency: [],
    });
  });

  it("does not plan when the safeguards cannot be read", async () => {
    const http = readyHttp();
    const grpc = new FakeCompilerGrpcClient();
    const effectiveFor = vi.fn().mockRejectedValue(new WorkflowSafeguardsError("workspace not found"));

    await expect(
      service(http, grpc, undefined, effectiveFor).planWorkflow({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        objective: "Email the customers",
      }),
    ).rejects.toBeInstanceOf(WorkflowSafeguardsError);
    expect(http.calls.some((call) => call.url.endsWith("/prepare-compiler-input"))).toBe(false);
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  it("does not plan when the tenant's residency cannot be read", async () => {
    const http = readyHttp();
    const grpc = new FakeCompilerGrpcClient();
    const residency = vi.fn().mockRejectedValue(new TenantDataResidencyError("tenant data_residency is malformed"));

    await expect(
      service(http, grpc, residency).planWorkflow({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        objective: "Email the customers",
      }),
    ).rejects.toBeInstanceOf(TenantDataResidencyError);
    expect(http.calls.some((call) => call.url.endsWith("/prepare-compiler-input"))).toBe(false);
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });
});

describe("PlannerFacadeService.planWorkflow", () => {
  it("real happy path: understand -> decompose -> prepare-compiler-input -> compile", async () => {
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Ship the thing");
    http.decomposeResponse = {
      task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
      ambiguity_detected: false,
      clarification_questions: [],
    };
    http.prepareCompilerInputResponse = {
      status: "ready",
      architecture: { topology: "single" },
      binding_decision: { bindings: [] },
    };
    const grpc = new FakeCompilerGrpcClient();

    const result = await service(http, grpc).planWorkflow({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      objective: "Ship the thing",
    });

    expect(result).toEqual({
      type: "compiled",
      versionId: "wfv_018f47a5-7b2c-7d10-8f11-123456789fff",
    });
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(1);
    const compileCall = grpc.compileArchitectureWorkflowCalls[0]!;
    expect(compileCall.tenant_id).toBe(TENANT_ID);
    expect(compileCall.workspace_id).toBe(WORKSPACE_ID);
    expect(compileCall.workflow_id).toBe(WORKFLOW_ID);
    expect(JSON.parse(compileCall.architecture_json)).toEqual({ topology: "single" });
    expect(JSON.parse(compileCall.binding_decision_json)).toEqual({ bindings: [] });

    // Real chained identifiers: understand/decompose/prepare-compiler-input
    // all carry the same real run_id and tenant/workspace, prefixed for real.
    const [understandCall, decomposeCall, prepareCall] = http.calls;
    expect((understandCall!.body as { tenant_id: string }).tenant_id).toBe(TENANT_ID);
    const runId = (understandCall!.body as { run_id: string }).run_id;
    expect(runId).toMatch(/^run_/);
    expect((decomposeCall!.body as { run_id: string }).run_id).toBe(runId);
    expect((prepareCall!.body as { tenant_id: string }).tenant_id).toBe(TENANT_ID);
    expect((prepareCall!.body as { task_skeleton: { entry_point: string } }).task_skeleton.entry_point).toBe(
      "n1",
    );
  });

  it("real clarification path: returns questions and never reaches the compiler", async () => {
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Ambiguous goal");
    http.decomposeResponse = {
      task_skeleton_json: "{}",
      ambiguity_detected: true,
      clarification_questions: ["Which environment?"],
    };
    const grpc = new FakeCompilerGrpcClient();

    const result = await service(http, grpc).planWorkflow({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      objective: "Ambiguous goal",
    });

    expect(result).toEqual({
      type: "clarification",
      questions: ["Which environment?"],
    });
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
    expect(http.calls).toHaveLength(2); // understand + decompose only
  });

  it("ambiguity_detected with zero real questions falls through to compilation, not clarification", async () => {
    // decomposeResponse.ambiguity_detected alone isn't enough -- the real
    // guard requires clarification_questions.length > 0 too, matching the
    // service's own `&&` condition.
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Goal");
    http.decomposeResponse = {
      task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
      ambiguity_detected: true,
      clarification_questions: [],
    };
    http.prepareCompilerInputResponse = {
      status: "ready",
      architecture: {},
      binding_decision: {},
    };
    const grpc = new FakeCompilerGrpcClient();

    const result = await service(http, grpc).planWorkflow({
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      objective: "Goal",
    });

    expect(result.type).toBe("compiled");
  });

  it("real blocked-architecture path throws instead of fabricating a compiled result", async () => {
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Goal");
    http.decomposeResponse = {
      task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
      ambiguity_detected: false,
      clarification_questions: [],
    };
    http.prepareCompilerInputResponse = {
      status: "blocked",
      detail: { reason: "Capability Registry has no eligible visible active record" },
    };
    const grpc = new FakeCompilerGrpcClient();

    await expect(
      service(http, grpc).planWorkflow({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        objective: "Goal",
      }),
    ).rejects.toThrow("Architecture pipeline blocked compilation");
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  it("real compiler gRPC failure propagates instead of being swallowed", async () => {
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Goal");
    http.decomposeResponse = {
      task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
      ambiguity_detected: false,
      clarification_questions: [],
    };
    http.prepareCompilerInputResponse = {
      status: "ready",
      architecture: {},
      binding_decision: {},
    };
    const grpc = new FakeCompilerGrpcClient();
    grpc.error = Object.assign(new Error("compiler unavailable"), { code: 14 });

    await expect(
      service(http, grpc).planWorkflow({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        objective: "Goal",
      }),
    ).rejects.toThrow(/Compiler Service request failed/);
  });

  it("bare (unprefixed) tenant/workspace ids get prefixed for real before any downstream call", async () => {
    const http = new FakePlannerHttpClient();
    http.understandResponse = realProblemSpec("Goal");
    http.decomposeResponse = {
      task_skeleton_json: JSON.stringify({ nodes: [], entry_point: "n1", version: "v1" }),
      ambiguity_detected: false,
      clarification_questions: [],
    };
    http.prepareCompilerInputResponse = { status: "ready", architecture: {}, binding_decision: {} };
    const grpc = new FakeCompilerGrpcClient();

    await service(http, grpc).planWorkflow({
      tenantId: TENANT_ID.slice("ten_".length),
      workspaceId: WORKSPACE_ID.slice("ws_".length),
      workflowId: WORKFLOW_ID,
      objective: "Goal",
    });

    const understandBody = http.calls[0]!.body as { tenant_id: string; workspace_id: string };
    expect(understandBody.tenant_id).toBe(TENANT_ID);
    expect(understandBody.workspace_id).toBe(WORKSPACE_ID);
  });
});

describe("compilerServiceAddress", () => {
  // Every other spec in this file injects a fake CompilerServiceClient, so the
  // address the real one would have been built with was never asserted. That is
  // exactly how it came to point at 127.0.0.1:50071, a port nothing binds,
  // leaving POST /api/v1/workflows/:workflowId/actions/plan unable to complete.
  it("defaults to the port orchestration-service actually binds the compiler on", () => {
    expect(compilerServiceAddress({})).toBe("127.0.0.1:50056");
  });

  it("never defaults into the eval harness port band", () => {
    // 50050-50069 are real service surfaces; 50070 upwards is the eval
    // harness, which binds its own servers on ports it chooses per run. A
    // default in that band answers nothing and times out.
    const port = Number(compilerServiceAddress({}).split(":")[1]);
    expect(port).toBeGreaterThanOrEqual(50050);
    expect(port).toBeLessThan(50070);
  });

  it("prefers an explicit COMPILER_GRPC_TARGET", () => {
    expect(compilerServiceAddress({ COMPILER_GRPC_TARGET: "orchestration:50056" })).toBe(
      "orchestration:50056",
    );
  });

  it("falls back to the default when the override is blank", () => {
    expect(compilerServiceAddress({ COMPILER_GRPC_TARGET: "   " })).toBe("127.0.0.1:50056");
  });
});
