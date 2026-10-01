import { Body, Controller, Get, Headers, Put, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ActorContext, RequirePermission, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { PlatformHttpError } from "../signup/problem";
import { RunRetentionRelayService } from "./run-retention.service";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const BASE = "/api/v1/run-retention";

/** D2: the current workspace's run-history retention (7 to 365 days). */
@Controller(BASE)
export class RunRetentionRelayController {
  constructor(private readonly retention: RunRetentionRelayService) {}

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("runs:read")
  async get(
    @ActorContext() actor: ActorContextType | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.retention.get(requireActor(actor), traceparent);
    reply.header("ETag", view.etag);
    return view;
  }

  // How many runs a lower setting would delete, shown before confirming.
  @Get("preview")
  @RequireWorkspaceRole("admin")
  @RequirePermission("runs:retention:write")
  preview(
    @ActorContext() actor: ActorContextType | undefined,
    @Query("retention_days") retentionDays: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ) {
    return this.retention.preview(requireActor(actor), retentionDays, traceparent);
  }

  @Put()
  @RequireWorkspaceRole("admin")
  @RequirePermission("runs:retention:write")
  async set(
    @ActorContext() actor: ActorContextType | undefined,
    @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.retention.set(requireActor(actor), body, ifMatch, traceparent);
    reply.header("ETag", view.etag);
    return view;
  }
}

function requireActor(actor: ActorContextType | undefined): ActorContextType {
  if (!actor) throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", BASE);
  if (!actor.workspace_id) {
    throw new PlatformHttpError(403, "RUN_RETENTION_WORKSPACE_REQUIRED", "Workspace actor context required", BASE);
  }
  return actor;
}
