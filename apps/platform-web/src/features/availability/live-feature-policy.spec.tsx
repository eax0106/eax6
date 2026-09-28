import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MemoryRouter } from "react-router-dom"
import {
  adminSectionFor,
  isLiveFeatureAvailable,
  type LiveFeature,
} from "./live-feature-policy"
import { LiveFeatureGate } from "./live-feature-gate"

afterEach(cleanup)

describe("live feature availability", () => {
  const unfinishedFeatures: LiveFeature[] = [
    "admin-deployments",
    "benchmarks",
    "discovery",
    "notifications",
  ]

  it.each(unfinishedFeatures)("keeps %s available in demo mode", (feature) => {
    expect(isLiveFeatureAvailable(feature, false)).toBe(true)
  })

  it.each(unfinishedFeatures)("hides %s in live mode", (feature) => {
    expect(isLiveFeatureAvailable(feature, true)).toBe(false)
  })

  it.each(["admin-tenants", "admin-users", "admin-audit", "admin-feature-flags", "admin-providers", "admin-policies", "admin-system-status", "admin-incidents", "admin-security", "admin-support", "admin-marketplace", "admin-billing", "budgets"] as const)("shows %s in live mode once its adapter is wired (Track B)", (feature) => {
    expect(isLiveFeatureAvailable(feature, true)).toBe(true)
  })

  it("maps admin console paths to their section", () => {
    expect(adminSectionFor("/app/admin")).toBe("admin-tenants")
    expect(adminSectionFor("/app/admin/tenants/ten_1")).toBe("admin-tenants")
    expect(adminSectionFor("/app/admin/incidents/inc_1")).toBe("admin-incidents")
    expect(adminSectionFor("/app/admin/feature-flags")).toBe("admin-feature-flags")
  })

  it("renders children when the selected adapter is truthful", () => {
    render(
      <MemoryRouter>
        <LiveFeatureGate feature="discovery" live={false}>
          <div>Discovery content</div>
        </LiveFeatureGate>
      </MemoryRouter>,
    )

    expect(screen.getByText("Discovery content")).toBeTruthy()
  })

  it("blocks direct live-mode access without rendering demo content", () => {
    render(
      <MemoryRouter>
        <LiveFeatureGate feature="discovery" live>
          <div>Invented discovery results</div>
        </LiveFeatureGate>
      </MemoryRouter>,
    )

    expect(screen.getByRole("heading", { name: "Discovery is not available in live mode" })).toBeTruthy()
    expect(screen.getByText("Demo data is not shown when AlterX is connected to live services.")).toBeTruthy()
    expect(screen.queryByText("Invented discovery results")).toBeNull()
  })
})
