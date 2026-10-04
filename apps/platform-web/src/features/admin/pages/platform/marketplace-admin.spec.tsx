import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { ToolVersionReviewItem } from "@/api/services/marketplace-admin"
vi.mock("@/api/client", () => ({ api: { admin: { marketplace: { reviewQueue: vi.fn(), verificationQueue: vi.fn(), toolVersionReviewQueue: vi.fn(), reviewToolVersion: vi.fn() } } } }))
import { MarketplaceAdmin } from "./marketplace-admin"
const item: ToolVersionReviewItem = { manifestId: "tlm_test", tenantId: "ten_test", name: "CRM connector", version: { id: "tlv_test", manifestId: "tlm_test", pinned: false, publishedAt: null, version: "1.0.0", artifactRef: "s3://package?versionId=immutable", capabilities: ["crm.read"], permissions: ["contacts.read"], status: "review_pending", scanReportId: "scn_test" }, scan: { id: "scn_test", toolVersionId: "tlv_test", verdict: "clean", findings: [], scannerVersion: "OSV-Scanner v2.6.0", durationMs: 5, scannedAt: "2026-10-04T00:00:00.000Z" } }
const mock = api.admin.marketplace
function view() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><MarketplaceAdmin /></QueryClientProvider>) }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(mock.reviewQueue).mockResolvedValue([]); vi.mocked(mock.verificationQueue).mockResolvedValue([]); vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([structuredClone(item)]); })
afterEach(cleanup)
describe("first tool version review in the staff console", () => {
  it("shows immutable artifact, actual scan and permissions; requires reason before submission", async () => {
    view(); const article = await screen.findByRole("article", { name: "CRM connector 1.0.0" })
    expect(within(article).getByText(/versionId=immutable/)).toBeTruthy(); expect(within(article).getByText(/contacts.read/)).toBeTruthy(); expect(within(article).getByText(/OSV-Scanner v2.6.0/)).toBeTruthy()
    const button = within(article).getByRole("button", { name: "Approve tool version" }); expect((button as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(within(article).getByRole("textbox"), "Inspected package")
    vi.mocked(mock.reviewToolVersion).mockResolvedValue({ ...item.version, status: "published" }); vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([])
    await userEvent.click(button)
    await waitFor(() => expect(mock.reviewToolVersion).toHaveBeenCalledWith(item, "approved", "Inspected package"))
    expect(await screen.findByText("No tool versions awaiting review.")).toBeTruthy()
  })
  it("preserves reason and package when API rejects a changed scan; offers reload", async () => {
    vi.mocked(mock.reviewToolVersion).mockRejectedValue(new Error("The scan changed; reload before reviewing"))
    view(); await userEvent.type(await screen.findByRole("textbox", { name: "Review reason for tlv_test" }), "Still inspecting")
    await userEvent.click(screen.getByRole("button", { name: "Approve tool version" }))
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The scan changed; reload before reviewing")
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Still inspecting")
    vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([{ ...item, version: { ...item.version, scanReportId: "scn_new" }, scan: { ...item.scan, id: "scn_new" } }])
    await userEvent.click(screen.getByRole("button", { name: "Reload tool scans" }))
    expect(await screen.findByText("Report: scn_new")).toBeTruthy()
  })
  it.each(["findings", "errored", "unavailable"] as const)("displays %s without offering a publishing decision", async verdict => {
    vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([{ ...item, scan: { ...item.scan, verdict, findings: [{ rule: "GHSA-fixture", severity: "low", locator: "fixture@1.0.0", detail: "Known dependency issue" }] } }])
    view(); expect(await screen.findByText(/GHSA-fixture/)).toBeTruthy(); await userEvent.type(screen.getByRole("textbox"), "Checked")
    expect((screen.getByRole("button", { name: "Approve tool version" }) as HTMLButtonElement).disabled).toBe(true)
    expect(mock.reviewToolVersion).not.toHaveBeenCalled()
  })
  it("blocks stale report pointers and reports queue load failure", async () => {
    vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([{ ...item, version: { ...item.version, scanReportId: "scn_other" } }])
    view(); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "A current, complete clean scan is required. Reload before reviewing.")
    cleanup(); vi.mocked(mock.toolVersionReviewQueue).mockRejectedValue(new Error("Review queue unavailable")); view(); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Review queue unavailable")
  })
})
