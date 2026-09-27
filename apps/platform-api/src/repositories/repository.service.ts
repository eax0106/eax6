import { Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { IntegrationService } from "../integrations/integration.service";
import { GitHubRepositoryClient } from "./github-repository-client";
import { RepositoryHttpError, repositoryNotFound } from "./problem";
import { RepositoryBindingRepository } from "./repository-binding.repository";
import type {
  AvailableRepositoryView,
  BindRepositoryInput,
  ProviderBranch,
  ProviderPullRequest,
  RepositoryBindingRecord,
  RepositoryBindingView,
} from "./types";

export interface RepositoryActor {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * Repository Manager (C9, task 5.2), standalone: a workspace links GitHub
 * repositories its own GitHub connection can reach, then reads their branches
 * and open pull requests live. It stores identifiers, never tokens, and never
 * writes to GitHub.
 */
@Injectable()
export class RepositoryService {
  constructor(
    private readonly bindings: RepositoryBindingRepository,
    private readonly integrations: IntegrationService,
    private readonly github: GitHubRepositoryClient,
  ) {}

  async available(
    actor: RepositoryActor,
    connectionId: string,
    instance: string,
  ): Promise<AvailableRepositoryView[]> {
    const token = await this.token(actor, connectionId, instance);
    return (await this.github.listAccessible(token, instance)).map((repo) => ({
      full_name: repo.fullName,
      default_branch: repo.defaultBranch,
      private: repo.private,
      html_url: repo.htmlUrl,
    }));
  }

  async bind(
    actor: RepositoryActor,
    input: BindRepositoryInput,
    instance: string,
  ): Promise<RepositoryBindingView> {
    const token = await this.token(actor, input.connection_id, instance);
    // Confirm the connection can see it before anything is stored: a binding
    // to a repository nobody can read would be a link that only ever fails.
    const repo = await this.github.getByFullName(token, input.full_name, instance);
    const created = await this.bindings.insert({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      id: `rep_${uuidv7()}`,
      provider: "github",
      connectionId: input.connection_id,
      externalId: repo.externalId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      htmlUrl: repo.htmlUrl,
      createdBy: actor.userId,
    });
    if (!created) {
      throw new RepositoryHttpError(
        409,
        "REPOSITORY_ALREADY_BOUND",
        `${repo.fullName} is already linked to this workspace`,
        instance,
      );
    }
    return project(created);
  }

  async list(actor: RepositoryActor): Promise<RepositoryBindingView[]> {
    return (await this.bindings.list(actor.tenantId, actor.workspaceId)).map(project);
  }

  async get(actor: RepositoryActor, id: string, instance: string): Promise<RepositoryBindingView> {
    return project(await this.require(actor, id, instance));
  }

  async branches(actor: RepositoryActor, id: string, instance: string): Promise<ProviderBranch[]> {
    const binding = await this.require(actor, id, instance);
    const token = await this.token(actor, binding.connectionId, instance);
    return this.github.listBranches(token, binding.externalId, instance);
  }

  async pullRequests(
    actor: RepositoryActor,
    id: string,
    instance: string,
  ): Promise<ProviderPullRequest[]> {
    const binding = await this.require(actor, id, instance);
    const token = await this.token(actor, binding.connectionId, instance);
    return this.github.listOpenPullRequests(token, binding.externalId, instance);
  }

  /** Removes the link only. Nothing on GitHub changes. */
  async unbind(actor: RepositoryActor, id: string, instance: string): Promise<void> {
    if (!(await this.bindings.delete(actor.tenantId, actor.workspaceId, id))) {
      throw repositoryNotFound(instance);
    }
  }

  private async require(
    actor: RepositoryActor,
    id: string,
    instance: string,
  ): Promise<RepositoryBindingRecord> {
    const binding = await this.bindings.find(actor.tenantId, actor.workspaceId, id);
    if (!binding) throw repositoryNotFound(instance);
    return binding;
  }

  private token(actor: RepositoryActor, connectionId: string, instance: string): Promise<string> {
    return this.integrations.accessTokenFor(
      actor.tenantId,
      actor.workspaceId,
      connectionId,
      "github",
      actor.userId,
      "repository_access",
      instance,
    );
  }
}

function project(record: RepositoryBindingRecord): RepositoryBindingView {
  return {
    id: record.id,
    provider: record.provider,
    connection_id: record.connectionId,
    full_name: record.fullName,
    default_branch: record.defaultBranch,
    private: record.private,
    html_url: record.htmlUrl,
    created_by: record.createdBy,
    created_at: record.createdAt.toISOString(),
  };
}
