import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, GitBranch, GitPullRequest, Loader2, Lock, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { RepositoryBinding } from "@/api/types"
import { Button } from "@/components/ui/button"

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Repository Manager (task 5.2): link GitHub repositories this workspace's own
 * GitHub connection can reach, then see their branches and open pull requests.
 * Linking stores the repository's identity only; nothing is written to GitHub.
 */
export function RepositorySettings() {
  const queryClient = useQueryClient()
  const [connectionId, setConnectionId] = React.useState("")
  const [fullName, setFullName] = React.useState("")

  const bindings = useQuery({ queryKey: queryKeys.repositories.list, queryFn: () => api.getRepositories() })
  const connections = useQuery({ queryKey: ["connections", "github"], queryFn: () => api.getConnections() })
  const githubConnections = (connections.data ?? []).filter(
    (connection) => connection.integrationId === "github" && connection.status === "connected",
  )
  const available = useQuery({
    queryKey: queryKeys.repositories.available(connectionId),
    queryFn: () => api.getAvailableRepositories(connectionId),
    enabled: connectionId !== "",
  })

  const bind = useMutation({
    mutationFn: () => api.bindRepository(connectionId, fullName),
    onSuccess: (binding) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list })
      setFullName("")
      toast.success(`${binding.fullName} linked`)
    },
    onError: (error) => toast.error(errorText(error, "Could not link the repository")),
  })

  const unbind = useMutation({
    mutationFn: (id: string) => api.unbindRepository(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.list })
      toast.success("Repository unlinked. Nothing on GitHub changed.")
    },
    onError: (error) => toast.error(errorText(error, "Could not unlink the repository")),
  })

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Repositories</h1>
        <p className="mt-2 text-text-secondary">
          Link GitHub repositories through this workspace&apos;s GitHub connection to see their branches and open pull
          requests. Linking never changes anything on GitHub.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-surface p-6 space-y-4" aria-label="Link a repository">
        <h2 className="text-lg font-semibold text-text-primary">Link a repository</h2>
        {connections.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        ) : githubConnections.length === 0 ? (
          <p className="text-sm text-text-muted">
            Connect GitHub under Integrations first; repositories are read as that connection.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              GitHub connection
              <select
                aria-label="GitHub connection"
                className="rounded-md border border-border bg-surface px-3 py-2 text-text-primary"
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value)
                  setFullName("")
                }}
              >
                <option value="">Choose a connection</option>
                {githubConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-secondary">
              Repository
              <select
                aria-label="Repository"
                className="rounded-md border border-border bg-surface px-3 py-2 text-text-primary"
                value={fullName}
                disabled={!connectionId || available.isLoading}
                onChange={(event) => setFullName(event.target.value)}
              >
                <option value="">{available.isLoading ? "Loading…" : "Choose a repository"}</option>
                {(available.data ?? []).map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? " (private)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => bind.mutate()} disabled={!connectionId || !fullName || bind.isPending}>
              {bind.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Link"}
            </Button>
            {available.isError && (
              <p className="w-full text-sm text-red-600">
                {errorText(available.error, "Repositories could not be read from GitHub")}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4" aria-label="Linked repositories">
        {bindings.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        ) : bindings.isError ? (
          <p className="text-sm text-red-600">{errorText(bindings.error, "Linked repositories could not be loaded")}</p>
        ) : (bindings.data ?? []).length === 0 ? (
          <p className="text-sm text-text-muted">No repositories linked yet.</p>
        ) : (
          (bindings.data ?? []).map((binding) => (
            <RepositoryCard
              key={binding.id}
              binding={binding}
              onUnlink={() => unbind.mutate(binding.id)}
              unlinking={unbind.isPending && unbind.variables === binding.id}
            />
          ))
        )}
      </section>
    </div>
  )
}

function RepositoryCard({
  binding,
  onUnlink,
  unlinking,
}: {
  binding: RepositoryBinding
  onUnlink: () => void
  unlinking: boolean
}) {
  const branches = useQuery({
    queryKey: queryKeys.repositories.branches(binding.id),
    queryFn: () => api.getRepositoryBranches(binding.id),
  })
  const pulls = useQuery({
    queryKey: queryKeys.repositories.pulls(binding.id),
    queryFn: () => api.getRepositoryPullRequests(binding.id),
  })

  return (
    <article className="rounded-xl border border-border bg-surface p-6" aria-label={binding.fullName}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <a
            href={binding.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-text-primary hover:underline"
          >
            {binding.fullName}
          </a>
          {binding.private && <Lock className="h-4 w-4 text-text-muted" aria-label="Private" />}
          <ExternalLink className="h-3.5 w-3.5 text-text-muted" />
        </div>
        <Button variant="outline" size="sm" onClick={onUnlink} disabled={unlinking} aria-label={`Unlink ${binding.fullName}`}>
          {unlinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
      </div>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
            <GitBranch className="h-4 w-4" /> Branches
          </h3>
          {branches.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          ) : branches.isError ? (
            <p className="text-sm text-red-600">{errorText(branches.error, "Branches could not be read")}</p>
          ) : (
            <ul className="space-y-1 text-sm text-text-primary">
              {(branches.data ?? []).map((branch) => (
                <li key={branch.name}>
                  {branch.name}
                  {branch.name === binding.defaultBranch ? " (default)" : ""}
                  {branch.protected ? " · protected" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
            <GitPullRequest className="h-4 w-4" /> Open pull requests
          </h3>
          {pulls.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          ) : pulls.isError ? (
            <p className="text-sm text-red-600">{errorText(pulls.error, "Pull requests could not be read")}</p>
          ) : (pulls.data ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">None open.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(pulls.data ?? []).map((pull) => (
                <li key={pull.number}>
                  <a href={pull.htmlUrl} target="_blank" rel="noreferrer" className="text-text-primary hover:underline">
                    #{pull.number} {pull.title}
                  </a>
                  <span className="text-text-muted">
                    {" "}
                    {pull.headBranch} → {pull.baseBranch}
                    {pull.draft ? " · draft" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  )
}
