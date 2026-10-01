import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ConcurrencyExceptionFilter, EtagResponseInterceptor } from "../concurrency";
import { EngineExceptionFilter } from "../engine";
import { ActorContext, RequireTenantRole } from "../rbac/decorators";
import type { ActorContext as Actor } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { WorkspaceDeletionService } from "./workspace-deletion.service";
import { WorkspaceSafeguardsService } from "./workspace-safeguards.service";
import { WorkspacesService, workspaceEtag } from "./workspaces.service";

@Controller("/api/v1/workspaces")
@RequireTenantRole("member")
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly safeguards: WorkspaceSafeguardsService,
    private readonly deletion: WorkspaceDeletionService,
  ) {}

  @Get()
  list(@ActorContext() actor?: Actor) {
    return this.workspaces.list(requireActor(actor));
  }

  // D2: workspaces waiting out their deletion window, for the restore entry.
  @Get("pending-deletion")
  @RequireTenantRole("admin")
  listPendingDeletion(@ActorContext() actor?: Actor) {
    return this.workspaces.listPendingDeletion(requireActor(actor));
  }

  @Post()
  @RequireTenantRole("admin")
  create(@ActorContext() actor: Actor | undefined, @Body() body: { name?: string }) {
    return this.workspaces.create(requireActor(actor), body.name ?? "");
  }

  @Get(":workspaceId")
  async get(
    @ActorContext() actor: Actor | undefined,
    @Param("workspaceId") workspaceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = await this.workspaces.get(requireActor(actor), workspaceId);
    reply.header("ETag", workspaceEtag(workspace)).send(workspace);
  }

  @Patch(":workspaceId")
  @RequireTenantRole("admin")
  @Header("Cache-Control", "no-store")
  async update(
    @ActorContext() actor: Actor | undefined,
    @Param("workspaceId") workspaceId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: { name?: string },
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const workspace = await this.workspaces.update(
      requireActor(actor),
      workspaceId,
      body.name ?? "",
      ifMatch,
    );
    reply.header("ETag", workspaceEtag(workspace)).send(workspace);
  }

  // D2: typed-name confirmation, then pending deletion with an undo window.
  @Delete(":workspaceId")
  @RequireTenantRole("admin")
  @UseFilters(EngineExceptionFilter)
  @Header("Cache-Control", "no-store")
  requestDeletion(
    @ActorContext() actor: Actor | undefined,
    @Param("workspaceId") workspaceId: string,
    @Body() body: { confirm_name?: unknown } | undefined,
  ) {
    return this.deletion.requestDeletion(requireActor(actor), workspaceId, body?.confirm_name);
  }

  @Post(":workspaceId/actions/restore")
  @RequireTenantRole("admin")
  @HttpCode(200)
  @UseFilters(EngineExceptionFilter)
  @Header("Cache-Control", "no-store")
  restore(@ActorContext() actor: Actor | undefined, @Param("workspaceId") workspaceId: string) {
    return this.deletion.restore(requireActor(actor), workspaceId);
  }

  @Get(":workspaceId/safeguards")
  @UseInterceptors(EtagResponseInterceptor)
  getSafeguards(@ActorContext() actor: Actor | undefined, @Param("workspaceId") workspaceId: string) {
    return this.safeguards.get(requireActor(actor), workspaceId);
  }

  // Organisational rules, so only a tenant owner changes them, as with
  // tenant data residency.
  @Put(":workspaceId/safeguards")
  @RequireTenantRole("owner")
  @UseInterceptors(EtagResponseInterceptor)
  @UseFilters(ConcurrencyExceptionFilter)
  setSafeguards(
    @ActorContext() actor: Actor | undefined,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.safeguards.set(requireActor(actor), workspaceId, body, ifMatch);
  }
}

function requireActor(actor: Actor | undefined): Actor {
  if (!actor) {
    throw new PlatformHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authenticated actor required",
      "/api/v1/workspaces",
    );
  }
  return actor;
}
