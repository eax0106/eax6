import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { ConnectionDetailPage } from "./connection-detail"
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
it("reconnect button authorizes the stored live identity", async () => {
  const id = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab", assign = vi.fn()
  const request = vi.fn<typeof fetch>(async input => {
    const url = String(input)
    if (url.endsWith("/authorize")) return Response.json({ authorize_url: "https://github.com/login/oauth/authorize?state=native", state: "native", expires_at: "2099-10-06T10:00:00.000Z" })
    return Response.json(url.endsWith("/integrations") ? [{ id: "github", display_name: "GitHub", configured: true, scopes: ["repo"] }]
      : { id, connector: "github", status: "revoked", created_at: "2026-10-06T10:00:00Z", version: "2026-10-06T10:00:00Z" })
  })
  vi.stubGlobal("fetch", request)
  vi.stubGlobal("location", { origin: "http://localhost:5173", pathname: `/app/connections/${id}`, search: "", hash: "", assign })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[`/app/connections/${id}`]}>
    <Routes><Route path="/app/connections/:id" element={<ConnectionDetailPage />} /></Routes>
  </MemoryRouter></QueryClientProvider>)
  await userEvent.setup().click(await screen.findByRole("button", { name: "Reconnect" }))
  await waitFor(() => expect(assign).toHaveBeenCalledOnce())
  const call = request.mock.calls.find(([url]) => String(url).endsWith("/authorize"))!
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ connection_id: id })
})
