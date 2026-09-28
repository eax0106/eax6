import { apiGet, apiPost } from "./http"
import type { MarketplaceReviewItem, SellerVerification } from "./services/marketplace-admin"
import type { BillingIssue } from "./services/billing-ops"

// Admin console, marketplace moderation and billing operations (tasks B2.1,
// B2.2): live adapter over /api/v1/admin/marketplace/governance and
// /api/v1/admin/billing/issues. The governance API records a reason with every
// decision; the console's buttons have no reason field, so they send a fixed
// one naming where the decision came from -- the staff member is recorded by
// the API from the session.

type AnyRecord = Record<string, unknown>
const CONSOLE_REASON = "Decided in the admin console"

// --- Marketplace moderation -----------------------------------------------

// Everything the governance queue returns is waiting on staff except a
// suspended listing or a blocked tool, which were taken down.
function reviewStatus(status: string): MarketplaceReviewItem["status"] {
  return status === "suspended" || status === "blocked" ? "suspended" : "pending_review"
}

function mapReview(value: unknown): MarketplaceReviewItem {
  const item = value as AnyRecord
  const resourceType = String(item.resource_type)
  return {
    id: String(item.id),
    resourceType: resourceType === "tool_manifest" ? "tool_manifest" : "listing",
    listingName: String(item.name),
    sellerName: item.tenant_id ? String(item.tenant_id) : "Alter",
    assetType: resourceType === "tool_manifest" ? "tool" : "listing",
    status: reviewStatus(String(item.status)),
    submittedAt: String(item.updated_at),
    ...(typeof item.trust_level === "string" ? { trustLevel: item.trust_level } : {}),
  }
}

export async function listMarketplaceReviews(): Promise<MarketplaceReviewItem[]> {
  const body = await apiGet<unknown>("/api/v1/admin/marketplace/governance")
  return (Array.isArray(body) ? body : []).map(mapReview)
}

// The console's "suspend" is the API's "takedown". "Changes requested" has no
// API action and is not offered in live mode.
const governanceAction = { approve: "approve", reject: "reject", suspend: "takedown" } as const

export async function reviewMarketplaceItem(
  item: Pick<MarketplaceReviewItem, "id" | "resourceType">,
  action: keyof typeof governanceAction,
): Promise<MarketplaceReviewItem> {
  const resourceType = item.resourceType ?? "listing"
  return mapReview(
    await apiPost<unknown>(
      `/api/v1/admin/marketplace/governance/${resourceType}/${encodeURIComponent(item.id)}/actions/apply`,
      { action: governanceAction[action], reason: CONSOLE_REASON },
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
