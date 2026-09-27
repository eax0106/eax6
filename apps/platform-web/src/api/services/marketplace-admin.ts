import { isLiveApi } from "../http"
import * as live from "../live-admin-commerce"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

const MOCK_REVIEWS: MarketplaceReviewItem[] = [
  { id: "mrev-1", listingName: "Advanced Data Scraper", sellerName: "DataCorp", assetType: "workflow", risk: "high", status: "pending_review", submittedAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "mrev-2", listingName: "Salesforce Sync", sellerName: "CRM Tools", assetType: "plugin", risk: "low", status: "changes_requested", submittedAt: new Date(Date.now() - 172800000).toISOString(), reviewer: { id: "u-sys", name: "System Admin" } },
  { id: "mrev-3", listingName: "Support Bot Pro", sellerName: "Acme AI", assetType: "agent", risk: "medium", status: "approved", submittedAt: "2024-06-15T00:00:00Z", reviewer: { id: "u-sys", name: "System Admin" } }
]

export class MarketplaceAdminService {
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
}
