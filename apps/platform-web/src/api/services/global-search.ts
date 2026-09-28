import { type GlobalSearchResult } from "../types"
import { apiGet, isLiveApi } from "../http"
import { getConnections, getKnowledgeSources, searchProjects, searchWorkflows } from "../live"

// Listings, workflows and projects are searched server-side (the engine
// searches workflow and project names across the whole workspace, task B3.4).
// Knowledge sources and connections are filtered here over the lists the
// spotlight can already read: both are short, per-workspace lists.
const GROUP_LIMIT = 5

// Typing re-runs this on every debounce tick, and the lists it reads change far
// more slowly than the query does.
const LIST_TTL_MS = 10_000
const listCache = new Map<string, { at: number; value: Promise<unknown> }>()

function cachedList<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
  const cached = listCache.get(key)
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.value as Promise<T[]>
  const value = load().catch((error) => {
    listCache.delete(key)
    throw error
  })
  listCache.set(key, { at: Date.now(), value })
  return value
}

const matches = (query: string, ...fields: (string | undefined)[]) =>
  fields.some((field) => field?.toLowerCase().includes(query))

interface ListingHit {
  id: string
  name: string
  description: string | null
}

async function listingResults(query: string): Promise<GlobalSearchResult[]> {
  const path = `/api/v1/search?q=${encodeURIComponent(query)}&kind=listing&limit=${GROUP_LIMIT}`
  const result = await apiGet<{ data: ListingHit[] }>(path)
  return result.data.map((hit) => ({
    id: hit.id,
    type: "marketplace_listing" as const,
    title: hit.name,
    description: hit.description ?? undefined,
    url: `/app/marketplace/listings/${encodeURIComponent(hit.id)}`,
  }))
}

async function liveResults(query: string): Promise<GlobalSearchResult[]> {
  const q = query.toLowerCase()
  const sources: Promise<GlobalSearchResult[]>[] = [
    listingResults(query),
    searchWorkflows(query.trim(), GROUP_LIMIT).then((items) =>
      items
        .map((workflow) => ({
          id: workflow.id,
          type: "workflow" as const,
          title: workflow.name,
          description: workflow.description,
          url: `/app/workflows/${encodeURIComponent(workflow.id)}`,
        })),
    ),
    searchProjects(query.trim(), GROUP_LIMIT).then((items) =>
      items
        .map((project) => ({
          id: project.id,
          type: "project" as const,
          title: project.name,
          description: project.brief?.goal,
          url: `/app/projects/${encodeURIComponent(project.id)}`,
        })),
    ),
    cachedList("knowledge-sources", getKnowledgeSources).then((items) =>
      items
        .filter((source) => matches(q, source.name, source.type))
        .slice(0, GROUP_LIMIT)
        .map((source) => ({
          id: source.id,
          type: "knowledge_source" as const,
          title: source.name,
          description: source.type,
          url: `/app/knowledge/sources/${encodeURIComponent(source.id)}`,
        })),
    ),
    cachedList("connections", getConnections).then((items) =>
      items
        .filter((connection) => matches(q, connection.name, connection.integrationId))
        .slice(0, GROUP_LIMIT)
        .map((connection) => ({
          id: connection.id,
          type: "connection" as const,
          title: connection.name,
          description: connection.status,
          url: `/app/connections/${encodeURIComponent(connection.id)}`,
        })),
    ),
  ]

  // A caller without permission for one of these reads still gets every other
  // group, rather than an empty spotlight.
  const settled = await Promise.allSettled(sources)
  return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockGlobalResults: GlobalSearchResult[] = [
  { id: "wf_1", type: "workflow", title: "Customer Support Triage", description: "Categorize incoming tickets", url: "/app/workflows/wf_1" },
  { id: "wf_2", type: "workflow", title: "Invoice Processing", description: "Extract data from invoices", url: "/app/workflows/wf_2" },
  { id: "proj_1", type: "project", title: "Competitor Analysis", description: "Q3 Competitor tracking", url: "/app/projects/proj_1" },
  { id: "ks_1", type: "knowledge_source", title: "Company Wiki", description: "Internal confluence docs", url: "/app/knowledge/sources/ks_1" },
  { id: "conn_1", type: "connection", title: "Zendesk Prod", description: "Main Zendesk integration", url: "/app/connections/conn_1" },
  { id: "mkt_1", type: "marketplace_listing", title: "AI Customer Support Triage", description: "Template from AlterX Labs", url: "/app/marketplace/listings/mkt_1" },
]

export const globalSearchService = async (query: string): Promise<GlobalSearchResult[]> => {
  if (!query) return []
  if (isLiveApi) return liveResults(query)
  await delay(300)
  const q = query.toLowerCase()
  return mockGlobalResults.filter(r => r.title.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q))
}
