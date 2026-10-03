import { workspaceReadScope } from "../workspace-read-scope";
import { Body, Controller, Get, HttpException, Param, Put, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import {
  TemplateVariableConflictError,
  TemplateVariableNotFoundError,
  TemplateVariablesService,
  TemplateVariableValidationError,
  type TemplateVariableDefinition,
} from "./template-variables.service";

interface ReplaceDefinitionsBody {
  readonly definitions?: readonly TemplateVariableDefinition[];
}

interface SetValueBody {
  readonly value?: unknown;
}

function requiredTenantId(request: IdentityTenantGatewayRequest): string {
  const tenantId = request.actorContext?.tenant_id;
  if (tenantId === undefined) {
    throw new HttpException(problem(request.url, 500, "TEMPLATE_VARIABLES_INTERNAL_ERROR", "Missing authenticated tenant context"), 500);
  }
  return tenantId;
}

@Controller("api/v1/workflows")
export class TemplateVariablesController {
  constructor(private readonly templates: TemplateVariablesService) {}

  @Get(":workflowId/template-variables")
  async list(@Req() request: IdentityTenantGatewayRequest, @Param("workflowId") workflowId: string) {
    const scope = workspaceReadScope(request);
    try {
      return { data: await this.templates.list(requiredTenantId(request), workflowId, scope.workspaceId) };
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }

  @Put(":workflowId/template-variables")
  async replace(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Body() body: ReplaceDefinitionsBody,
  ) {
    try {
      if (!Array.isArray(body?.definitions)) {
        throw new TemplateVariableValidationError("definitions must be an array");
      }
      return {
        data: await this.templates.replaceDefinitions(
          requiredTenantId(request),
          workflowId,
          body.definitions,
        ),
      };
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }

  @Put(":workflowId/template-variables/:name/value")
  async setValue(
    @Req() request: IdentityTenantGatewayRequest,
    @Param("workflowId") workflowId: string,
    @Param("name") name: string,
    @Body() body: SetValueBody,
  ) {
    try {
      if (body === undefined || !("value" in body)) {
        throw new TemplateVariableValidationError("value is required");
      }
      return await this.templates.setValue(requiredTenantId(request), workflowId, name, body.value);
    } catch (error: unknown) {
      throw mapError(error, request.url);
    }
  }
}

function mapError(error: unknown, requestUrl: string | undefined): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof TemplateVariableValidationError) {
    return new HttpException(problem(requestUrl, 400, "TEMPLATE_VARIABLES_VALIDATION_FAILED", error.message), 400);
  }
  if (error instanceof TemplateVariableNotFoundError) {
    return new HttpException(problem(requestUrl, 404, "TEMPLATE_VARIABLE_NOT_FOUND", error.message), 404);
  }
  if (error instanceof TemplateVariableConflictError) {
    return new HttpException(problem(requestUrl, 409, "TEMPLATE_VARIABLE_VERSION_CONFLICT", error.message), 409);
  }
  return new HttpException(problem(requestUrl, 500, "TEMPLATE_VARIABLES_INTERNAL_ERROR", "Template variables request could not be completed"), 500);
}

function problem(
  requestUrl: string | undefined,
  status: number,
  errorCode: string,
  detail: string,
): ProblemDetails {
  return {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 400 ? "Bad Request" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Internal Server Error",
    status,
    detail,
    instance: requestUrl?.startsWith("/") ? requestUrl : "/",
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
  };
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}` as `${typeof prefix}_${string}`;
}
