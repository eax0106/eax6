import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listUsers, revokeUserSessions, suspendUser } from "./live-admin-users"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const row = {
  id: "018f47a5-7b2c-7d10-8f11-123456789abc",
  email: "person@example.com",
  display_name: null,
  status: "active",
  tenant_ids: ["t1", "t2"],
  created_at: "2026-09-28T00:00:00Z",
  last_seen_at: null,
  active_sessions: 1,
}

describe("live admin users", () => {
  it("maps what the API serves and invents nothing (MFA and risk stay unknown)", async () => {
    fetchMock.mockResolvedValue(Response.json([row]))
    const [user] = await listUsers()
    expect(user).toMatchObject({ name: "person@example.com", tenantIds: ["t1", "t2"], status: "active" })
    expect(user!.mfaEnabled).toBeUndefined()
    expect(user!.riskState).toBeUndefined()
  })

  it("sends the reason with a suspension and a session revocation", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...row, status: "suspended" }))
    expect((await suspendUser(row.id, "account takeover")).status).toBe("suspended")
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ reason: "account takeover" })
    fetchMock.mockResolvedValue(Response.json({ revoked: 1 }))
    await revokeUserSessions(row.id, "lost laptop")
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/actions/revoke-sessions")
  })
})
