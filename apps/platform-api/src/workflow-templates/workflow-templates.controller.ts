import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import { ActorContext, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { Idempotent } from "../idempotency";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { WorkflowHttpError } from "../workflows/problem";
import { PlatformWorkflowTemplatesService } from "./workflow-templates.service";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;

@Controller("/api/v1/workflow-templates")
@UseFilters(WorkflowExceptionFilter)
export class PlatformWorkflowTemplatesController {
  constructor(private readonly templates: PlatformWorkflowTemplatesService) {}

  @Get()
  @RequireWorkspaceRole(...readRoles)
  list(@ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent?: string) {
    return this.templates.list(this.actor(actor), traceparent);
  }

  @Post(":templateId/instantiate")
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  instantiate(@Param("templateId") templateId: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    return this.templates.instantiate(templateId, body, this.actor(actor), traceparent, key);
  }

  private actor(actor: ActorContextType | undefined): ActorContextType {
    if (!actor) throw new WorkflowHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", "/api/v1/workflow-templates");
    return actor;
  }
}
