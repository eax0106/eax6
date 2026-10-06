import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { ConnectFlowDialog } from "./connect-flow-dialog"
import type { IntegrationDefinition } from "@/api/types"
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
const integration = { id: "github", name: "GitHub", authType: "oauth", available: true } as IntegrationDefinition
it("live connect redirects immediately and never displays mock success", async () => {
  const assign = vi.fn(), request = vi.fn<typeof fetch>(async () => Response.json({ authorize_url: "https://github.com/login/oauth/authorize?state=native", state: "native", expires_at: "2099-10-06T10:00:00.000Z" }))
  vi.stubGlobal("fetch", request)
  vi.stubGlobal("location", { origin: "http://localhost:5173", pathname: "/app/connections", search: "", hash: "", assign })
  render(<QueryClientProvider client={new QueryClient()}><ConnectFlowDialog integration={integration} open onOpenChange={vi.fn()} /></QueryClientProvider>)
  await userEvent.setup().click(screen.getByRole("button", { name: "Connect via OAuth" }))
  await waitFor(() => expect(assign).toHaveBeenCalledOnce(), { timeout: 500 })
  expect(screen.queryByText("Successfully Connected")).toBeNull()
  expect(screen.queryByText("Connection Name")).toBeNull()
})
it("unconfigured providers cannot launch a fake connect", async () => {
  render(<QueryClientProvider client={new QueryClient()}><ConnectFlowDialog integration={{ ...integration, available: false }} open onOpenChange={vi.fn()} /></QueryClientProvider>)
  expect((screen.getByRole("button", { name: "Connect via OAuth" }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/not configured/i)).toBeDefined()
})
