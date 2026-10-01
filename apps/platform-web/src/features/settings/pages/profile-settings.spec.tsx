import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import { ProfileSettings } from "./profile-settings"

const mode = vi.hoisted(() => ({ live: true }))
vi.mock("@/api/http", () => ({ get isLiveApi() { return mode.live } }))
vi.mock("@/api/client", () => ({ api: {
  getProfile: vi.fn(async () => ({ name: "Test Person", email: "person@example.test", jobTitle: "", avatarUrl: "" })),
  updateProfile: vi.fn(async () => undefined),
} }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function showProfile() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <ProfileSettings />
  </QueryClientProvider>)
}
describe("profile photo controls", () => {
  it("hides unsupported photo changes in live mode while name editing works", async () => {
    mode.live = true
    showProfile()
    const name = await screen.findByDisplayValue("Test Person")
    expect(screen.queryByRole("button", { name: "Change photo" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull()
    expect(screen.queryByText("JPG, GIF or PNG. 1MB max.")).toBeNull()
    expect(screen.getByDisplayValue("person@example.test")).toBeTruthy()
    fireEvent.change(name, { target: { value: "Updated Person" } })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith({ name: "Updated Person", jobTitle: "" }))
  })
  it("keeps photo controls in mock mode", async () => {
    mode.live = false
    showProfile()
    expect(await screen.findByRole("button", { name: "Change photo" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    expect(screen.getByText("JPG, GIF or PNG. 1MB max.")).toBeTruthy()
  })
})
