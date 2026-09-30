import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { EngineResponse } from "../engine";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { RunHttpError } from "./problem";
import { RunExceptionFilter } from "./run-exception.filter";
import { RunService } from "./run.service";
import type {
  EnginePage,
  EngineResource,
  RunDetail,
  EngineRunEstimate,
} from "./types";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const operateRoles = ["admin", "editor", "operator"] as const;

@Controller("/api/v1/runs")
@UseFilters(RunExceptionFilter)
export class RunController {
  constructor(private readonly runs: RunService) {}

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async create(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    return project(
      await this.runs.create(
        body,
        requireActor(actor, "/api/v1/runs"),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async list(
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnginePage<EngineResource>> {
    return project(
      await this.runs.list(
        query,
        requireActor(actor, "/api/v1/runs"),
        traceparent,
      ),
      reply,
    );
  }

  @Get("estimate")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async estimate(
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineRunEstimate> {
    return project(
      await this.runs.estimate(
        query,
        requireActor(actor, "/api/v1/runs/estimate"),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":runId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async detail(
    @Param("runId") runId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RunDetail> {
    return project(
      await this.runs.detail(
        runId,
        requireActor(actor, `/api/v1/runs/${runId}`),
        traceparent,
      ),
      reply,
    );
  }

  @Post(":runId/actions/cancel")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async cancel(
    @Param("runId") runId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    const instance = `/api/v1/runs/${runId}/actions/cancel`;
    return project(
      await this.runs.cancel(
        runId,
        body,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Post(":runId/actions/retry-node")
  @RequireWorkspaceRole(...operateRoles)
  @Idempotent()
  async retryNode(
    @Param("runId") runId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    const instance = `/api/v1/runs/${runId}/actions/retry-node`;
    return project(
      await this.runs.retryNode(
        runId,
        body,
        requireActor(actor, instance),
        traceparent,
        idempotencyKey!,
      ),
      reply,
    );
  }

  @Get(":runId/verification-results")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async verificationResults(
    @Param("runId") runId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<readonly EngineResource[]> {
    return this.runs.verificationResults(
      runId,
      requireActor(actor, `/api/v1/runs/${runId}/verification-results`),
      traceparent,
    );
  }

  @Get(":runId/recovery-actions")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async recoveryActions(
    @Param("runId") runId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ): Promise<readonly EngineResource[]> {
    return this.runs.recoveryActions(
      runId,
      requireActor(actor, `/api/v1/runs/${runId}/recovery-actions`),
      traceparent,
    );
  }

}

@Controller("/api/v1/artifacts")
@UseFilters(RunExceptionFilter)
export class ArtifactController {
  constructor(private readonly runs: RunService) {}

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async list(
    @Query() query: unknown,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnginePage<EngineResource>> {
    return project(
      await this.runs.artifacts(
        query,
        requireActor(actor, "/api/v1/artifacts"),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":artifactId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async metadata(
    @Param("artifactId") artifactId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    const instance = `/api/v1/artifacts/${artifactId}`;
    return project(
      await this.runs.artifact(
        artifactId,
        requireActor(actor, instance),
        traceparent,
      ),
      reply,
    );
  }

  @Get(":artifactId/download")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async download(
    @Param("artifactId") artifactId: string,
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EngineResource> {
    const instance = `/api/v1/artifacts/${artifactId}/download`;
    return project(
      await this.runs.artifactDownload(
        artifactId,
        requireActor(actor, instance),
        traceparent,
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
    throw new RunHttpError(
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
