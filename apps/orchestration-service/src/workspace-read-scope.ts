import { HttpException } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { WorkspaceIdSchema, type ProblemDetails } from "@alterx/contracts";
import { uuidV7 } from "./trigger-bindings/ids";

export interface WorkspaceReadScope { readonly workspaceId?: string; }

export function workspaceReadScope(request: IdentityTenantGatewayRequest): WorkspaceReadScope {
  if (request.actorContext?.actor_type === "system") return {};
  const workspace = WorkspaceIdSchema.safeParse(request.actorContext?.workspace_id);
  if (!workspace.success) {
    const problem: ProblemDetails = {
      type: "https://alter.dev/problems/workspace-context-required", title: "Forbidden", status: 403,
      detail: "A workspace-scoped actor is required", instance: request.url?.startsWith("/") ? request.url : "/",
      error_code: "WORKSPACE_CONTEXT_REQUIRED", trace_id: `trc_${uuidV7()}`, request_id: `req_${uuidV7()}`,
      retryable: false, field_errors: [], documentation_key: "identity.workspace",
    };
    throw new HttpException(problem, 403);
  }
  return { workspaceId: workspace.data.slice("ws_".length) };
}
