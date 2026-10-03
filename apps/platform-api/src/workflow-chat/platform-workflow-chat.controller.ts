import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseFilters } from "@nestjs/common";
import { CreateWorkflowChatRequestSchema, SendWorkflowChatMessageSchema } from "@alterx/contracts";
import { ActorContext, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { Idempotent } from "../idempotency";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { WorkflowHttpError } from "../workflows/problem";
import { emptyActionSchema, parseWorkflowInput } from "../workflows/validation";
import { PlatformWorkflowChatService } from "./platform-workflow-chat.service";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;

@Controller("/api/v1/conversations")
@UseFilters(WorkflowExceptionFilter)
export class PlatformWorkflowChatController {
  constructor(private readonly chats: PlatformWorkflowChatService) {}

  @Get()
  @RequireWorkspaceRole(...readRoles)
  list(@ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent?: string, @Query("type") type?: string) {
    return this.chats.list(this.actor(actor), traceparent, type);
  }
  @Get(":conversationId")
  @RequireWorkspaceRole(...readRoles)
  get(@Param("conversationId") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent?: string) {
    return this.chats.get(id, this.actor(actor), traceparent);
  }
  @Get(":conversationId/messages")
  @RequireWorkspaceRole(...readRoles)
  messages(@Param("conversationId") id: string, @ActorContext() actor: ActorContextType | undefined, @Headers("traceparent") traceparent?: string) {
    return this.chats.messages(id, this.actor(actor), traceparent);
  }
  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole(...readRoles)
  @Idempotent()
  createAssistant(@Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    const input = parseWorkflowInput(CreateWorkflowChatRequestSchema, body, "/api/v1/conversations");
    if (input.type !== "general") throw new WorkflowHttpError(400, "CHAT_TYPE_INVALID", "Use the workflow chat creation route", "/api/v1/conversations");
    return this.chats.create(input, this.actor(actor), traceparent, key);
  }
  @Post("workflows")
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  createWorkflow(@Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    const input = parseWorkflowInput(CreateWorkflowChatRequestSchema, body, "/api/v1/conversations/workflows");
    if (input.type !== "workflow_builder") throw new WorkflowHttpError(400, "CHAT_TYPE_INVALID", "Use the assistant creation route", "/api/v1/conversations/workflows");
    return this.chats.create(input, this.actor(actor), traceparent, key);
  }
  @Post(":conversationId/messages")
  @HttpCode(200)
  @RequireWorkspaceRole(...readRoles)
  @Idempotent()
  sendAssistant(@Param("conversationId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    return this.chats.send(id, parseWorkflowInput(SendWorkflowChatMessageSchema, body, `/api/v1/conversations/${id}/messages`), "general", this.actor(actor), traceparent, key);
  }
  @Post(":conversationId/build")
  @HttpCode(200)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  build(@Param("conversationId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    return this.chats.send(id, parseWorkflowInput(SendWorkflowChatMessageSchema, body, `/api/v1/conversations/${id}/build`), "workflow_builder", this.actor(actor), traceparent, key);
  }
  @Post(":conversationId/archive")
  @HttpCode(204)
  @RequireWorkspaceRole(...readRoles)
  @Idempotent()
  archiveAssistant(@Param("conversationId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    parseWorkflowInput(emptyActionSchema, body, `/api/v1/conversations/${id}/archive`);
    return this.chats.archive(id, "general", this.actor(actor), traceparent, key);
  }
  @Post(":conversationId/workflow-archive")
  @HttpCode(204)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  archiveWorkflow(@Param("conversationId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    parseWorkflowInput(emptyActionSchema, body, `/api/v1/conversations/${id}/workflow-archive`);
    return this.chats.archive(id, "workflow_builder", this.actor(actor), traceparent, key);
  }
  @Post(":conversationId/drafts")
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  draft(@Param("conversationId") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") key: string) {
    parseWorkflowInput(emptyActionSchema, body, `/api/v1/conversations/${id}/drafts`);
    return this.chats.draft(id, this.actor(actor), traceparent, key);
  }

  private actor(actor: ActorContextType | undefined): ActorContextType {
    if (!actor) throw new WorkflowHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", "/api/v1/conversations");
    return actor;
  }
}
