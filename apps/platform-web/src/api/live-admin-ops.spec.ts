import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  isLiveApi: true,
}))

import { listGrants, listSignals, reviewSignal, setIncidentStatus } from "./live-admin-ops"

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const signal = {
  id: "abs_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: "018f47a5-7b2c-7d10-8f11-123456789abd",
  signal_type: "credential_abuse",
  source: "gateway",
  score: 85,
  evidence_ref: "ev_1",
  observed_at: "2026-09-28T00:00:00Z",
  status: "open",
}

describe("live admin ops", () => {
  it("maps abuse signals to review items, severity from score", async () => {
    fetchMock.mockResolvedValue(Response.json([signal, { ...signal, score: 10, status: "confirmed", signal_type: "free_tier_velocity" }]))
    expect((await listSignals()).map((s) => [s.type, s.severity, s.status])).toEqual([
      ["credential_issue", "critical", "open"],
      ["rate_anomaly", "low", "resolved"],
    ])
  })

  it("reviews a signal as confirm or dismiss with a reason", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...signal, status: "dismissed" }))
    expect((await reviewSignal(signal.id, "dismissed")).status).toBe("dismissed")
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ decision: "dismiss" })
  })

  it("sets an incident's status through the status route", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ id: "inc_1", title: "x", severity: "sev1", status: "resolved", created_at: "x", impacted_services: ["api"], summary: "s" }),
    )
    await setIncidentStatus("inc_1", "resolved")
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/admin/incidents/inc_1/actions/set-status")
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ status: "resolved" })
  })

  it("derives grant status from revocation and expiry", async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    fetchMock.mockResolvedValue(
      Response.json({
        data: [
          { id: "jit_a", tenant_id: "t", staff_user_id: "stf_1", reason_text: "r", granted_at: past, expires_at: future, revoked_at: null },
          { id: "jit_b", tenant_id: "t", staff_user_id: "stf_1", reason_text: "r", granted_at: past, expires_at: past, revoked_at: null },
          { id: "jit_c", tenant_id: "t", staff_user_id: "stf_1", reason_text: "r", granted_at: past, expires_at: future, revoked_at: past },
        ],
      }),
    )
    expect((await listGrants()).map((g) => g.status)).toEqual(["active", "expired", "revoked"])
  })
})
