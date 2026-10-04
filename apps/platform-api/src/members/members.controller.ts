import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import { ActorContext, RequireTenantRole } from "../rbac/decorators";
import type { ActorContext as Actor } from "../rbac/types";
import { PlatformHttpError } from "../signup/problem";
import { MembersService } from "./members.service";
import { WorkspaceInvitationsService } from "./workspace-invitations.service";

@Controller("/api/v1/members")
@RequireTenantRole("member")
export class MembersController {
  constructor(private readonly members: MembersService, private readonly invitations: WorkspaceInvitationsService) {}

  @Get()
  list(@ActorContext() actor: Actor | undefined, @Query("workspaceId") workspaceId?: string) {
    return this.members.list(requireActor(actor), workspaceId);
  }

  @Post()
  invite(@ActorContext() actor: Actor | undefined, @Body() body: unknown) {
    return this.members.invite(requireActor(actor), body);
  }

  @Get("invitations")
  listInvitations(@ActorContext() actor: Actor | undefined, @Query("workspaceId") workspaceId?: string) {
    if (!workspaceId) throw new PlatformHttpError(400, "WORKSPACE_REQUIRED", "workspaceId required", "/api/v1/members/invitations");
    return this.invitations.list(requireActor(actor), workspaceId);
  }

  @Post("invitations/:invitationId/resend")
  resend(@ActorContext() actor: Actor | undefined, @Param("invitationId") invitationId: string, @Headers("if-match") ifMatch?: string) {
    return this.invitations.resend(requireActor(actor), invitationId, ifMatch);
  }

  @Delete("invitations/:invitationId")
  revoke(@ActorContext() actor: Actor | undefined, @Param("invitationId") invitationId: string, @Headers("if-match") ifMatch?: string) {
    return this.invitations.revoke(requireActor(actor), invitationId, ifMatch);
  }

  @Patch(":memberId")
  updateRole(@ActorContext() actor: Actor | undefined, @Param("memberId") memberId: string, @Body() body: unknown, @Headers("if-match") ifMatch?: string) {
    return this.members.updateRole(requireActor(actor), memberId, body, ifMatch);
  }

  @Delete(":memberId")
  async remove(@ActorContext() actor: Actor | undefined, @Param("memberId") memberId: string,
    @Query("scope") scope = "workspace", @Headers("if-match") ifMatch?: string): Promise<void> {
    await this.members.remove(requireActor(actor), memberId, scope, ifMatch);
  }
}

function requireActor(actor: Actor | undefined): Actor {
  if (!actor) throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", "/api/v1/members");
  return actor;
}
