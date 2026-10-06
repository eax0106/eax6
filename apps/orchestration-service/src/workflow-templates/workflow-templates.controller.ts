import { Body, Controller, Get, HttpException, Inject, Param, Post, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { WorkflowTemplateIdSchema } from "@alterx/contracts";
import { ZodError } from "zod";

import { CompilerValidationError } from "../compiler/dag-builder";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowNotFoundError } from "../workflow-read/workflow-read.service";
import { WorkflowTemplateNotFoundError } from "./template-registry.client";
import { TemplatePlaceholderError } from "./template-skeleton";
import { WorkflowTemplateError, WorkflowTemplatesService } from "./workflow-templates.service";

@Controller("api/v1/workflow-templates")
export class WorkflowTemplatesController {
  constructor(@Inject(WorkflowTemplatesService) private readonly templates: WorkflowTemplatesService) {}

  @Get()
  list(@Req() request: IdentityTenantGatewayRequest) {
    return this.respond(request, () => this.templates.list());
  }

  @Post(":templateId/instantiate")
  instantiate(@Req() request: IdentityTenantGatewayRequest, @Param("templateId") templateId: string, @Body() body: unknown) {
    return this.respond(request, (actor) => this.templates.instantiate(actor, WorkflowTemplateIdSchema.parse(templateId), body));
  }

  private async respond<T>(request: IdentityTenantGatewayRequest, operation: (actor: NonNullable<IdentityTenantGatewayRequest["actorContext"]>) => Promise<T>): Promise<T> {
    try {
      if (!request.actorContext) throw new WorkflowTemplateError(500, "TEMPLATE_CONTEXT_MISSING", "Authenticated caller context is missing");
      return await operation(request.actorContext);
    } catch (error: unknown) {
      const status = error instanceof WorkflowTemplateError ? error.status
        : error instanceof WorkflowTemplateNotFoundError || error instanceof WorkflowNotFoundError ? 404
        : error instanceof ZodError ? 400
        : error instanceof CompilerValidationError || error instanceof TemplatePlaceholderError ? 422 : 500;
      const code = error instanceof WorkflowTemplateError ? error.code
        : status === 404 ? "TEMPLATE_NOT_FOUND" : status === 400 ? "INVALID_TEMPLATE_REQUEST" : status === 422 ? "TEMPLATE_NOT_COMPILABLE" : "INTERNAL_ERROR";
      throw new HttpException({ type: "about:blank", title: status === 500 ? "Internal Server Error" : "Template request failed", status,
        detail: status === 500 ? "Template request could not complete" : error instanceof Error ? error.message : "Invalid template request",
        instance: request.url, error_code: code, trace_id: `trc_${uuidV7()}`, request_id: `req_${uuidV7()}`, retryable: status >= 500 }, status);
    }
  }
}
