import { Injectable, Inject, Optional } from "@nestjs/common";
import { PlannerClient, type PlannerHttpClient, type SynthesisConstraints } from "@alterx/adapters";
import { CompilerServiceClient } from "./compiler-client";
import { randomUUID } from "node:crypto";
import { getCompilerProtoPath } from "./compiler-client";
import { ENGINE_M2M_TOKEN_PROVIDER, type EngineM2mTokenProvider } from "../engine/auth";
import { TenantResidencyRepository } from "./tenant-residency.repository";
import { WorkflowSafeguardsService } from "./workflow-safeguards.service";

export function createFetchPlannerHttpClient(tokenProvider: () => Promise<string>): PlannerHttpClient {
  return {
    async postJson(url: string, body: unknown): Promise<unknown> {
      // Service-level credential only -- the tenant travels in the request
      // body (and, for Engine calls, the actor token), never in the M2M
      // grant. See EngineM2mTokenProvider for why tenant-scoping this call
      // is wrong and breaks against real Auth0.
      const token = await tokenProvider();

      const response = await fetch(url, {
        method: "POST",
        headers: { 
          "content-type": "application/json",
          "authorization": `Bearer ${token}`
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Planner request to ${url} failed with status ${response.status}: ${detail}`,
        );
      }
      return response.json();
    },
  };
}

export interface PlanWorkflowInput {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly objective: string;
}

export type PlanWorkflowResult = 
  | { type: "clarification"; questions: readonly string[] }
  | { type: "compiled"; versionId: string };

/**
 * Where orchestration-service serves the workflow compiler.
 *
 * orchestration-service binds it per COMPILER_GRPC_BIND_ADDRESS, which
 * defaults to 0.0.0.0:50056. This used to default to 127.0.0.1:50071 and read
 * an override named ORCHESTRATION_GRPC_URL that appeared exactly once in the
 * repository -- on that line -- and was set nowhere, in no environment file, CI
 * job, document or Terraform stack. So the wrong default always applied, and
 * POST /api/v1/workflows/:workflowId/actions/plan could not complete: a gRPC
 * dial at a port nothing binds times out rather than failing fast, so it
 * looked like slowness rather than a wrong address.
 *
 * 50050 to 50069 are the real service surfaces. 50070 upwards belongs to the
 * eval harness, which binds its own servers on ports it picks per run -- which
 * is why 50071 looked plausible and answered nothing.
 */
export function compilerServiceAddress(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.COMPILER_GRPC_TARGET?.trim() || "127.0.0.1:50056";
}

@Injectable()
export class PlannerFacadeService {
  private readonly plannerClient: PlannerClient;
  private readonly compilerClient: CompilerServiceClient;

  constructor(
    @Inject(ENGINE_M2M_TOKEN_PROVIDER) private readonly m2mTokenProvider: EngineM2mTokenProvider,
    // Required, not @Optional: a missing reader must not quietly plan every
    // tenant as if it pinned no residency.
    private readonly tenantResidency: TenantResidencyRepository,
    // Required for the same reason: planning without it would drop every
    // safeguard the workspace requires.
    private readonly safeguards: WorkflowSafeguardsService,
    // Both real clients already support an injectable transport
    // (PlannerClient's httpClient param, CompilerServiceClient's raw gRPC
    // client param) -- @Optional() here just lets a test construct this
    // service directly with fakes wired through those existing seams,
    // without inventing a new one. Nest has no provider registered for
    // either class, so in the real app these always resolve to
    // undefined and this falls through to the exact same construction
    // that ran unconditionally before -- zero behavior change.
    @Optional() plannerClient?: PlannerClient,
    @Optional() compilerClient?: CompilerServiceClient,
  ) {
    const intelligenceUrl = process.env.INTELLIGENCE_SERVICE_URL || "http://127.0.0.1:8000";

    this.plannerClient = plannerClient ?? new PlannerClient(
      { baseUrl: intelligenceUrl },
      createFetchPlannerHttpClient(() => this.m2mTokenProvider.getAccessToken())
    );

    this.compilerClient = compilerClient ?? new CompilerServiceClient({
      address: compilerServiceAddress(),
      protoPath: getCompilerProtoPath(),
    });
  }



  async planWorkflow(input: PlanWorkflowInput): Promise<PlanWorkflowResult> {
    const runId = `run_${randomUUID().slice(0, 14)}7${randomUUID().slice(15)}`;
    const tenantId = prefixed("ten", input.tenantId);
    const workspaceId = prefixed("ws", input.workspaceId);
    const problemSpec = await this.plannerClient.understand({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      run_id: runId,
      objective: input.objective,
    });

    const decomposeResponse = await this.plannerClient.decompose({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      run_id: runId,
      strategy: "default",
      problem_spec_json: JSON.stringify(problemSpec),
    });

    if (decomposeResponse.ambiguity_detected && decomposeResponse.clarification_questions.length > 0) {
      return {
        type: "clarification",
        questions: decomposeResponse.clarification_questions,
      };
    }

    const prepared = await this.plannerClient.prepareCompilerInput({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      task_skeleton: JSON.parse(decomposeResponse.task_skeleton_json),
      constraints: await this.constraints(input),
    });
    if (prepared.status !== "ready") throw new Error("Architecture pipeline blocked compilation");
    const compileResponse = await this.compilerClient.compileArchitectureWorkflow({
      tenant_id: tenantId, workspace_id: workspaceId, workflow_id: input.workflowId,
      architecture_json: JSON.stringify(prepared.architecture),
      binding_decision_json: JSON.stringify(prepared.binding_decision),
      dag_schema_version: "v1",
    });

    return {
      type: "compiled",
      versionId: compileResponse.workflow_version_id,
    };
  }

  /**
   * Read fresh on every plan, never taken from the request: the workspace's
   * safeguards OR the workflow's additions, and the tenant's residency.
   * "Approve external actions" maps to external_action_approval_required, not
   * human_approval_required, which would also hold delivered output.
   */
  private async constraints(input: PlanWorkflowInput): Promise<SynthesisConstraints> {
    const [effective, allowedDataResidency] = await Promise.all([
      this.safeguards.effectiveFor(input.tenantId, input.workspaceId, input.workflowId),
      this.tenantResidency.allowedDataResidency(input.tenantId),
    ]);
    return {
      customer_visible: effective.customer_visible,
      contains_pii: effective.contains_pii,
      external_action_approval_required: effective.approve_external_actions,
      allowed_data_residency: allowedDataResidency,
    };
  }
}

// intelligence-service and the compiler both enforce <prefix>_<UUIDv7> on
// tenant_id/workspace_id (packages/contracts/src/ids.ts); ActorContext only
// carries the bare UUID.
function prefixed(prefix: "ten" | "ws", id: string): string {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
}
