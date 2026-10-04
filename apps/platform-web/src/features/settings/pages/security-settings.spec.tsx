import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/api/http", async original => ({ ...await original<typeof import("@/api/http")>(), isLiveApi: true }))
import { SecuritySettings } from "./security-settings"
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function page() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><SecuritySettings /></QueryClientProvider>) }
describe("provider password reset UI", () => {
  it("shows success only after actual provider request and collects no password", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ requested: true })); vi.stubGlobal("fetch", fetchMock)
    page(); expect(screen.queryByLabelText("New password")).toBeNull(); expect(screen.queryByText("Password reset requested. Check your email.")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Request password reset" }))
    expect(await screen.findByRole("status")).toBeTruthy(); expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/auth/password-reset"); expect(fetchMock.mock.calls[0]![1]?.body).toBeUndefined()
  })
  it("keeps provider failure visible without success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "Change your password with your sign-in provider" }, { status: 400 })))
    page(); await userEvent.click(screen.getByRole("button", { name: "Request password reset" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Change your password with your sign-in provider")
    expect(screen.queryByRole("status")).toBeNull()
  })
})
