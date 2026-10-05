import { type MarketplaceListing, type MarketplaceAssetInstallation, type MarketplaceReview } from "../types"
import { ApiHttpError, apiGet, apiPost, isLiveApi, mutationKey } from "../http"

interface ListingRecord {
  id: string
  tenantId: string | null
  type: MarketplaceListing["assetType"]
  name: string
  description: string | null
  latestVersion: string | null
  status: string
  priceMinor?: number | string
  currency?: string
  createdAt: string
  updatedAt: string
}

interface ListingVersion {
  id: string
  version: string
  publishedAt: string | null
}

interface InstallRecord {
  id: string
  listingId: string
  workspaceId: string
  listingVersionId: string
  installedAt: string
}

interface ReviewRecord {
  id: string
  listingId: string
  tenantId: string
  rating: number
  comment: string | null
  createdAt: string
}

function mapListing(row: ListingRecord): MarketplaceListing {
  if (row.status !== "published") throw new Error("This listing is not published")
  const priceMinor = Number(row.priceMinor ?? 0)
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new Error("Invalid marketplace price")
  if (priceMinor !== 0) throw new Error("Marketplace listings are free-only in v1")
  return {
    id: row.id,
    slug: row.id,
    title: row.name,
    shortDescription: row.description ?? "",
    description: row.description ?? "",
    assetType: row.type,
    category: row.type.replaceAll("_", " "),
    seller: { id: row.tenantId ?? "", displayName: "" },
    pricing: { type: "free" },
    tags: [],
    status: "published",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function mapInstall(row: InstallRecord): MarketplaceAssetInstallation {
  return { id: row.id, listingId: row.listingId, workspaceId: row.workspaceId, installedVersion: row.listingVersionId, installedAt: row.installedAt }
}

function mapReview(row: ReviewRecord): MarketplaceReview {
  return { id: row.id, listingId: row.listingId, author: { id: row.tenantId, name: "" }, rating: row.rating, body: row.comment ?? undefined, createdAt: row.createdAt }
}

async function liveListings(filters?: { q?: string }): Promise<MarketplaceListing[]> {
  const q = filters?.q?.trim()
  if (q) {
    const result = await apiGet<{ data: { id: string }[] }>(`/api/v1/search?q=${encodeURIComponent(q)}&kind=listing&limit=50`)
    const rows = await Promise.all(result.data.map(async (hit) => {
      try { return await apiGet<ListingRecord>(`/api/v1/marketplace/listings/${encodeURIComponent(hit.id)}`) }
      catch (error) { if (error instanceof ApiHttpError && error.status === 404) return null; throw error }
    }))
    return rows.filter((row): row is ListingRecord => row !== null && Number(row.priceMinor ?? 0) === 0).map(mapListing)
  }
  const result = await apiGet<{ data: ListingRecord[] }>("/api/v1/marketplace/listings?status=published&limit=200")
  return result.data.filter(row => Number(row.priceMinor ?? 0) === 0).map(mapListing)
}

async function liveInstall(id: string): Promise<{ success: true }> {
  const path = `/api/v1/marketplace/listings/${encodeURIComponent(id)}`
  const listing = await apiGet<ListingRecord>(path)
  if (listing.status !== "published" || Number(listing.priceMinor ?? 0) > 0) throw new Error("This listing is not available for free installation")
  const versions = await apiGet<ListingVersion[]>(`${path}/versions`)
  const version = versions.find((item) => item.publishedAt && item.version === listing.latestVersion)
  if (!version) throw new Error("No published version is available for this listing")
  const compatibility = await apiPost<{ compatible: boolean }>(`${path}/actions/check-compatibility`, { listing_version_id: version.id })
  if (!compatibility.compatible) throw new Error("This version is not compatible with your workspace")
  await apiPost(`${path}/actions/install`, { listing_version_id: version.id, confirmed: true }, { idempotencyKey: mutationKey("marketplace-install") })
  return { success: true }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockCatalog: MarketplaceListing[] = [
  {
    id: "mkt_1",
    slug: "customer-support-triage",
    title: "AI Customer Support Triage",
    shortDescription: "Automatically categorizes, tags, and drafts replies for incoming support tickets.",
    description: "This workflow integrates with Zendesk or Intercom to process new tickets. It uses advanced reasoning to classify the issue, extract key entities, and draft a response based on your knowledge base.",
    assetType: "workflow_template",
    category: "Customer Support",
    seller: { id: "sel_1", displayName: "AlterX Labs", rating: 4.9 },
    pricing: { type: "free" },
    rating: 4.8,
    reviewCount: 128,
    installCount: 5430,
    tags: ["support", "zendesk", "triage"],
    status: "published",
    createdAt: "2026-01-15T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z"
  },
  {
    id: "mkt_2",
    slug: "invoice-approval-automation",
    title: "Invoice Approval Automation",
    shortDescription: "Extracts invoice data and routes for approval in Slack.",
    description: "Reads incoming PDF invoices, uses OCR to extract line items, and sends an approval request via Slack. Once approved, it can log the entry in an ERP.",
    assetType: "workflow_template",
    category: "Finance",
    seller: { id: "sel_2", displayName: "Acme Automation", rating: 4.5 },
    pricing: { type: "paid", price: 29, currency: "USD" },
    rating: 4.6,
    reviewCount: 45,
    installCount: 890,
    tags: ["finance", "ocr", "slack"],
    status: "published",
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z"
  },
  {
    id: "mkt_3",
    slug: "lead-research-pipeline",
    title: "Lead Research Pipeline",
    shortDescription: "Enriches leads from CRM by scraping public data and synthesizing account profiles.",
    description: "Takes a company name from HubSpot/Salesforce, searches the web, analyzes their recent news, and generates a comprehensive sales brief.",
    assetType: "workflow_template",
    category: "Sales",
    seller: { id: "sel_3", displayName: "FlowForge Studio", rating: 4.7 },
    pricing: { type: "paid", price: 49, currency: "USD" },
    rating: 4.9,
    reviewCount: 210,
    installCount: 1200,
    tags: ["sales", "research", "enrichment"],
    status: "published",
    createdAt: "2026-02-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z"
  },
  {
    id: "mkt_4",
    slug: "competitor-research-project",
    title: "Competitor Research Project",
    shortDescription: "A complete project template for continuous competitor monitoring.",
    description: "Sets up phases for identifying competitors, tracking their social media, scraping pricing changes, and compiling weekly intelligence reports.",
    assetType: "project_template",
    category: "Research",
    seller: { id: "sel_1", displayName: "AlterX Labs", rating: 4.9 },
    pricing: { type: "free" },
    rating: 4.7,
    reviewCount: 88,
    installCount: 3400,
    tags: ["research", "competitor", "monitoring"],
    status: "published",
    createdAt: "2026-04-12T00:00:00Z",
    updatedAt: "2026-05-30T00:00:00Z"
  }
]

const mockListings = mockCatalog.filter(listing => listing.pricing.type === "free")

const mockMyAssets: MarketplaceAssetInstallation[] = [
  {
    id: "inst_1",
    listingId: "mkt_1",
    workspaceId: "ws_default",
    installedAt: "2026-07-15T10:00:00Z",
    installedVersion: "1.2.0",
    createdWorkflowId: "wf_1"
  }
]

const mockReviews: MarketplaceReview[] = [
  {
    id: "rev_1",
    listingId: "mkt_1",
    author: { id: "u_1", name: "Sarah Connor" },
    rating: 5,
    title: "Game changer for our support team",
    body: "This template saved us hours of manual triage every week. Highly recommended!",
    createdAt: "2026-07-20T00:00:00Z"
  },
  {
    id: "rev_2",
    listingId: "mkt_1",
    author: { id: "u_2", name: "John Smith" },
    rating: 4,
    title: "Good, but needed tweaks",
    body: "Works well out of the box but we had to adjust the prompt for our specific product terminology.",
    createdAt: "2026-06-15T00:00:00Z"
  }
]

export const marketplaceService = {
  listings: {
    list: async (filters?: { q?: string }): Promise<MarketplaceListing[]> => {
      if (isLiveApi) return liveListings(filters)
      await delay(400)
      if (filters?.q) {
        const q = filters.q.toLowerCase()
        return mockListings.filter(l => l.title.toLowerCase().includes(q) || l.shortDescription.toLowerCase().includes(q) || l.tags.includes(q))
      }
      return mockListings
    },
    get: async (id: string): Promise<MarketplaceListing> => {
      if (isLiveApi) return mapListing(await apiGet<ListingRecord>(`/api/v1/marketplace/listings/${encodeURIComponent(id)}`))
      await delay(300)
      const listing = mockListings.find(l => l.id === id || l.slug === id)
      if (!listing) throw new Error("Listing not found")
      return listing
    }
  },
  search: async (query: string): Promise<MarketplaceListing[]> => {
    if (isLiveApi) return liveListings({ q: query })
    await delay(300)
    const q = query.toLowerCase()
    return mockListings.filter(l => l.title.toLowerCase().includes(q) || l.tags.includes(q))
  },
  install: async (_id: string) => {
    if (isLiveApi) return liveInstall(_id)
    if (!mockListings.some(listing => listing.id === _id)) throw new Error("Free listing not found")
    await delay(1200)
    return { success: true }
  },
  purchase: async (_id: string) => {
    void _id
    throw new Error("Marketplace listings are free-only in v1")
  },
  myAssets: {
    list: async (): Promise<MarketplaceAssetInstallation[]> => {
      if (isLiveApi) return (await apiGet<InstallRecord[]>("/api/v1/marketplace/my-assets")).map(mapInstall)
      await delay(400)
      return mockMyAssets
    }
  },
  reviews: {
    list: async (listingId: string): Promise<MarketplaceReview[]> => {
      if (isLiveApi) return (await apiGet<ReviewRecord[]>(`/api/v1/marketplace/listings/${encodeURIComponent(listingId)}/reviews`)).map(mapReview)
      await delay(300)
      return mockReviews.filter(r => r.listingId === listingId)
    },
    create: async (listingId: string, data: any): Promise<MarketplaceReview> => {
      if (isLiveApi) {
        const row = await apiPost<ReviewRecord>(`/api/v1/marketplace/listings/${encodeURIComponent(listingId)}/reviews`,
          { rating: data.rating, ...(data.body ? { comment: data.body } : {}) }, { idempotencyKey: mutationKey("marketplace-review") })
        return mapReview(row)
      }
      await delay(600)
      return {
        id: "rev_" + Date.now(),
        listingId,
        author: { id: "u_me", name: "You" },
        rating: data.rating,
        title: data.title,
        body: data.body,
        createdAt: new Date().toISOString()
      }
    }
  }
}
