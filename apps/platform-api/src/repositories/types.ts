export type RepositoryProviderId = "github";

/** A workspace's stored link to one repository. Never holds a credential. */
export interface RepositoryBindingRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly provider: RepositoryProviderId;
  readonly connectionId: string;
  readonly externalId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RepositoryBindingView {
  readonly id: string;
  readonly provider: RepositoryProviderId;
  readonly connection_id: string;
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
  readonly html_url: string;
  readonly created_by: string;
  readonly created_at: string;
}

export interface BindRepositoryInput {
  readonly connection_id: string;
  readonly full_name: string;
}

/** What the provider says about a repository the connection can reach. */
export interface ProviderRepository {
  readonly externalId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
}

export interface ProviderBranch {
  readonly name: string;
  readonly commit_sha: string;
  readonly protected: boolean;
}

export interface ProviderPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly author: string | null;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly html_url: string;
  readonly updated_at: string;
}

export interface AvailableRepositoryView {
  readonly full_name: string;
  readonly default_branch: string;
  readonly private: boolean;
  readonly html_url: string;
}
