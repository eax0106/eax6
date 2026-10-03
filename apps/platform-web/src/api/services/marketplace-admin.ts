import { isLiveApi } from "../http"
import * as live from "../live-admin-commerce"

import { delay } from "../mock/data"

export interface MarketplaceReviewItem {
  id: string
  /** Live mode: which governance resource this is. */
  resourceType?: "listing" | "tool_manifest"
  listingName: string
  sellerName: string
  assetType: "workflow" | "plugin" | "agent" | "listing" | "tool"
  /** Demo only: the governance API has no risk score. */
  risk?: "low" | "medium" | "high"
  trustLevel?: string
  status: "pending_review" | "approved" | "changes_requested" | "rejected" | "suspended"
  submittedAt: string
  reviewer?: { id: string; name: string }
}

/** A seller's identity documents awaiting staff review (task B2.4). */
export interface SellerVerification {
  id: string
  tenantId: string
  documents: { type: string; objectRef: string }[]
  submittedAt: string
}

let mockVerifications: SellerVerification[] = [
  { id: "kyc_demo_1", tenantId: "ten-2", documents: [{ type: "tax_id", objectRef: "s3://demo/tax-id.pdf" }, { type: "bank_proof", objectRef: "s3://demo/bank.pdf" }], submittedAt: new Date(Date.now() - 3600000).toISOString() },
]

const MOCK_REVIEWS: MarketplaceReviewItem[] = [
  { id: "mrev-1", listingName: "Advanced Data Scraper", sellerName: "DataCorp", assetType: "workflow", risk: "high", status: "pending_review", submittedAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "mrev-2", listingName: "Salesforce Sync", sellerName: "CRM Tools", assetType: "plugin", risk: "low", status: "changes_requested", submittedAt: new Date(Date.now() - 172800000).toISOString(), reviewer: { id: "u-sys", name: "System Admin" } },
  { id: "mrev-3", listingName: "Support Bot Pro", sellerName: "Acme AI", assetType: "agent", risk: "medium", status: "approved", submittedAt: "2024-06-15T00:00:00Z", reviewer: { id: "u-sys", name: "System Admin" } }
]

export interface ToolVersionReviewItem {
  manifestId: string
  tenantId: string
  name: string
  version: {
    id: string; version: string; artifactRef: string; capabilities: readonly string[]; permissions: readonly string[]
    status: string; scanReportId?: string | null
    review?: { scanReportId: string; decision: "approved" | "rejected"; reviewedBy: string; reviewedAt: string; reason: string } | null
  }
  scan: {
    id: string; verdict: "clean" | "findings" | "blocked" | "errored" | "unavailable"
    findings: readonly { rule: string; severity: "info" | "low" | "medium" | "high" | "critical"; locator: string; detail: string }[]
    scannerVersion: string; durationMs: number; scannedAt: string
  }
}

export class MarketplaceAdminService {
  private readonly toolVersions: ToolVersionReviewItem[] = [{
    manifestId: "tlm_demo", tenantId: "ten_demo", name: "Demo CRM connector",
    version: { id: "tlv_demo", version: "1.0.0", artifactRef: "s3://demo/connector.tgz?versionId=demo", capabilities: ["crm.read"], permissions: ["crm.contacts.read"], status: "review_pending", scanReportId: "scn_demo" },
    scan: { id: "scn_demo", verdict: "clean", findings: [], scannerVersion: "demo", durationMs: 50, scannedAt: "2026-10-04T00:00:00.000Z" },
  }]

  async toolVersionReviewQueue(): Promise<ToolVersionReviewItem[]> {
    if (isLiveApi) return live.listToolVersionReviews()
    await delay(100)
    return structuredClone(this.toolVersions.filter(item => item.version.status === "review_pending"))
  }

  async reviewToolVersion(item: ToolVersionReviewItem, decision: "approved" | "rejected", reason: string): Promise<ToolVersionReviewItem["version"]> {
    if (isLiveApi) return live.reviewToolVersion(item, decision, reason)
    await delay(100)
    const current = this.toolVersions.find(value => value.manifestId === item.manifestId && value.version.id === item.version.id)
    if (!current) throw new Error("Tool version was not found")
    if (!reason.trim()) throw new Error("Review reason is required")
    if (current.scan.id !== item.scan.id || current.version.scanReportId !== item.scan.id) throw new Error("The scan changed; reload before reviewing")
    const prior = current.version.review
    if (prior) {
      if (prior.decision !== decision || prior.reason !== reason.trim()) throw new Error("This scan already has a different recorded staff decision")
      return structuredClone(current.version)
    }
    if (current.version.status !== "review_pending" || current.scan.verdict !== "clean" || current.scan.findings.length) throw new Error("Staff approval requires a complete clean scan")
    current.version.status = decision === "approved" ? "published" : "scan_failed"
    current.version.review = { scanReportId: item.scan.id, decision, reason: reason.trim(), reviewedBy: "stf_demo", reviewedAt: new Date().toISOString() }
    return structuredClone(current.version)
  }

  async reviewQueue(): Promise<MarketplaceReviewItem[]> {
    if (isLiveApi) return live.listMarketplaceReviews()
    await delay(300)
    return MOCK_REVIEWS
  }

  async reviewListing(id: string, action: "approve" | "reject" | "changes_requested" | "suspend", _reason?: string, resourceType?: MarketplaceReviewItem["resourceType"]): Promise<MarketplaceReviewItem> {
    if (isLiveApi) {
      if (action === "changes_requested") throw new Error("Requesting changes is not available")
      return live.reviewMarketplaceItem({ id, resourceType }, action)
    }
    await delay(500)
    const rev = MOCK_REVIEWS.find(r => r.id === id)
    if (!rev) throw new Error("Not found")
    
    rev.status = action === "approve" ? "approved" : action === "reject" ? "rejected" : action === "suspend" ? "suspended" : action
    rev.reviewer = { id: "u-sys", name: "Admin (You)" }
    return rev
  }

  async verificationQueue(): Promise<SellerVerification[]> {
    if (isLiveApi) return live.listSellerVerifications()
    await delay(300)
    return mockVerifications
  }

  async reviewVerification(item: SellerVerification, decision: "approved" | "rejected", reason?: string): Promise<void> {
    if (isLiveApi) return live.reviewSellerVerification(item, decision, reason)
    await delay(400)
    mockVerifications = mockVerifications.filter(v => v.id !== item.id)
  }
}
