export const listingTypes = [
  "workflow_template",
  "project_template",
  "agent",
  "tool",
] as const;
export type ListingType = (typeof listingTypes)[number];

export const listingStatuses = [
  "draft",
  "private_testing",
  "submitted",
  "automated_review",
  "human_review",
  "needs_changes",
  "published",
  "suspended",
  "deprecated",
  "removed",
] as const;
export type ListingStatus = (typeof listingStatuses)[number];

export const licenseTypes = ["single_workspace", "tenant_wide"] as const;
export type LicenseType = (typeof licenseTypes)[number];

export interface ListingCompatibility {
  readonly dagSchemaVersion: string;
  readonly nodeTypes: readonly string[];
  readonly connectorCapabilities: readonly string[];
  readonly requiredEntitlements: readonly string[];
}

export interface ListingRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly type: ListingType;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: string | null;
  readonly licenseType: LicenseType;
  readonly priceMinor: string;
  readonly currency: "INR";
  readonly status: ListingStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListingVersionRecord {
  readonly id: string;
  readonly listingId: string;
  readonly version: string;
  readonly payloadRef: string;
  readonly compatibility: ListingCompatibility;
  readonly publishedAt: Date | null;
}

export interface InstallRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly listingId: string;
  readonly listingVersionId: string;
  /** Tenant-owned copy; source version pointer stays in listingVersionId. */
  readonly installedPayloadRef: string;
  readonly licenseType: LicenseType;
  readonly idempotencyKey: string;
  readonly installedAt: Date;
}

export interface ReviewRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly listingId: string;
  readonly installId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly createdAt: Date;
}

export interface CreateListingInput {
  readonly type: ListingType;
  readonly name: string;
  readonly description?: string;
  readonly license_type: LicenseType;
  readonly price_minor?: string;
}

export interface UpdateListingInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly license_type?: LicenseType;
  readonly price_minor?: string;
  readonly status?: ListingStatus;
}

export interface CreateListingVersionInput {
  readonly version: string;
  readonly payload_ref: string;
  readonly compatibility: ListingCompatibility;
}

export interface InstallListingInput {
  readonly listing_version_id: string;
  readonly confirmed: true;
}

export interface CreateReviewInput {
  readonly rating: number;
  readonly comment?: string;
}

export interface ListingQuery {
  readonly owner?: "me";
  readonly type?: ListingType;
  readonly status?: ListingStatus;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly requirements: readonly CompatibilityRequirement[];
  readonly permissions: readonly string[];
}

export interface CompatibilityRequirement {
  readonly kind:
    | "entitlement"
    | "node_type"
    | "connector_capability"
    | "dag_schema";
  readonly name: string;
  readonly satisfied: boolean;
  readonly reason: string | null;
}

export const marketplaceDeferredCapabilities = [
  {
    capability: "node_type_connector_compatibility_validation",
    status: "NOT_MET",
    reason: "Node Type Registry relay is not available to platform-api.",
  },
] as const;
