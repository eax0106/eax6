import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listAuditEvents } from "./live-admin-audit"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

function event(action: string, result = "success") {
  return {
    id: `aud_${action}`,
    actor_type: "admin",
    actor_ref: "stf_1",
    action,
    target_type: "tenant",
    target_ref: "t1",
    result,
    reason_code: "",
    context_json: JSON.stringify({ scope: "tenant:write" }),
    occurred_at: "2026-09-28T00:00:00Z",
    entry_hash: "a".repeat(64),
  }
}

describe("live admin audit", () => {
  it("filters by tenant on the server and derives categories without guessing", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ events: [event("tenant.suspend"), event("workflow.publish"), event("zzz.unknown", "error")], next_cursor: null }),
    )
    const events = await listAuditEvents({ tenantId: "t1" })
    expect(String(fetchMock.mock.calls[0]![0])).toContain("tenant_id=t1")
    expect(events.map((e) => e.category)).toEqual(["admin", "workflow", "other"])
    expect(events[2]!.outcome).toBe("failure")
    expect(events[0]!.metadata).toEqual({ scope: "tenant:write" })
    expect(events[0]!.target).toEqual({ type: "tenant", id: "t1" })
  })
})
