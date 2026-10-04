import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { HostedFormSetup } from "@alterx/contracts";
import { EtagConstrained, EtagResponseInterceptor } from "../concurrency";
import type { EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { TriggerHttpError } from "./problem";
import { TriggerExceptionFilter } from "./trigger-exception.filter";
import { TriggerService } from "./trigger.service";
import type {
  RegisterTriggerResult,
  Trigger,
  TriggerListResult,
  TriggerVersion,
} from "./types";
import {
  parseCreateTrigger,
  parseCreateTriggerVersion,
  parseSetTriggerStatus,
} from "./validation";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;
const operateRoles = ["admin", "editor", "operator"] as const;
const privilegedRoles = ["admin"] as const;

@Controller("/api/v1/triggers")
@UseFilters(TriggerExceptionFilter)
export class TriggerController {
  constructor(private readonly triggers: TriggerService) {}

  @Get(":id/public-form")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("workflows:read")
  async publicForm(@Param("id") id: string, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Res({ passthrough: true }) reply: FastifyReply): Promise<HostedFormSetup> {
    const instance = `/api/v1/triggers/${id}/public-form`;
    return project(await this.triggers.publicForm(id, requireActor(actor, instance), traceparent), reply);
  }

  @Patch(":id/public-form/status")
  @RequireWorkspaceRole(...privilegedRoles)
  @RequirePermission("workflows:deploy")
  @Idempotent()
  async publicFormStatus(@Param("id") id: string, @Body() body: unknown, @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("if-match") ifMatch: string | undefined, @Res({ passthrough: true }) reply: FastifyReply): Promise<Trigger> {
    const instance = `/api/v1/triggers/${id}/public-form/status`;
    if (!ifMatch) throw new TriggerHttpError(428, "PRECONDITION_REQUIRED", "If-Match is required", instance);
    return project(await this.triggers.setPublicFormStatus(id, parseSetTriggerStatus(body, instance), requireActor(actor, instance), traceparent, idempotencyKey!, ifMatch), reply);
  }

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @RequirePermission("workflows:write")
  @Idempotent()
  async create(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RegisterTriggerResult> {
    const instance = "/api/v1/triggers";
    return project(
      await this.triggers.create(
        parseCreateTrigger(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("workflows:read")
  async list(
    @Query("workflowId") workflowId: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<TriggerListResult> {
    const instance = "/api/v1/triggers";
    return project(
      await this.triggers.list(
        workflowId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":id")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("workflows:read")
  @UseInterceptors(EtagResponseInterceptor)
  async get(
    @Param("id") id: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Trigger> {
    const instance = `/api/v1/triggers/${id}`;
    return project(
      await this.triggers.get(id, requireActor(actor, instance), traceparent),
      reply,
    );
  }

  @Post(":id/versions")
  @RequireWorkspaceRole(...writeRoles)
  @RequirePermission("workflows:write")
  @Idempotent()
  async createVersion(
    @Param("id") id: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers("if-match") ifMatch?: string,
  ): Promise<TriggerVersion> {
    const instance = `/api/v1/triggers/${id}/versions`;
    return project(
      await this.triggers.createVersion(
        id,
        parseCreateTriggerVersion(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
        ifMatch,
      ),
      reply,
    );
  }

  @Patch(":id/status")
  @RequireWorkspaceRole(...privilegedRoles)
  @RequirePermission("workflows:deploy")
  @EtagConstrained()
  @Idempotent()
  async setStatus(
    @Param("id") id: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Trigger> {
    const instance = `/api/v1/triggers/${id}/status`;
    return project(
      await this.triggers.setStatus(
        id,
        parseSetTriggerStatus(body, instance),
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
        ifMatch!,
      ),
      reply,
    );
  }

  @Post(":id/actions/enable")
  @RequireWorkspaceRole(...privilegedRoles)
  @RequirePermission("workflows:deploy")
  @Idempotent()
  async enable(
    @Param("id") id: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Trigger> {
    const instance = `/api/v1/triggers/${id}/actions/enable`;
    return project(
      await this.triggers.enable(
        id,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":id/actions/test")
  @RequireWorkspaceRole(...operateRoles)
  @RequirePermission("workflows:write")
  @Idempotent()
  async test(
    @Param("id") id: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const instance = `/api/v1/triggers/${id}/actions/test`;
    return project(
      await this.triggers.test(
        id,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":id/actions/rotate-webhook-secret")
  @RequireWorkspaceRole(...privilegedRoles)
  @RequirePermission("workflows:deploy")
  @Idempotent()
  async rotateWebhookSecret(
    @Param("id") id: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const instance = `/api/v1/triggers/${id}/actions/rotate-webhook-secret`;
    return project(
      await this.triggers.rotateWebhookSecret(
        id,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }
}

function requireActor(
  actor: ActorContextType | undefined,
  instance: string,
): ActorContextType {
  if (!actor) {
    throw new TriggerHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated actor required",
      instance,
    );
  }
  return actor;
}

function project<T>(response: EngineResponse<T>, reply: FastifyReply): T {
  reply.status(response.status);
  if (response.location) reply.header("Location", response.location);
  if (response.requestId) reply.header("request_id", response.requestId);
  if (response.traceId) reply.header("trace_id", response.traceId);
  return response.body;
}
