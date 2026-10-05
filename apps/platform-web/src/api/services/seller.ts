import { type SellerProfile, type MarketplaceListing, type MarketplacePayout, type SellerEarnings } from "../types"
import { apiGet, apiPost, isLiveApi } from "../http"

interface SellerListingRow {
  id: string
  tenantId: string | null
  type: MarketplaceListing["assetType"]
  name: string
  description: string | null
  status: MarketplaceListing["status"]
  priceMinor?: string
  currency?: string
  createdAt: string
  updatedAt: string
}

interface VerificationStatus {
  id: string
  tenantId: string
  status: "pending_review" | "approved" | "rejected"
  rejectionReason: string | null
  submittedAt: string
}

function mapSellerListing(row: SellerListingRow): MarketplaceListing {
  const minor = Number(row.priceMinor ?? "0")
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid listing price")
  return {
    id: row.id,
    slug: row.id,
    title: row.name,
    shortDescription: row.description ?? "",
    description: row.description ?? "",
    assetType: row.type,
    category: row.type.replaceAll("_", " "),
    seller: { id: row.tenantId ?? "", displayName: "" },
    pricing:
      minor === 0
        ? { type: "free" }
        : {
            type: "paid",
            price: minor / 100,
            currency: row.currency ?? "INR",
            priceMinor: String(minor),
          },
    tags: [],
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function ownListings(): Promise<MarketplaceListing[]> {
  const actor = await apiGet<{ tenantId: string }>("/api/v1/auth/me")
  const response = await apiGet<{ data: SellerListingRow[] }>("/api/v1/marketplace/listings?owner=me&limit=200")
  return response.data.filter((row) => row.tenantId === actor.tenantId).map(mapSellerListing)
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockProfile: SellerProfile = {
  id: "me",
  displayName: "My Workspace",
  status: "verified",
  joinedAt: "2026-07-01T00:00:00Z",
  rating: 4.8,
  listingCount: 2
}

const mockSellerListings: MarketplaceListing[] = [
  {
    id: "mkt_1",
    slug: "customer-support-triage",
    title: "AI Customer Support Triage",
    shortDescription: "Automatically categorizes, tags, and drafts replies for incoming support tickets.",
    description: "This workflow integrates with Zendesk or Intercom to process new tickets.",
    assetType: "workflow_template",
    category: "Customer Support",
    seller: { id: "me", displayName: "My Workspace", rating: 4.8 },
    pricing: { type: "free" },
    rating: 4.8,
    reviewCount: 128,
    installCount: 5430,
    tags: ["support", "zendesk", "triage"],
    status: "published",
    createdAt: "2026-01-15T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z"
  }
]

export const sellerService = {
  getProfile: async (): Promise<SellerProfile> => {
    if (isLiveApi) {
      const [actor, submission] = await Promise.all([
        apiGet<{ tenantId: string }>("/api/v1/auth/me"),
        apiGet<VerificationStatus | null>("/api/v1/publisher/verification/status"),
      ])
      return {
        id: actor.tenantId,
        displayName: "",
        status: submission?.status === "approved" ? "verified" : submission?.status === "pending_review" ? "pending" : submission?.status === "rejected" ? "restricted" : "not_started",
        joinedAt: submission?.submittedAt ?? "",
      }
    }
    await delay(300)
    return mockProfile
  },
  updateProfile: async (data: any): Promise<SellerProfile> => {
    if (isLiveApi) throw new Error("Verification submission requires a secure document upload")
    await delay(500)
    return { ...mockProfile, ...data }
  },
  listings: {
    list: async (): Promise<MarketplaceListing[]> => {
      if (isLiveApi) return ownListings()
      await delay(400)
      return mockSellerListings
    },
    create: async (data: any): Promise<MarketplaceListing> => {
      if (data.pricing && data.pricing.type !== "free") throw new Error("Marketplace listings are free-only in v1")
      if (isLiveApi) {
        const row = await apiPost<SellerListingRow>("/api/v1/marketplace/listings", {
          name: data.title,
          description: data.description,
          type: data.assetType,
          license_type: data.licenseType ?? "single_workspace",
        })
        return mapSellerListing(row)
      }
      await delay(600)
      return {
        id: "mkt_new_" + Date.now(),
        slug: data.title.toLowerCase().replace(/ /g, '-'),
        title: data.title,
        shortDescription: data.shortDescription,
        description: data.description,
        assetType: data.assetType,
        category: data.category,
        seller: { id: "me", displayName: "My Workspace" },
        pricing: data.pricing || { type: "free" },
        tags: data.tags || [],
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    },
    update: async (_id: string, data: any) => {
      if (data.pricing && data.pricing.type !== "free") throw new Error("Marketplace listings are free-only in v1")
      if (isLiveApi) throw new Error("Listing edits are not available in this Seller Console yet")
      await delay(500)
      return { ...mockSellerListings[0], ...data }
    },
    submit: async (_id: string) => {
      if (isLiveApi) return apiPost(`/api/v1/publisher/listings/${encodeURIComponent(_id)}/actions/submit`, {})
      await delay(800)
      return { success: true }
    },
    unpublish: async (_id: string) => {
      if (isLiveApi) return apiPost(`/api/v1/publisher/listings/${encodeURIComponent(_id)}/actions/transition`, { status: "suspended" })
      await delay(500)
      return { success: true }
    },
    delete: async (_id: string) => {
      if (isLiveApi) return apiPost(`/api/v1/publisher/listings/${encodeURIComponent(_id)}/actions/transition`, { status: "removed" })
      await delay(500)
      return { success: true }
    }
  },
  earnings: {
    get: async (): Promise<SellerEarnings> => {
      if (isLiveApi) return apiGet<SellerEarnings>("/api/v1/publisher/earnings")
      await delay(300)
      return {
        availableMinor: "32000",
        pendingMinor: "12000",
        paidMinor: "101000",
        currency: "INR"
      }
    }
  },
  payouts: {
    list: async (): Promise<MarketplacePayout[]> => {
      if (isLiveApi) return apiGet<MarketplacePayout[]>("/api/v1/publisher/payouts")
      await delay(400)
      return [
        { id: "po_1", orderId: "ord_1", totalMinor: "126250", sellerShareMinor: "101000", platformShareMinor: "25250", status: "processed", createdAt: "2026-07-01T00:00:00Z" }
      ]
    }
  }
}
