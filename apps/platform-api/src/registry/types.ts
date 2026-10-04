export const ecosystems = ["npm", "pip", "mcp"] as const;
export const trustLevels = ["alter_verified", "verified_publisher", "community_reviewed", "unverified_private", "blocked"] as const;
// ENGINE-FIX-P3-10: "scan_unavailable" is distinct from "scan_failed" --
// the latter means a scan ran and rejected the package (or errored trying
// to), the former means no real scanner is wired at all, so nothing was
// actually evaluated. Collapsing them together made an absent scanner look
// like a security verdict.
export const versionStatuses = ["draft", "scanning", "scan_failed", "scan_unavailable", "review_pending", "published", "revoked"] as const;
export type Ecosystem = (typeof ecosystems)[number];
export type TrustLevel = (typeof trustLevels)[number];
export type VersionStatus = (typeof versionStatuses)[number];
export type ManifestStatus = "draft" | "published" | "blocked";
export interface ToolManifest { readonly id: string; readonly tenantId: string | null; readonly name: string; readonly ecosystem: Ecosystem; readonly description: string | null; readonly trustLevel: TrustLevel; readonly status: ManifestStatus; readonly publisherId: string | null; readonly createdAt: string; readonly updatedAt: string; }
export type ToolVersion = import("@alterx/shared-clients").RegistryToolVersion;
export type ScanReport = import("@alterx/shared-clients").RegistryScanReport;
export interface Revocation { readonly id: string; readonly manifestId: string; readonly toolVersionId: string; readonly reason: string; readonly revokedBy: string; readonly revokedAt: string; readonly propagatedAt: string | null; }
export interface CreateManifestInput { readonly name: string; readonly ecosystem: Ecosystem; readonly description?: string; readonly trust_level: TrustLevel; readonly publisher_id?: string; }
export interface CreateVersionInput { readonly version: string; readonly artifact_ref: string; readonly capabilities: readonly string[]; readonly permissions: readonly string[]; readonly pinned?: boolean; }
