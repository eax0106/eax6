/// <reference types="node" />
import { webcrypto } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { completeLogin, startLogin } from "./auth"
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  sessionStorage.clear(); window.history.replaceState({}, "", "/auth/sign-in")
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, "", "/") })
describe("invitation PKCE context", () => {
  it("retains invitation across login and submits only after matching state", async () => {
    window.history.replaceState({}, "", "/auth/sign-in?invitation=valid-ticket&organization=org_acme")
    fetchMock.mockResolvedValueOnce(Response.json({ url: "https://mock.identity.local/authorize" })).mockResolvedValueOnce(Response.json({ userId: "user" }))
    await startLogin()
    const login = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))
    expect(login).toMatchObject({ organizationId: "org_acme", invitation: "valid-ticket" })
    expect(login.state.length).toBeGreaterThan(30); expect(login.codeChallenge.length).toBe(43)
    const signup = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))
    expect(signup).toMatchObject({ code: "invite:valid-ticket", invitation: "valid-ticket" })
    expect(signup.codeVerifier.length).toBeGreaterThan(64)
    expect(sessionStorage.getItem("alterx_pkce_invitation")).toBeNull()
  })
  it("refuses unmatched state before contacting signup", async () => {
    sessionStorage.setItem("alterx_pkce_verifier", "verifier"); sessionStorage.setItem("alterx_pkce_state", "expected"); sessionStorage.setItem("alterx_pkce_invitation", "ticket")
    await expect(completeLogin({ code: "code", state: "wrong" })).rejects.toThrow("Invalid sign-in callback")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("refuses partial/oversized invitation context before contacting login", async () => {
    for (const query of ["invitation=ticket", "organization=org_acme", `invitation=${"x".repeat(4097)}&organization=org_acme`]) {
      window.history.replaceState({}, "", `/auth/sign-in?${query}`)
      await expect(startLogin()).rejects.toThrow("Invalid invitation link")
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("normal login clears stale invitation and never submits it", async () => {
    sessionStorage.setItem("alterx_pkce_invitation", "stale")
    fetchMock.mockResolvedValueOnce(Response.json({ url: "https://mock.identity.local/authorize" })).mockResolvedValueOnce(Response.json({ userId: "user" }))
    await startLogin()
    const signup = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))
    expect(signup.invitation).toBeUndefined(); expect(signup.code).toMatch(/^user:/)
  })
})
