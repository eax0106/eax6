import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import { NotificationPreferencesPage } from "./notification-preferences"

vi.mock("@/api/client", () => ({ api: { notifications: {
  getPreferences: vi.fn(async () => [{ category: "human_action", inApp: false, email: true }]),
  updatePreferences: vi.fn(async () => undefined),
} } }))

afterEach(cleanup)

describe("D5 approval notification preferences", () => {
  it("locks in-app approval delivery on but lets the user turn off email", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotificationPreferencesPage />
    </QueryClientProvider>)
    const inApp = await screen.findByRole("switch", { name: "Human Actions in-app notifications" })
    expect(inApp.getAttribute("aria-checked")).toBe("true")
    expect(inApp.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText("Approval notices always appear in-app. Email is optional.")).toBeTruthy()
    const email = screen.getByRole("switch", { name: "Human Actions email notifications" })
    expect(email.hasAttribute("disabled")).toBe(false)
    fireEvent.click(email)
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }))
    await waitFor(() => expect(api.notifications.updatePreferences).toHaveBeenCalledWith([
      { category: "human_action", inApp: true, email: false },
    ]))
  })
})
