import { PlannerClient, type PlannerHttpClient } from "@alterx/adapters";
import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IdempotencyExceptionFilter,
  IdempotencyHttpError,
  IdempotencyInterceptor,
  PgIdempotencyStore,
  type IdempotencyExecution,
  type StoredHttpResponse,
} from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { CompilerServiceClient } from "./compiler-client";
import { PlannerFacadeController } from "./planner-facade.controller";
import { PlannerFacadeService } from "./planner-facade.service";
import type { TenantResidencyRepository } from "./tenant-residency.repository";
import type { WorkflowSafeguardsService } from "./workflow-safeguards.service";
import { ENGINE_M2M_TOKEN_PROVIDER } from "../engine/auth";
import type {
  CompilerCompileArchitectureWorkflowRequest,
  CompilerCompileWorkflowRequest,
  CompilerCompileWorkflowResponse,
} from "@alterx/contracts";

const uuid = "018f47a5-7b2c-7d10-8f11-123456789abc";
const workflowId = `wf_${uuid}`;
const tenantId = `ten_${uuid}`;
const workspaceId = `ws_${uuid}`;
const actor: ActorContextType = {
  user_id: `usr_${uuid}`,
  tenant_id: tenantId,
  workspace_id: workspaceId,
  session_id: "session-plan",
  auth_time: 1_700_000_000,
  roles: ["editor"],
  permissions: ["workflows:write"],
};
const viewer: ActorContextType = { ...actor, roles: ["viewer"], permissions: ["workflows:read"] };

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

const DEFAULT_DECOMPOSE_RESPONSE = {
  task_skeleton_json: JSON.stringify({ nodes: [{ key: "n1", type: "llm", config: {}, depends_on: [] }], entry_point: "n1", version: "v1" }),
  ambiguity_detected: false,
  clarification_questions: [] as readonly string[],
};
const DEFAULT_PREPARE_COMPILER_INPUT_RESPONSE = {
  status: "ready" as const,
  architecture: { topology: "single" },
  binding_decision: { bindings: [] },
};

class FakePlannerHttpClient implements PlannerHttpClient {
  readonly calls: { readonly url: string; readonly body: unknown }[] = [];
  decomposeResponse: unknown = DEFAULT_DECOMPOSE_RESPONSE;
  prepareCompilerInputResponse: unknown = DEFAULT_PREPARE_COMPILER_INPUT_RESPONSE;

  reset(): void {
    this.calls.length = 0;
    // Real bug caught here, not just call-tracking: individual tests
    // mutate decomposeResponse/prepareCompilerInputResponse to exercise
    // real branches (clarification, blocked) -- without restoring these
    // too, a later test silently inherits an earlier test's override.
    this.decomposeResponse = DEFAULT_DECOMPOSE_RESPONSE;
    this.prepareCompilerInputResponse = DEFAULT_PREPARE_COMPILER_INPUT_RESPONSE;
  }

  async postJson(url: string, body: unknown): Promise<unknown> {
    this.calls.push({ url, body });
    if (url.endsWith("/internal/problem-understanding/understand")) {
      return realProblemSpec((body as { objective: string }).objective);
    }
    if (url.endsWith("/planner/decompose")) return this.decomposeResponse;
    if (url.endsWith("/internal/architecture-synthesis/prepare-compiler-input")) {
      return this.prepareCompilerInputResponse;
    }
    throw new Error(`FakePlannerHttpClient has no stubbed response for ${url}`);
  }
}

class FakeCompilerGrpcClient {
  readonly compileArchitectureWorkflowCalls: CompilerCompileArchitectureWorkflowRequest[] = [];
  response: CompilerCompileWorkflowResponse = {
    workflow_version_id: `wfv_${uuid}`,
    compiled_dag_json: "{}",
    node_requirements_json: "{}",
    policy_bindings_json: "{}",
  };

  reset(): void {
    this.compileArchitectureWorkflowCalls.length = 0;
  }

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
    callback(null, this.response);
  }
}

class MemoryIdempotencyStore {
  private readonly responses = new Map<string, StoredHttpResponse & { fingerprint: string }>();

  clear(): void {
    this.responses.clear();
  }

  async execute(input: IdempotencyExecution, operation: () => Promise<StoredHttpResponse>) {
    if (!input.key) {
      throw new IdempotencyHttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header required",
        input.instance,
      );
    }
    const key = `${input.tenantId}:${input.key}`;
    const stored = this.responses.get(key);
    if (stored) {
      if (stored.fingerprint !== input.fingerprint) {
        throw new IdempotencyHttpError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key reused with different request",
          input.instance,
        );
      }
      return { status: stored.status, body: stored.body, replayed: true };
    }
    const result = await operation();
    this.responses.set(key, { ...result, fingerprint: input.fingerprint });
    return { ...result, replayed: false };
  }
}

interface TestResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  json(): unknown;
}

describe("PlannerFacadeController routes", () => {
  let app: NestFastifyApplication;
  const http = new FakePlannerHttpClient();
  const grpc = new FakeCompilerGrpcClient();
  const store = new MemoryIdempotencyStore();
  const residency = { allowedDataResidency: vi.fn().mockResolvedValue(["eu"]) };
  const safeguards = {
    effectiveFor: vi
      .fn()
      .mockResolvedValue({ customer_visible: false, contains_pii: true, approve_external_actions: true }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [PlannerFacadeController],
      providers: [
        {
          provide: PlannerFacadeService,
          useFactory: () =>
            new PlannerFacadeService(
              { getAccessToken: vi.fn().mockResolvedValue("m2m-token") },
              residency as unknown as TenantResidencyRepository,
              safeguards as unknown as WorkflowSafeguardsService,
              new PlannerClient({ baseUrl: "http://intelligence.internal" }, http),
              new CompilerServiceClient(
                { address: "orchestration.internal:50071", protoPath: "/dev/null" },
                grpc as never,
              ),
            ),
        },
        { provide: ENGINE_M2M_TOKEN_PROVIDER, useValue: { getAccessToken: vi.fn() } },
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        { provide: PgIdempotencyStore, useValue: store },
        { provide: APP_FILTER, useClass: IdempotencyExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook(
      "preHandler",
      (request: FastifyRequest, _reply: unknown, done: () => void) => {
        const value = request.headers["x-test-actor"];
        if (typeof value === "string") {
          (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
        }
        done();
      },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    http.reset();
    grpc.reset();
    store.clear();
  });

  afterAll(async () => app.close());

  it("returns the plan before Build and never calls synthesis or compiler", async () => {
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, { key: "preview", body: { goal: "Triage support mail" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ type: "plan", successCriteria: [], steps: [{ key: "n1", type: "llm", description: "n1", successCriteria: [] }] });
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
    expect(http.calls.filter(call => call.url.endsWith("/prepare-compiler-input"))).toHaveLength(0);
  });

  it.each([{ confirm: true }, { successCriteria: ["Notify support."] }, { confirm: false, successCriteria: [] }, { confirm: true, successCriteria: [""] }])("rejects incomplete or invalid Build confirmation before planning", async confirmation => {
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, { key: "invalid-confirmation", body: { goal: "Triage", ...confirmation } });
    expect(response.statusCode).toBe(400); expect(http.calls).toHaveLength(0); expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  it("real happy path: plans, synthesizes, binds, and compiles through the real route", async () => {
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-1",
      body: { confirm: true, successCriteria: [], goal: "Ship the thing" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ type: "compiled", versionId: `wfv_${uuid}` });
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(1);
    expect(grpc.compileArchitectureWorkflowCalls[0]!.workflow_id).toBe(workflowId);
  });

  it("real answers merge: clarification answers fold into the objective before Planner sees it", async () => {
    await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-answers",
      body: {
        confirm: true, successCriteria: [],
        goal: "Ship the thing",
        answers: { "Which environment?": "staging" },
      },
    });

    const understandCall = http.calls.find((call) =>
      call.url.endsWith("/internal/problem-understanding/understand"),
    )!;
    const objective = (understandCall.body as { objective: string }).objective;
    expect(objective).toContain("Ship the thing");
    expect(objective).toContain("Which environment?");
    expect(objective).toContain("staging");
  });

  it("real clarification path returns questions with no compile call", async () => {
    http.decomposeResponse = {
      task_skeleton_json: "{}",
      ambiguity_detected: true,
      clarification_questions: ["Which environment?"],
    };

    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-clarify",
      body: { confirm: true, successCriteria: [], goal: "Ambiguous goal" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      type: "clarification",
      questions: ["Which environment?"],
    });
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  it("real RBAC gate: a viewer cannot trigger planning", async () => {
    const response = await request(
      "POST",
      `/api/v1/workflows/${workflowId}/actions/plan`,
      viewer,
      { key: "plan-denied", body: { confirm: true, successCriteria: [], goal: "Ship the thing" } },
    );

    expect(response.statusCode).toBe(403);
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  it("real idempotency: replaying the same key does not re-call Planner or the Compiler", async () => {
    const url = `/api/v1/workflows/${workflowId}/actions/plan`;
    const first = await request("POST", url, actor, {
      key: "plan-replay",
      body: { confirm: true, successCriteria: [], goal: "Ship the thing" },
    });
    const replay = await request("POST", url, actor, {
      key: "plan-replay",
      body: { confirm: true, successCriteria: [], goal: "Ship the thing" },
    });

    expect(first.json()).toEqual(replay.json());
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(1);
    expect(http.calls.filter((call) => call.url.endsWith("/planner/decompose"))).toHaveLength(1);
  });

  it("plans with the stored safeguards and the tenant's residency", async () => {
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-safeguards",
      body: { confirm: true, successCriteria: [], goal: "Email the customers" },
    });

    expect(response.statusCode).toBe(200);
    expect(safeguards.effectiveFor).toHaveBeenLastCalledWith(tenantId, workspaceId, workflowId);
    const prepare = http.calls.filter((call) => call.url.endsWith("/prepare-compiler-input")).at(-1);
    expect((prepare!.body as { constraints: unknown }).constraints).toEqual({
      customer_visible: false,
      contains_pii: true,
      external_action_approval_required: true,
      allowed_data_residency: ["eu"],
    });
  });

  it.each([
    ["safeguards sent per request", { constraints: { human_approval_required: true } }],
    ["residency sent per request", { constraints: { allowed_data_residency: ["us"] } }],
    ["any unknown field", { priority: "high" }],
  ])("rejects %s with a 400 before any Planner call", async (_name, extra) => {
    const before = http.calls.length;
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: `plan-rejected-${JSON.stringify(extra)}`,
      body: { confirm: true, successCriteria: [], goal: "Email the customers", ...extra },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error_code: string }).error_code).toBe("INVALID_PLAN_REQUEST");
    expect(http.calls).toHaveLength(before);
  });

  it("real body validation: a blank goal is rejected before any Planner call", async () => {
    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-invalid",
      body: { confirm: true, successCriteria: [], goal: "" },
    });

    // Was a bare 500 from an uncaught ZodError; the body is now validated
    // into a problem response, like any other client error.
    expect(response.statusCode).toBe(400);
    expect(http.calls).toHaveLength(0);
  });

  it("real blocked-architecture path surfaces as a real (undecorated) server error, not a fabricated success", async () => {
    http.prepareCompilerInputResponse = {
      status: "blocked",
      detail: { reason: "Capability Registry has no eligible visible active record" },
    };

    const response = await request("POST", `/api/v1/workflows/${workflowId}/actions/plan`, actor, {
      key: "plan-blocked",
      body: { confirm: true, successCriteria: [], goal: "Ship the thing" },
    });

    // planner-facade.module.ts registers no exception filter of its own,
    // so an unhandled Error here really does fall through to Nest's bare
    // default 500 -- documenting the real current behavior, not inventing
    // a nicer one this task didn't ask for.
    expect(response.statusCode).toBe(500);
    expect(grpc.compileArchitectureWorkflowCalls).toHaveLength(0);
  });

  function request(
    method: "POST",
    url: string,
    requestActor: ActorContextType | undefined,
    options: { key?: string; body?: unknown } = {},
  ): Promise<TestResponse> {
    return app.getHttpAdapter().getInstance().inject({
      method,
      url,
      headers: {
        ...(requestActor ? { "x-test-actor": JSON.stringify(requestActor) } : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body }),
    } as never) as Promise<TestResponse>;
  }
});
