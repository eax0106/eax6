import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/api/client"
import type { ToolVersionReviewItem } from "@/api/services/marketplace-admin"
vi.mock("@/api/client", () => ({ api: { admin: { marketplace: { reviewQueue: vi.fn(), reviewListing: vi.fn(), verificationQueue: vi.fn(), toolVersionReviewQueue: vi.fn(), reviewToolVersion: vi.fn() } } } }))
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

const reviewItem={id:"lst_test",resourceType:"listing" as const,listingName:"Mapping review",sellerName:"Seller",assetType:"listing" as const,status:"pending_review" as const,submittedAt:"2026-10-05T00:00:00Z",etag:'"revision-1"',
 riskDetails:{score:35,incomplete:true,reasons:[{signal:"outside_actions" as const,points:20,detail:"Declared outside actions: email.send",evidence:["email.send"],observed:true},{signal:"scanner" as const,points:0,detail:"No recorded scanner verdict",evidence:[],observed:false}]},
 reviewNotes:[{id:"mge_test",actor_type:"staff" as const,actor_ref:"stf_prior",action:"needs_changes" as const,previous_status:"human_review",next_status:"needs_changes",reason:"Explain mapping",occurred_at:"2026-10-04T00:00:00Z"}]}
describe("marketplace reviewer requested changes and real risk",()=>{
 it("shows score reasons and notes; bounded reason and pinned revision accompany needs changes",async()=>{
  vi.mocked(mock.reviewQueue).mockResolvedValue([reviewItem]);vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([]);view()
  expect(await screen.findByText("35/100 · Missing signals")).toBeTruthy();expect(screen.getByText(/No recorded scanner verdict/)).toBeTruthy();expect(screen.getByText(/Explain mapping/)).toBeTruthy()
  const button=screen.getByRole("button",{name:"Needs Changes"});expect((button as HTMLButtonElement).disabled).toBe(true)
  const reason=screen.getByRole("textbox",{name:"Review reason for lst_test"});expect((reason as HTMLInputElement).maxLength).toBe(1000)
  await userEvent.type(reason,"Correct mapping before publication")
  vi.mocked(mock.reviewListing).mockResolvedValue({...reviewItem,status:"changes_requested"});vi.mocked(mock.reviewQueue).mockResolvedValue([{...reviewItem,status:"changes_requested"}])
  await userEvent.click(button)
  await waitFor(()=>expect(mock.reviewListing).toHaveBeenCalledWith("lst_test","changes_requested","Correct mapping before publication","listing",'"revision-1"'))
  expect(await screen.findByText("changes requested")).toBeTruthy()
 })
 it("preserves reason on conflict and exposes queue failure with explicit reload",async()=>{
  vi.mocked(mock.reviewQueue).mockResolvedValue([reviewItem]);vi.mocked(mock.toolVersionReviewQueue).mockResolvedValue([]);vi.mocked(mock.reviewListing).mockRejectedValue(new Error("Resource changed; reload review"));view()
  const field=await screen.findByRole("textbox",{name:"Review reason for lst_test"});await userEvent.type(field,"Still correcting")
  await userEvent.click(screen.getByRole("button",{name:"Needs Changes"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Resource changed; reload review")
  expect((field as HTMLInputElement).value).toBe("Still correcting")
  vi.mocked(mock.reviewQueue).mockRejectedValue(new Error("Governance unavailable"));await userEvent.click(screen.getByRole("button",{name:"Reload review queue"}))
  expect(await screen.findByText("Governance unavailable")).toBeTruthy()
 })
})
