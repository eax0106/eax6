import { Injectable } from "@nestjs/common";
import {
  DeploymentAdminActionResultSchema,
  DeploymentAdminInternalActionRequestSchema,
  TenantDeploymentCollectionSchema,
  PlatformTenantIdSchema,
  type TenantDeploymentCollection,
  type DeploymentAdminActionRequest,
  type DeploymentAdminActionResult,
} from "@alterx/contracts";
import type { EngineConfig } from "./config";
import { EngineProblemError, engineProblemFromResponse, upstreamProblem } from "./problem";
import type { EvalFacadeSecretResolver } from "./eval-facade-client";

@Injectable()
export class DeploymentAdminClient {
  constructor(
    private readonly config: EngineConfig,
    private readonly resolveSecret: EvalFacadeSecretResolver,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(tenantId: string, traceparent: string | undefined): Promise<TenantDeploymentCollection> {
    const tenant = PlatformTenantIdSchema.parse(tenantId), instance = "/api/v1/admin/deployments";
    try {
      const token = await this.resolveSecret(this.config.deploymentAdminServiceTokenRef);
      if (!token.trim()) throw new Error("Deployment service credential unavailable");
      const response = await this.fetchImpl(`${this.config.baseUrl}/internal/admin/deployments?${new URLSearchParams({tenant_id:tenant})}`, {
        headers: {Authorization:`Bearer ${token}`,Accept:"application/json, application/problem+json",...(traceparent?{traceparent}:{})},
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (response.status === 401) throw new EngineProblemError(upstreamProblem(502,instance,"UPSTREAM_SERVICE_ERROR"));
      if (!response.ok) throw new EngineProblemError(await engineProblemFromResponse(response,instance));
      const result = TenantDeploymentCollectionSchema.parse(await response.json());
      if (result.tenant_id !== tenant) throw new Error("Deployment response scope mismatch");
      return result;
    } catch(error) {
      if(error instanceof EngineProblemError) throw error;
      throw new EngineProblemError(upstreamProblem(error instanceof Error && error.name === "TimeoutError" ? 504 : 502,instance,"UPSTREAM_SERVICE_ERROR"));
    }
  }

  async apply(
    input: DeploymentAdminActionRequest,
    staffUserId:string,
    ifMatch:string|undefined,
    traceparent: string | undefined,
  ): Promise<DeploymentAdminActionResult> {
    const instance = `/api/v1/admin/deployments/${input.deployment_id}/actions/apply`;
    const asserted=DeploymentAdminInternalActionRequestSchema.parse({...input,staff_user_id:staffUserId});
    let token: string;
    try {
      token = await this.resolveSecret(this.config.deploymentAdminServiceTokenRef);
      if(!token.trim()) throw new Error("Deployment service credential unavailable");
    } catch {
      throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/internal/admin/deployments/actions/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, application/problem+json",
          "content-type": "application/json",
          ...(traceparent ? { traceparent } : {}),
          ...(ifMatch ? {"If-Match":ifMatch}:{}),
        },
        body: JSON.stringify(asserted),
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
      }
      if (!response.ok) throw new EngineProblemError(await engineProblemFromResponse(response, instance));
      const parsed = DeploymentAdminActionResultSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.tenant_id!==input.tenant_id || parsed.data.deployment_id!==input.deployment_id || parsed.data.action!==input.action || !parsed.data.etag) {
        throw new EngineProblemError(upstreamProblem(502, instance, "UPSTREAM_SERVICE_ERROR"));
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof EngineProblemError) throw error;
      throw new EngineProblemError(
        upstreamProblem(error instanceof Error && error.name === "AbortError" ? 504 : 502, instance,
          error instanceof Error && error.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_SERVICE_ERROR"),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
