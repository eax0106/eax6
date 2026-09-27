import { describe, expect, it, vi } from "vitest";
import type { IntegrationService } from "../integrations/integration.service";
import { GitHubRepositoryClient } from "./github-repository-client";
import { RepositoryHttpError } from "./problem";
import type {
  NewRepositoryBinding,
  RepositoryBindingRepository,
} from "./repository-binding.repository";
import { RepositoryService } from "./repository.service";
import type { RepositoryBindingRecord } from "./types";

const actor = {
  tenantId: "00000000-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-0000000000a1",
  userId: "usr_1",
};
const connectionId = "00000000-0000-7000-8000-0000000000c1";
const instance = "/api/v1/repositories";

class MemoryBindings {
  readonly rows: RepositoryBindingRecord[] = [];
  async insert(binding: NewRepositoryBinding): Promise<RepositoryBindingRecord | undefined> {
    if (this.rows.some((row) => row.workspaceId === binding.workspaceId && row.externalId === binding.externalId)) {
      return undefined;
    }
    const record = { ...binding, createdAt: new Date(0), updatedAt: new Date(0) };
    this.rows.push(record);
    return record;
  }
  async list(tenantId: string, workspaceId: string) {
    return this.rows.filter((row) => row.tenantId === tenantId && row.workspaceId === workspaceId);
  }
  async find(tenantId: string, workspaceId: string, id: string) {
    return this.rows.find((row) => row.tenantId === tenantId && row.workspaceId === workspaceId && row.id === id);
  }
  async delete(tenantId: string, workspaceId: string, id: string) {
    const index = this.rows.findIndex((row) => row.tenantId === tenantId && row.workspaceId === workspaceId && row.id === id);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

function fakeGitHub(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const path = url.replace("https://api.github.com", "");
    const route = routes[path];
    if (!route) return new Response("{}", { status: 404 });
    return Response.json(route.body ?? {}, { status: route.status });
  });
  return { client: new GitHubRepositoryClient(fetchImpl), calls };
}

function service(routes: Record<string, { status: number; body?: unknown }>) {
  const bindings = new MemoryBindings();
  const accessTokenFor = vi.fn(async () => "gho_workspace_token");
  const integrations = { accessTokenFor } as unknown as IntegrationService;
  const github = fakeGitHub(routes);
  return {
    bindings,
    accessTokenFor,
    calls: github.calls,
    service: new RepositoryService(
      bindings as unknown as RepositoryBindingRepository,
      integrations,
      github.client,
    ),
  };
}

const repo = {
  id: 42,
  full_name: "alterx/engine",
  default_branch: "main",
  private: true,
  html_url: "https://github.com/alterx/engine",
};

describe("RepositoryService", () => {
  it("binds a repository the connection can see, storing identifiers but no token", async () => {
    const { service: repositories, bindings, accessTokenFor, calls } = service({
      "/repos/alterx/engine": { status: 200, body: repo },
    });
    const view = await repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance);

    expect(view).toMatchObject({ full_name: "alterx/engine", default_branch: "main", private: true, connection_id: connectionId });
    expect(view.id).toMatch(/^rep_[0-9a-f-]{36}$/);
    expect(accessTokenFor).toHaveBeenCalledWith(
      actor.tenantId, actor.workspaceId, connectionId, "github", "usr_1", "repository_access", instance,
    );
    expect(calls[0]?.authorization).toBe("Bearer gho_workspace_token");
    expect(bindings.rows[0]?.externalId).toBe("42");
    expect(JSON.stringify(bindings.rows)).not.toContain("gho_workspace_token");
  });

  it("stores nothing when the connection cannot see the repository", async () => {
    const { service: repositories, bindings } = service({});
    await expect(
      repositories.bind(actor, { connection_id: connectionId, full_name: "someone/private" }, instance),
    ).rejects.toMatchObject({ status: 404 });
    expect(bindings.rows).toHaveLength(0);
  });

  it("refuses to bind the same repository twice in one workspace", async () => {
    const { service: repositories } = service({ "/repos/alterx/engine": { status: 200, body: repo } });
    await repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance);
    await expect(
      repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reads branches and open pull requests live by GitHub's repository id", async () => {
    const { service: repositories, calls } = service({
      "/repos/alterx/engine": { status: 200, body: repo },
      "/repositories/42/branches?per_page=100": {
        status: 200,
        body: [{ name: "main", commit: { sha: "abc" }, protected: true }],
      },
      "/repositories/42/pulls?state=open&per_page=50": {
        status: 200,
        body: [{
          number: 7, title: "Add repo manager", state: "open", draft: false, user: { login: "havish" },
          head: { ref: "feat" }, base: { ref: "main" }, html_url: "https://github.com/alterx/engine/pull/7",
          updated_at: "2026-09-28T00:00:00Z",
        }],
      },
    });
    const bound = await repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance);

    expect(await repositories.branches(actor, bound.id, instance)).toEqual([
      { name: "main", commit_sha: "abc", protected: true },
    ]);
    expect(await repositories.pullRequests(actor, bound.id, instance)).toEqual([
      expect.objectContaining({ number: 7, author: "havish", head_branch: "feat", base_branch: "main" }),
    ]);
    expect(calls.map((call) => call.url)).toContain("https://api.github.com/repositories/42/branches?per_page=100");
  });

  it("does not reach another workspace's binding", async () => {
    const { service: repositories } = service({ "/repos/alterx/engine": { status: 200, body: repo } });
    const bound = await repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance);
    const other = { ...actor, workspaceId: "00000000-0000-7000-8000-0000000000a2" };
    await expect(repositories.get(other, bound.id, instance)).rejects.toMatchObject({ status: 404 });
    await expect(repositories.unbind(other, bound.id, instance)).rejects.toMatchObject({ status: 404 });
    expect(await repositories.list(other)).toEqual([]);
  });

  it("unbinds the link only", async () => {
    const { service: repositories, calls } = service({ "/repos/alterx/engine": { status: 200, body: repo } });
    const bound = await repositories.bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance);
    const before = calls.length;
    await repositories.unbind(actor, bound.id, instance);
    expect(await repositories.list(actor)).toEqual([]);
    expect(calls.length).toBe(before);
  });

  it("reports a rejected GitHub credential as a connection problem, not a missing repository", async () => {
    const { service: repositories } = service({ "/repos/alterx/engine": { status: 401 } });
    const error = await repositories
      .bind(actor, { connection_id: connectionId, full_name: "alterx/engine" }, instance)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepositoryHttpError);
    expect((error as RepositoryHttpError).getResponse()).toMatchObject({ error_code: "REPOSITORY_CONNECTION_REJECTED" });
  });
});
