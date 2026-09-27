import { apiGet, apiPatch, apiPut } from "./http"
import type { FeatureFlag, PlatformPolicy, ProviderDefinition } from "./types"

// Admin console, feature flags / providers / policies (tasks B1.4, B1.6, B1.7):
// live adapter over /api/v1/admin/policy/feature-flags, /api/v1/admin/providers,
// /api/v1/admin/policy/plans and /api/v1/admin/policy/model. Every change the
// API records carries a reason; the console's toggles have no reason field, so
// they send a fixed one naming where the change came from -- the staff member
// is recorded by the API from the session.

type AnyRecord = Record<string, unknown>
const CONSOLE_REASON = "Changed in the admin console"

// --- Feature flags -----------------------------------------------------------

function mapFlag(value: unknown): FeatureFlag {
  const item = value as AnyRecord
  const name = String(item.name)
  return {
    id: name,
    key: name,
    name,
    description: typeof item.description === "string" ? item.description : undefined,
    enabled: item.enabled === true,
    scope: "global",
    updatedAt: String(item.updated_at),
    updatedBy: { id: String(item.updated_by), name: String(item.updated_by) },
  }
}

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const body = await apiGet<unknown>("/api/v1/admin/policy/feature-flags")
  return (Array.isArray(body) ? body : []).map(mapFlag)
}

export async function updateFeatureFlag(current: FeatureFlag, enabled: boolean): Promise<FeatureFlag> {
  return mapFlag(
    await apiPut<unknown>(`/api/v1/admin/policy/feature-flags/${encodeURIComponent(current.key)}`, {
      enabled,
      description: current.description ?? current.name,
      reason: CONSOLE_REASON,
    }),
  )
}

// --- Providers ---------------------------------------------------------------

function mapProvider(value: unknown): ProviderDefinition {
  const item = value as AnyRecord
  const active = item.active === true
  const health = String(item.health)
  const status: ProviderDefinition["status"] = !active
    ? "disabled"
    : health === "healthy"
      ? "healthy"
      : health === "degraded"
        ? "degraded"
        : "outage"
  const interfaceName = String(item.interface_name)
  return {
    id: String(item.provider_id),
    name: String(item.provider_id),
    type: /model/i.test(interfaceName) ? "model" : "other",
    status,
    enabled: active,
    lastCheckedAt: typeof item.checked_at === "string" ? item.checked_at : undefined,
    latencyMs: typeof item.latency_ms === "number" ? item.latency_ms : undefined,
    metadata: {
      interface: interfaceName,
      configurationRevision: item.configuration_revision,
      fallbackChain: item.fallback_chain,
    },
  }
}

export async function listProviders(): Promise<ProviderDefinition[]> {
  const body = await apiGet<unknown>("/api/v1/admin/providers")
  return (Array.isArray(body) ? body : []).map(mapProvider)
}

export async function setProviderActive(id: string, active: boolean): Promise<ProviderDefinition> {
  return mapProvider(
    await apiPatch<unknown>(`/api/v1/admin/providers/${encodeURIComponent(id)}`, { active, reason: CONSOLE_REASON }),
  )
}

// --- Policies: plan definitions and model alias bindings ----------------------

export async function listPolicies(): Promise<PlatformPolicy[]> {
  const [plans, model] = await Promise.all([
    apiGet<unknown>("/api/v1/admin/policy/plans"),
    apiGet<AnyRecord>("/api/v1/admin/policy/model"),
  ])
  const planPolicies: PlatformPolicy[] = (Array.isArray(plans) ? plans : []).map((value) => {
    const item = value as AnyRecord
    return {
      id: `plan:${String(item.plan)}`,
      name: `Plan limits: ${String(item.plan)}`,
      category: "billing",
      status: "active",
      description: `Entitlement limits every tenant on the ${String(item.plan)} plan runs under.`,
      scope: "global",
      config: (item.limits as Record<string, unknown>) ?? {},
      updatedAt: String(item.updated_at),
      updatedBy: { id: String(item.updated_by), name: String(item.updated_by) },
    }
  })
  const bindings = (model?.bindings as Record<string, AnyRecord> | undefined) ?? {}
  const aliasPolicies: PlatformPolicy[] = Object.entries(bindings).map(([alias, binding]) => ({
    id: `model:${alias}`,
    name: `Model alias: ${alias}`,
    category: "execution",
    status: "active",
    description: `Which model serves the ${alias} alias (policy version ${String(model?.version ?? "?")}).`,
    scope: "global",
    config: binding,
  }))
  return [...planPolicies, ...aliasPolicies]
}
