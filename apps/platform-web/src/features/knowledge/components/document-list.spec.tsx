import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { queryKeys } from "@/api/query-keys"
import { DocumentList } from "./document-list"

vi.mock("@/api/http", async importOriginal => ({ ...await importOriginal<typeof import("@/api/http")>(), isLiveApi: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const documents = [
  { id: "doc_one", source_id: "src_one", title: "First document", status: "active", created_at: "2026-09-30T10:00:00Z" },
  { id: "doc_two", source_id: "src_one", title: "Second document", status: "active", created_at: "2026-09-30T10:00:00Z" },
]

function setup(confirm: boolean, failure = false, pending?: Promise<void>) {
  let deleted = false
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (init?.method === "DELETE") {
      expect(String(url)).toBe("/api/v1/ads/documents/doc_one")
      await pending
      if (failure) return Response.json({ message: "Deletion refused", code: "forbidden" }, { status: 403 })
      deleted = true
      return new Response(null, { status: 204 })
    }
    return Response.json({ data: deleted ? documents.slice(1) : documents })
  })
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("confirm", vi.fn(() => confirm))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.knowledge.sources.detail("src_one"), { documentCount: 2 })
  client.setQueryData(queryKeys.knowledge.sources.list, [{ id: "src_one", documentCount: 2 }])
  client.setQueryData(queryKeys.knowledge.chunks("src_one", "doc_one"), [{ id: "chunk_one" }])
  const select = vi.fn()
  render(<QueryClientProvider client={client}><DocumentList sourceId="src_one" onSelectDocument={select} /></QueryClientProvider>)
  return { client, fetchMock, select }
}

async function deleteButton() {
  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete First document" })).not.toBeNull())
  return screen.getByRole("button", { name: "Delete First document" })
}

it("cancels deletion without selecting or mutating the document", async () => {
  const { fetchMock, select } = setup(false)
  await userEvent.setup().click(await deleteButton())
  expect(window.confirm).toHaveBeenCalledWith('Delete "First document" and all its indexed content? This cannot be undone.')
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false)
  expect(select).not.toHaveBeenCalled()
  expect(screen.getByText("First document")).toBeDefined()
})

it("deletes the selected document, prevents duplicates and refreshes documents and source counts", async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const { client, fetchMock, select } = setup(true, false, pending)
  await userEvent.setup().click(await deleteButton())
  await waitFor(() => expect((screen.getByRole("button", { name: "Delete First document" }) as HTMLButtonElement).disabled).toBe(true))
  expect((screen.getByRole("button", { name: "Delete Second document" }) as HTMLButtonElement).disabled).toBe(true)
  finish()
  await waitFor(() => expect(screen.queryByText("First document")).toBeNull())
  expect(screen.getByText("Second document")).toBeDefined()
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1)
  expect(client.getQueryState(queryKeys.knowledge.sources.detail("src_one"))?.isInvalidated).toBe(true)
  expect(client.getQueryState(queryKeys.knowledge.sources.list)?.isInvalidated).toBe(true)
  expect(client.getQueryData(queryKeys.knowledge.chunks("src_one", "doc_one"))).toBeUndefined()
  expect(select).not.toHaveBeenCalled()
})

it("keeps the document and exposes the server error when deletion fails", async () => {
  setup(true, true)
  await userEvent.setup().click(await deleteButton())
  await waitFor(() => expect(screen.queryByRole("alert")?.textContent).toContain("Deletion refused"))
  expect(screen.getByText("First document")).toBeDefined()
  expect(screen.getByText("Second document")).toBeDefined()
  expect((screen.getByRole("button", { name: "Delete First document" }) as HTMLButtonElement).disabled).toBe(false)
})
