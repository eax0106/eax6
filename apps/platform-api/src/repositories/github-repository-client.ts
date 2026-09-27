import { RepositoryHttpError } from "./problem";
import type { ProviderBranch, ProviderPullRequest, ProviderRepository } from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";

/**
 * Read-only GitHub REST client for the Repository Manager. It acts as the
 * workspace's own OAuth connection (the token is passed per call and never
 * stored here) and never writes to GitHub.
 *
 * Bound repositories are addressed by GitHub's numeric id (/repositories/:id),
 * not by owner/name, so a rename or transfer on GitHub keeps working.
 */
export class GitHubRepositoryClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async listAccessible(token: string, instance: string): Promise<ProviderRepository[]> {
    const body = await this.get<unknown[]>(
      token,
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      instance,
    );
    return body.map(toRepository);
  }

  async getByFullName(token: string, fullName: string, instance: string): Promise<ProviderRepository> {
    return toRepository(await this.get<unknown>(token, `/repos/${fullName}`, instance));
  }

  async listBranches(token: string, externalId: string, instance: string): Promise<ProviderBranch[]> {
    const body = await this.get<Array<Record<string, unknown>>>(
      token,
      `/repositories/${encodeURIComponent(externalId)}/branches?per_page=100`,
      instance,
    );
    return body.map((branch) => ({
      name: String(branch.name),
      commit_sha: String((branch.commit as Record<string, unknown> | undefined)?.sha ?? ""),
      protected: branch.protected === true,
    }));
  }

  async listOpenPullRequests(
    token: string,
    externalId: string,
    instance: string,
  ): Promise<ProviderPullRequest[]> {
    const body = await this.get<Array<Record<string, unknown>>>(
      token,
      `/repositories/${encodeURIComponent(externalId)}/pulls?state=open&per_page=50`,
      instance,
    );
    return body.map((pull) => {
      const head = pull.head as Record<string, unknown> | undefined;
      const base = pull.base as Record<string, unknown> | undefined;
      const user = pull.user as Record<string, unknown> | null | undefined;
      return {
        number: Number(pull.number),
        title: String(pull.title),
        state: pull.state === "closed" ? "closed" : "open",
        draft: pull.draft === true,
        author: typeof user?.login === "string" ? user.login : null,
        head_branch: String(head?.ref ?? ""),
        base_branch: String(base?.ref ?? ""),
        html_url: String(pull.html_url),
        updated_at: String(pull.updated_at),
      };
    });
  }

  private async get<T>(token: string, path: string, instance: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "alter-repository-manager",
        },
      });
    } catch {
      throw providerUnavailable(instance);
    }
    if (response.status === 404 || response.status === 403) {
      throw new RepositoryHttpError(
        404,
        "REPOSITORY_NOT_ACCESSIBLE",
        "The repository does not exist or this connection cannot see it",
        instance,
      );
    }
    if (response.status === 401) {
      throw new RepositoryHttpError(
        409,
        "REPOSITORY_CONNECTION_REJECTED",
        "GitHub rejected the connection's credential; reconnect it",
        instance,
      );
    }
    if (!response.ok) throw providerUnavailable(instance);
    return (await response.json()) as T;
  }
}

function toRepository(value: unknown): ProviderRepository {
  const repo = value as Record<string, unknown>;
  return {
    externalId: String(repo.id),
    fullName: String(repo.full_name),
    defaultBranch: String(repo.default_branch),
    private: repo.private === true,
    htmlUrl: String(repo.html_url),
  };
}

function providerUnavailable(instance: string): RepositoryHttpError {
  return new RepositoryHttpError(502, "REPOSITORY_PROVIDER_UNAVAILABLE", "GitHub could not be reached", instance);
}
