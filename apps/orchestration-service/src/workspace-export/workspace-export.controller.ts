import { randomUUID } from "node:crypto";
import { Controller, Get, Header, HttpException, Query, Req } from "@nestjs/common";
import type { SessionGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { EngineWorkspaceExportService, EngineWorkspaceExportValidationError } from "./workspace-export.service";

@Controller("api/v1/workspace-export-metadata")
export class EngineWorkspaceExportController {
  constructor(private readonly exports: EngineWorkspaceExportService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async page(@Req() request: SessionGatewayRequest, @Query() query: unknown) {
    const actor = request.actorContext;
    if (!actor) throw problem(request.url, 500, "WORKSPACE_EXPORT_INTERNAL", "Missing authenticated context");
    if (actor.actor_type !== "system" || !actor.permissions.includes("workflows:read") || !actor.permissions.includes("runs:read")) {
      throw problem(request.url, 403, "WORKSPACE_EXPORT_SYSTEM_ONLY", "This read is for the platform's background jobs");
    }
    try {
      return await this.exports.page(actor.tenant_id, query);
    } catch (error: unknown) {
      if (error instanceof EngineWorkspaceExportValidationError) throw problem(request.url, 400, "WORKSPACE_EXPORT_VALIDATION_FAILED", error.message);
      throw problem(request.url, 500, "WORKSPACE_EXPORT_INTERNAL", "Workspace metadata could not be read");
    }
  }
}

function problem(instance: string | undefined, status: 400 | 403 | 500, code: string, detail: string) {
  const id = randomUUID();
  const uuid = `${id.slice(0, 14)}7${id.slice(15)}`;
  const body: ProblemDetails = {
    type: `https://alter.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Internal Server Error",
    status, detail, instance: instance?.startsWith("/") ? instance : "/",
    error_code: code, trace_id: `trc_${uuid}`, request_id: `req_${uuid}`,
    retryable: status === 500, field_errors: [], documentation_key: "workspace.export",
  };
  return new HttpException(body, status);
}
