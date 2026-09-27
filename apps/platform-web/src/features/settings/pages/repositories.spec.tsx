import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { Connection, RepositoryBinding } from "@/api/types"

vi.mock("@/api/client", () => ({
  api: {
    getRepositories: vi.fn(),
    getConnections: vi.fn(),
    getAvailableRepositories: vi.fn(),
    bindRepository: vi.fn(),
    unbindRepository: vi.fn(),
    getRepositoryBranches: vi.fn(),
    getRepositoryPullRequests: vi.fn(),
  },
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { RepositorySettings } from "./repositories"

const github: Connection = {
  id: "00000000-0000-7000-8000-0000000000c1",
  integrationId: "github",
  name: "GitHub (havish)",
  status: "connected",
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
}
const binding: RepositoryBinding = {
  id: "rep_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
  connectionId: github.id,
  fullName: "alterx/engine",
  defaultBranch: "main",
  private: true,
  htmlUrl: "https://github.com/alterx/engine",
  createdAt: "2026-09-28T00:00:00Z",
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RepositorySettings />
    </QueryClientProvider>,
  )
}

describe("Repository settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getConnections).mockResolvedValue([
      github,
      { ...github, id: "00000000-0000-7000-8000-0000000000c2", integrationId: "google", name: "Google" },
    ])
    vi.mocked(api.getRepositories).mockResolvedValue([])
    vi.mocked(api.getAvailableRepositories).mockResolvedValue([
      { fullName: "alterx/engine", defaultBranch: "main", private: true, htmlUrl: binding.htmlUrl },
    ])
    vi.mocked(api.bindRepository).mockResolvedValue(binding)
    vi.mocked(api.getRepositoryBranches).mockResolvedValue([{ name: "main", commitSha: "abc", protected: true }])
    vi.mocked(api.getRepositoryPullRequests).mockResolvedValue([
      {
        number: 7, title: "Add repo manager", draft: false, author: "havish", headBranch: "feat",
        baseBranch: "main", htmlUrl: "https://github.com/alterx/engine/pull/7", updatedAt: "2026-09-28T00:00:00Z",
      },
    ])
  })
  afterEach(() => cleanup())

  it("links a repository read through a GitHub connection, offering only GitHub connections", async () => {
    renderPage()
    const connectionSelect = await screen.findByLabelText("GitHub connection")
    expect(within(connectionSelect).queryByText("Google")).toBeNull()
    await userEvent.selectOptions(connectionSelect, github.id)
    await waitFor(() => expect(api.getAvailableRepositories).toHaveBeenCalledWith(github.id))
    await userEvent.selectOptions(await screen.findByLabelText("Repository"), "alterx/engine")
    await userEvent.click(screen.getByRole("button", { name: "Link" }))
    await waitFor(() => expect(api.bindRepository).toHaveBeenCalledWith(github.id, "alterx/engine"))
  })

  it("shows a linked repository's live branches and open pull requests, and unlinks it", async () => {
    vi.mocked(api.getRepositories).mockResolvedValue([binding])
    renderPage()
    expect(await screen.findByText("#7 Add repo manager")).toBeTruthy()
    expect(await screen.findByText(/main \(default\)/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Unlink alterx/engine" }))
    await waitFor(() => expect(api.unbindRepository).toHaveBeenCalledWith(binding.id))
  })

  it("says to connect GitHub first when there is no GitHub connection", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([])
    renderPage()
    expect(await screen.findByText(/Connect GitHub under Integrations first/)).toBeTruthy()
  })
})
