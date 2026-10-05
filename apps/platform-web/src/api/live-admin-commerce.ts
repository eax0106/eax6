import { MarketplaceGovernanceItemSchema } from "@alterx/contracts"
import { apiGet, apiPost } from "./http"
import type { MarketplaceReviewItem, SellerVerification, ToolVersionReviewItem } from "./services/marketplace-admin"
import type { BillingIssue } from "./services/billing-ops"

// Live marketplace moderation and billing adapters. Staff attribution comes from the session.

type AnyRecord = Record<string, unknown>

// --- Marketplace moderation -----------------------------------------------

// Everything the governance queue returns is waiting on staff except a
// suspended listing or a blocked tool, which were taken down.
function reviewStatus(status: string): MarketplaceReviewItem["status"] {
  return status === "needs_changes" ? "changes_requested" : status === "published" ? "approved" : status === "suspended" || status === "blocked" || status === "removed" ? "suspended" : "pending_review"
}

function mapReview(value: unknown): MarketplaceReviewItem {
  const item = MarketplaceGovernanceItemSchema.parse(value)
  const resourceType = String(item.resource_type)
  return {
    id: String(item.id),
    resourceType: resourceType === "tool_manifest" ? "tool_manifest" : "listing",
    listingName: String(item.name),
    sellerName: item.tenant_id ? String(item.tenant_id) : "Alter",
    assetType: resourceType === "tool_manifest" ? "tool" : "listing",
    status: reviewStatus(String(item.status)),
    submittedAt: String(item.updated_at),
    etag: item.etag,
    riskDetails: item.risk,
    reviewNotes: item.review_notes,
    ...(typeof item.trust_level === "string" ? { trustLevel: item.trust_level } : {}),
  }
}

export async function listMarketplaceReviews(): Promise<MarketplaceReviewItem[]> {
  const body = await apiGet<unknown>("/api/v1/admin/marketplace/governance")
  return (Array.isArray(body) ? body : []).map(mapReview)
}

const governanceAction = { approve: "approve", reject: "reject", changes_requested: "needs_changes", suspend: "takedown" } as const

export async function reviewMarketplaceItem(
  item: Pick<MarketplaceReviewItem, "id" | "resourceType" | "etag">,
  action: keyof typeof governanceAction,
  reason: string,
): Promise<MarketplaceReviewItem> {
  if (!reason.trim() || reason.trim().length > 1000) throw new Error("Review reason must contain 1 to 1000 characters")
  if (!item.etag) throw new Error("Reload review queue before deciding")
  const resourceType = item.resourceType ?? "listing"
  return mapReview(
    await apiPost<unknown>(
      `/api/v1/admin/marketplace/governance/${resourceType}/${encodeURIComponent(item.id)}/actions/apply`,
      { action: governanceAction[action], reason: reason.trim() },
      { ifMatch: item.etag },
    ),
  )
}

// --- Seller verification (B2.4) ----------------------------------------------

function mapVerification(value: unknown): SellerVerification {
  const item = value as AnyRecord
  const documents = Array.isArray(item.documents) ? (item.documents as AnyRecord[]) : []
  return {
    id: String(item.id),
    tenantId: String(item.tenant_id),
    documents: documents.map((document) => ({ type: String(document.type), objectRef: String(document.objectRef) })),
    submittedAt: String(item.submitted_at),
  }
}

export async function listSellerVerifications(): Promise<SellerVerification[]> {
  const body = await apiGet<unknown>("/api/v1/admin/publisher/verifications")
  return (Array.isArray(body) ? body : []).map(mapVerification)
}

export async function reviewSellerVerification(
  item: Pick<SellerVerification, "id" | "tenantId">,
  decision: "approved" | "rejected",
  reason?: string,
): Promise<void> {
  await apiPost<unknown>(
    `/api/v1/admin/publisher/verifications/${encodeURIComponent(item.tenantId)}/${encodeURIComponent(item.id)}/actions/review`,
    reason ? { decision, reason } : { decision },
  )
}

// --- Billing operations ------------------------------------------------------

function mapIssue(value: unknown): BillingIssue {
  const item = value as AnyRecord
  const state = String(item.state) as NonNullable<BillingIssue["accessState"]>
  return {
    id: String(item.tenant_id),
    tenantId: String(item.tenant_id),
    tenantName: String(item.tenant_name),
    issue: "payment_failed",
    plan: typeof item.current_plan === "string" ? item.current_plan : "unknown",
    status: "open",
    accessState: state,
    createdAt: String(item.first_failed_at ?? item.updated_at),
  }
}

export async function listBillingIssues(): Promise<BillingIssue[]> {
  const body = await apiGet<unknown>("/api/v1/admin/billing/issues")
  return (Array.isArray(body) ? body : []).map(mapIssue)
}

// First tool version: the API attributes staff from the authenticated session.
export function listToolVersionReviews(): Promise<ToolVersionReviewItem[]> {
  return apiGet<ToolVersionReviewItem[]>("/api/v1/admin/marketplace/governance/tools/review-queue")
}

export function reviewToolVersion(item: ToolVersionReviewItem, decision: "approved" | "rejected", reason: string): Promise<ToolVersionReviewItem["version"]> {
  return apiPost<ToolVersionReviewItem["version"]>(
    `/api/v1/admin/marketplace/governance/tools/${encodeURIComponent(item.manifestId)}/versions/${encodeURIComponent(item.version.id)}/review`,
    { scanReportId: item.scan.id, decision, reason: reason.trim() },
  )
}
