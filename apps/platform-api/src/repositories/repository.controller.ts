import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequirePermission,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { RepositoryHttpError } from "./problem";
import { type RepositoryActor, RepositoryService } from "./repository.service";
import type {
  AvailableRepositoryView,
  ProviderBranch,
  ProviderPullRequest,
  RepositoryBindingView,
} from "./types";
import { parseBindRepository, parseConnectionQuery, parseRepositoryId } from "./validation";

const readRoles = ["admin", "editor", "operator", "approver", "viewer"] as const;
const writeRoles = ["admin", "editor"] as const;
const BASE = "/api/v1/repositories";

@Controller(BASE)
export class RepositoryController {
  constructor(private readonly repositories: RepositoryService) {}

  @Get("available")
  @RequireWorkspaceRole(...writeRoles)
  @RequirePermission("integrations:read")
  available(
    @Query("connection_id") connectionId: string | undefined,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<AvailableRepositoryView[]> {
    const instance = `${BASE}/available`;
    return this.repositories.available(
      repositoryActor(actor, instance),
      parseConnectionQuery(connectionId, instance),
      instance,
    );
  }

  @Post()
  @HttpCode(201)
  @RequireWorkspaceRole(...writeRoles)
  @RequirePermission("integrations:write")
  @Idempotent()
  bind(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<RepositoryBindingView> {
    return this.repositories.bind(repositoryActor(actor, BASE), parseBindRepository(body, BASE), BASE);
  }

  @Get()
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("integrations:read")
  list(@ActorContext() actor: ActorContextType | undefined): Promise<RepositoryBindingView[]> {
    return this.repositories.list(repositoryActor(actor, BASE));
  }

  @Get(":repositoryId")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("integrations:read")
  get(
    @Param("repositoryId") repositoryId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<RepositoryBindingView> {
    const instance = `${BASE}/${repositoryId}`;
    return this.repositories.get(repositoryActor(actor, instance), parseRepositoryId(repositoryId, instance), instance);
  }

  @Get(":repositoryId/branches")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("integrations:read")
  branches(
    @Param("repositoryId") repositoryId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<ProviderBranch[]> {
    const instance = `${BASE}/${repositoryId}/branches`;
    return this.repositories.branches(
      repositoryActor(actor, instance),
      parseRepositoryId(repositoryId, instance),
      instance,
    );
  }

  @Get(":repositoryId/pulls")
  @RequireWorkspaceRole(...readRoles)
  @RequirePermission("integrations:read")
  pullRequests(
    @Param("repositoryId") repositoryId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<ProviderPullRequest[]> {
    const instance = `${BASE}/${repositoryId}/pulls`;
    return this.repositories.pullRequests(
      repositoryActor(actor, instance),
      parseRepositoryId(repositoryId, instance),
      instance,
    );
  }

  @Delete(":repositoryId")
  @HttpCode(204)
  @RequireWorkspaceRole(...writeRoles)
  @RequirePermission("integrations:write")
  async unbind(
    @Param("repositoryId") repositoryId: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<void> {
    const instance = `${BASE}/${repositoryId}`;
    await this.repositories.unbind(
      repositoryActor(actor, instance),
      parseRepositoryId(repositoryId, instance),
      instance,
    );
  }
}

function repositoryActor(actor: ActorContextType | undefined, instance: string): RepositoryActor {
  if (!actor) {
    throw new RepositoryHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
  }
  if (!actor.workspace_id) {
    throw new RepositoryHttpError(403, "REPOSITORY_WORKSPACE_REQUIRED", "Workspace actor context required", instance);
  }
  return { tenantId: actor.tenant_id, workspaceId: actor.workspace_id, userId: actor.user_id };
}
