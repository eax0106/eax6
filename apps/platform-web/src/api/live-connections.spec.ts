import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("./http", async importOriginal => ({ ...await importOriginal<typeof import("./http")>(), isLiveApi: true }))
vi.mock("./mock/data", async importOriginal => ({ ...await importOriginal<typeof import("./mock/data")>(), delay: vi.fn(async () => undefined) }))
import { api } from "./client"
import { completeConnection } from "./live-connections"

const request = vi.fn<typeof fetch>(), assign = vi.fn()
const id = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
const authorization = { authorize_url: "https://github.com/login/oauth/authorize?state=state-native", state: "state-native", expires_at: "2099-10-06T10:00:00.000Z" }
beforeEach(() => {
  request.mockReset(); assign.mockReset(); sessionStorage.clear()
  vi.stubGlobal("location", { origin: "http://localhost:5173", pathname: "/app/connections", search: "", hash: "", assign })
  vi.stubGlobal("fetch", request)
  request.mockImplementation(async input => {
    const url = String(input)
    if (url.endsWith("/actions/callback")) return Response.json({ id, connector: "github", status: "connected", engine_synced: true })
    if (url.endsWith("/actions/authorize")) return Response.json(authorization)
    if (url.endsWith(`/connections/${id}`)) return Response.json({ id, connector: "github", status: "revoked", created_at: "2026-10-06T10:00:00Z", version: "2026-10-06T10:00:00Z" })
    if (url.endsWith("/integrations")) return Response.json([{ id: "github", display_name: "GitHub", scopes: [], configured: true }])
    if (url.endsWith(`/workspaces/${id}`)) return Response.json({ id, status: "pending_deletion", deletionDueAt: "2026-10-13T10:00:00Z" })
    throw new Error(`Unexpected test path ${url}`)
  })
})
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear() })

describe("three MVP web methods use live routes", () => {
  it("create authorizes and redirects instead of returning a demo connection", async () => {
    await expect(api.createConnection({ integrationId: "github" })).resolves.toBeUndefined()
    const call = request.mock.calls.find(([url]) => String(url).endsWith("/api/v1/integrations/github/actions/authorize"))!
    expect(call).toBeDefined()
    expect(call[1]?.method).toBe("POST")
    expect(JSON.parse(String(call[1]?.body))).toEqual({ redirect_uri: "http://localhost:5173/app/connections/callback" })
    expect(new Headers(call[1]?.headers).get("Idempotency-Key")).toBeTruthy()
    expect(assign).toHaveBeenCalledWith(authorization.authorize_url)
  })
  it("reconnect authorizes the actual existing connection identity", async () => {
    await expect(api.reconnectConnection(id)).resolves.toBeUndefined()
    const call = request.mock.calls.find(([url]) => String(url).endsWith("/actions/authorize"))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ redirect_uri: "http://localhost:5173/app/connections/callback", connection_id: id })
    expect(assign).toHaveBeenCalledWith(authorization.authorize_url)
  })
  it("workspace-data deletion delegates to the real D2 route with typed name", async () => {
    await expect(api.deleteWorkspaceData(id, "Marketing")).resolves.toEqual({ deletionDueAt: "2026-10-13T10:00:00Z" })
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe(`/api/v1/workspaces/${id}`)
    expect(init?.method).toBe("DELETE")
    expect(JSON.parse(String(init?.body))).toEqual({ confirm_name: "Marketing" })
    expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^workspace-delete/)
  })
})

it("callback validates saved state, completes with stable idempotency key and restores context", async () => {
  await api.reconnectConnection(id)
  const saved = JSON.parse(sessionStorage.getItem("alterx_connection_oauth")!)
  await expect(completeConnection(new URLSearchParams({ state: authorization.state, code: "native-code" }))).resolves.toEqual({ connectionId: id, returnTo: "/app/connections", engineSynced: true })
  const call = request.mock.calls.find(([url]) => String(url).endsWith("/actions/callback"))!
  expect(JSON.parse(String(call[1]?.body))).toEqual({ code: "native-code", state: authorization.state })
  expect(new Headers(call[1]?.headers).get("Idempotency-Key")).toBe(saved.callbackKey)
  expect(sessionStorage.getItem("alterx_connection_oauth")).toBeNull()
})
it.each(["missing", "mismatched", "expired", "declined", "no-code"])("refuses %s callback before POST", async variant => {
  if (variant !== "missing") await api.createConnection({ integrationId: "github" })
  if (variant === "expired") {
    const saved = JSON.parse(sessionStorage.getItem("alterx_connection_oauth")!); saved.expiresAt = "2000-01-01T00:00:00.000Z"
    sessionStorage.setItem("alterx_connection_oauth", JSON.stringify(saved))
  }
  request.mockClear()
  const params = new URLSearchParams({ state: variant === "mismatched" ? "wrong" : authorization.state, code: "code" })
  if (variant === "declined") params.set("error", "access_denied")
  if (variant === "no-code") params.delete("code")
  await expect(completeConnection(params)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})
it("rejects malformed authorize response instead of redirecting", async () => {
  request.mockResolvedValueOnce(Response.json({ ...authorization, authorize_url: "https://github.com/login/oauth/authorize?state=wrong" }))
  await expect(api.createConnection({ integrationId: "github" })).rejects.toThrow("unavailable")
  expect(assign).not.toHaveBeenCalled(); expect(sessionStorage.getItem("alterx_connection_oauth")).toBeNull()
})
it("failed callback preserves context and key for retry, mismatched reconnect response refuses", async () => {
  await api.reconnectConnection(id)
  const saved = sessionStorage.getItem("alterx_connection_oauth")
  request.mockResolvedValueOnce(Response.json({ detail: "Provider failed" }, { status: 502 }))
  const params = new URLSearchParams({ state: authorization.state, code: "code" })
  await expect(completeConnection(params)).rejects.toMatchObject({ status: 502 })
  expect(sessionStorage.getItem("alterx_connection_oauth")).toBe(saved)
  request.mockResolvedValueOnce(Response.json({ id: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac", connector: "github", status: "connected" }))
  await expect(completeConnection(params)).rejects.toThrow("identity changed")
})
