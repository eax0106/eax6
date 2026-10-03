import { Body, Controller, Get, Headers, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ActorContext, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { MemorySettingsService } from "./memory-settings.service";

@Controller("/api/v1/memory-settings")
export class MemorySettingsController {
  constructor(private readonly settings: MemorySettingsService) {}

  @Get()
  @RequireWorkspaceRole("admin", "editor", "operator", "approver", "viewer")
  async get(@ActorContext() actor: ActorContextType | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.settings.get(actor); reply.header("etag", result.etag); return result;
  }

  @Put()
  @RequireWorkspaceRole("admin")
  async set(
    @ActorContext() actor: ActorContextType | undefined, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined, @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.settings.set(actor, body, ifMatch); reply.header("etag", result.etag); return result;
  }
}
