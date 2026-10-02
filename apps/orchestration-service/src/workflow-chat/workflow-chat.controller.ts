import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import { CreateWorkflowChatRequestSchema, WorkflowChatMessageSchema } from "@alterx/contracts";
import { z, ZodError } from "zod";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowNotFoundError, WorkflowValidationError } from "../workflow-read/workflow-read.service";
import { WorkflowChatError, WorkflowChatService } from "./workflow-chat.service";

const replySchema=WorkflowChatMessageSchema.pick({kind:true,content:true}).extend({userMessageId:WorkflowChatMessageSchema.shape.id}).strict();
const answerSchema=z.object({userMessageId:WorkflowChatMessageSchema.shape.id,snapshot:z.record(z.string(),z.unknown())}).strict();

@Controller("api/v1/conversations")
export class WorkflowChatController {
  constructor(@Inject(WorkflowChatService) private readonly chats: WorkflowChatService) {}

  @Get()
  list(@Req() request: IdentityTenantGatewayRequest,@Query('type') type?: string) {
    return this.respond(request,actor=>this.chats.list(actor,type));
  }
  @Post()
  create(@Req() request: IdentityTenantGatewayRequest,@Body() body: unknown) {
    return this.respond(request,actor=>this.chats.create(actor,CreateWorkflowChatRequestSchema.parse(body)));
  }
  @Get(':conversationId')
  get(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string) {
    return this.respond(request,actor=>this.chats.get(actor,id));
  }
  @Get(':conversationId/messages')
  messages(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string) {
    return this.respond(request,actor=>this.chats.messages(actor,id));
  }
  @Post(':conversationId/messages')
  begin(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string,@Body() body: unknown) {
    return this.respond(request,actor=>this.chats.begin(actor,id,body));
  }
  @Post(':conversationId/replies')
  reply(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string,@Body() body: unknown) {
    return this.respond(request,actor=>{
      const input=replySchema.parse(body);return this.chats.reply(actor,id,input.userMessageId,input.kind,input.content);
    });
  }
  @Post(':conversationId/answers')
  answer(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string,@Body() body: unknown) {
    return this.respond(request,actor=>{
      const input=answerSchema.parse(body);return this.chats.answer(actor,id,input.userMessageId,input.snapshot);
    });
  }
  @Post(':conversationId/archive')
  archive(@Req() request: IdentityTenantGatewayRequest,@Param('conversationId') id: string) {
    return this.respond(request,actor=>this.chats.archive(actor,id));
  }

  private async respond<T>(request: IdentityTenantGatewayRequest,operation:(actor:NonNullable<IdentityTenantGatewayRequest['actorContext']>)=>Promise<T>):Promise<T> {
    try {
      if(!request.actorContext)throw new WorkflowChatError(500,'CHAT_CONTEXT_MISSING','Authenticated caller context is missing');
      return await operation(request.actorContext);
    } catch(error:unknown) {
      const status=error instanceof WorkflowChatError?error.status:error instanceof WorkflowNotFoundError?404:error instanceof ZodError||error instanceof WorkflowValidationError?400:500;
      const code=error instanceof WorkflowChatError?error.code:status===404?'CHAT_NOT_FOUND':status===400?'INVALID_CHAT_REQUEST':'INTERNAL_ERROR';
      throw new HttpException({type:'about:blank',title:status===500?'Internal Server Error':'Chat request failed',status,detail:status===500?'Chat request could not complete':error instanceof Error?error.message:'Invalid chat request',instance:request.url,error_code:code,trace_id:`trc_${uuidV7()}`,request_id:`req_${uuidV7()}`,retryable:status>=500},status);
    }
  }
}
