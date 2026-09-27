import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiHttpError } from "@/api/http"
import { getStaffSession, startStaffLogin } from "@/api/staff-auth"

vi.mock("@/api/staff-auth", () => ({ getStaffSession: vi.fn(), startStaffLogin: vi.fn() }))

import { StaffGate } from "./staff-gate"

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StaffGate>
        <p>admin console</p>
      </StaffGate>
    </QueryClientProvider>,
  )
}

function httpError(status: number) {
  return new ApiHttpError({ status, title: "x", detail: "x" } as never, status)
}

describe("StaffGate", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("renders the console for a signed-in staff member", async () => {
    vi.mocked(getStaffSession).mockResolvedValue({ staffUserId: "stf_1", email: "ops@alter.example", roles: ["staff_admin"] })
    renderGate()
    expect(await screen.findByText("admin console")).toBeTruthy()
  })

  it("asks for staff sign-in on 401 and starts it", async () => {
    vi.mocked(getStaffSession).mockRejectedValue(httpError(401))
    renderGate()
    await userEvent.click(await screen.findByRole("button", { name: "Sign in as staff" }))
    await waitFor(() => expect(startStaffLogin).toHaveBeenCalledOnce())
    expect(screen.queryByText("admin console")).toBeNull()
  })
})
