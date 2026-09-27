import { isLiveApi } from "@/api/http"

// Live-mode availability (#212). A feature is listed as unfinished until its
// live adapter is wired and verified; demo mode shows everything. The admin
// console is gated per section (Track B1), so each section appears only once
// its own backend is wired -- the console's shell is gated by staff sign-in
// (StaffGate), not here.
export type LiveFeature =
  | "admin-tenants" | "admin-users" | "admin-support" | "admin-providers" | "admin-deployments" | "admin-incidents" | "admin-system-status" | "admin-audit" | "admin-policies" | "admin-security" | "admin-billing" | "admin-marketplace" | "admin-feature-flags"
  | "benchmarks"
  | "discovery"
  | "notifications"

export const liveFeatureNames: Record<LiveFeature, string> = {
  "admin-tenants": "Admin: Tenants",
  "admin-users": "Admin: Users",
  "admin-support": "Admin: Support Access",
  "admin-providers": "Admin: Providers",
  "admin-deployments": "Admin: Deployments",
  "admin-incidents": "Admin: Incidents",
  "admin-system-status": "Admin: System Status",
  "admin-audit": "Admin: Audit Explorer",
  "admin-policies": "Admin: Policies",
  "admin-security": "Admin: Security & Abuse",
  "admin-billing": "Admin: Billing Ops",
  "admin-marketplace": "Admin: Marketplace",
  "admin-feature-flags": "Admin: Feature Flags",
  benchmarks: "Benchmarks",
  discovery: "Discovery",
  notifications: "Notifications",
}

const unfinishedLiveFeatures = new Set<LiveFeature>([
  "admin-support",
  "admin-deployments",
  "admin-incidents",
  "admin-security",
  "admin-billing",
  "admin-marketplace",
  "benchmarks",
  "discovery",
  "notifications",
])

export function isLiveFeatureAvailable(feature: LiveFeature, live = isLiveApi) {
  return !live || !unfinishedLiveFeatures.has(feature)
}

/** The admin section that owns an admin console path, for route and sidebar gating. */
export function adminSectionFor(href: string): LiveFeature | undefined {
  const path = href.replace(/^\/app\/admin\/?/, "").split("/")[0] ?? ""
  return adminSectionByPath[path]
}

const adminSectionByPath: Record<string, LiveFeature> = {
  "tenants": "admin-tenants",
  "": "admin-tenants",
  "users": "admin-users",
  "support": "admin-support",
  "providers": "admin-providers",
  "deployments": "admin-deployments",
  "incidents": "admin-incidents",
  "system-status": "admin-system-status",
  "audit": "admin-audit",
  "policies": "admin-policies",
  "security": "admin-security",
  "billing": "admin-billing",
  "marketplace": "admin-marketplace",
  "feature-flags": "admin-feature-flags",
}
