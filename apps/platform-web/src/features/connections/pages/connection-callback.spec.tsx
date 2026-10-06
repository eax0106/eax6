import { StrictMode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, expect, it, vi } from "vitest"
import { beginConnection } from "@/api/live-connections"
import { ConnectionCallbackPage } from "./connection-callback"
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState(null, "", "/") })

it.each([true, false])("real callback completes once under StrictMode, engine synchronized=%s", async synchronized => {
  const nativeLocation = window.location
  const id = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
  const request = vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith("/authorize")
    ? { authorize_url: "https://github.com/login/oauth/authorize?state=native", state: "native", expires_at: "2099-10-06T10:00:00.000Z" }
    : { id, connector: "github", status: "connected", engine_synced: synchronized }))
  vi.stubGlobal("fetch", request)
  vi.stubGlobal("location", { origin: "http://localhost:5173", pathname: "/app/connections", search: "", hash: "", assign: vi.fn() })
  await beginConnection("github")
  vi.stubGlobal("location", nativeLocation)
  history.replaceState(null, "", "/app/connections/callback?state=native&code=native-code")
  render(<StrictMode><QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/app/connections/callback?state=native&code=native-code"]}>
    <Routes><Route path="/app/connections/callback" element={<ConnectionCallbackPage />} /><Route path="/app/connections" element={<p>Restored connections</p>} /></Routes>
  </MemoryRouter></QueryClientProvider></StrictMode>)
  await screen.findByText(synchronized ? "Restored connections" : /Workflow synchronization is pending/)
  await waitFor(() => expect(request.mock.calls.filter(([url]) => String(url).endsWith("/callback"))).toHaveLength(1))
  expect(window.location.search).toBe("")
  expect(sessionStorage.getItem("alterx_connection_oauth")).toBeNull()
})
it("missing callback context produces a retry link without a provider POST", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request)
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><ConnectionCallbackPage /></MemoryRouter></QueryClientProvider>)
  await screen.findByText(/Connection authorization failed/)
  expect(screen.getByRole("button", { name: "Back to connections" })).toBeDefined()
  expect(request).not.toHaveBeenCalled()
})
