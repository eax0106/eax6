import { Inject, Injectable } from "@nestjs/common";
import { ENTITLEMENT_PROVIDER, type EntitlementProvider } from "../entitlements/entitlement-provider.interface";
import { marketplaceId } from "./id";
import { MarketplaceHttpError } from "./problem";
import { MarketplaceRepository, type ListingCursor } from "./marketplace.repository";
import type { MarketplacePayloadStore } from "./payload-store";
import { MARKETPLACE_PAYLOAD_STORE } from "./tokens";
import { parseInstalledPayloadRef } from "./validation";
import type { StaffActorContext } from "../rbac/types";
import type { CompatibilityRequirement, CompatibilityResult, CreateListingInput, CreateListingVersionInput, CreateReviewInput, InstallListingInput, ListingQuery, ListingRecord, ListingVersionRecord, UpdateListingInput } from "./types";

// Sellers submit through the Publisher endpoint, which verifies them first.
// Only staff can advance or publish listings after submission.
const PUBLISH_ROLES: ReadonlyArray<StaffActorContext["roles"][number]> = [
  "staff_admin",
  "staff_security",
  "staff_support",
];

const transitions: Readonly<Record<string, readonly string[]>> = {
  draft: ["private_testing", "submitted", "removed"],
  private_testing: ["submitted", "draft", "removed"],
  submitted: ["automated_review", "private_testing", "removed"],
  automated_review: ["human_review", "published", "private_testing", "removed"],
  human_review: ["published", "private_testing", "removed"],
  needs_changes: [],
  published: ["suspended", "deprecated", "removed"],
  suspended: ["published", "deprecated", "removed"],
  deprecated: ["removed"],
  removed: [],
};

@Injectable()
export class MarketplaceService {
  constructor(
    private readonly repository: MarketplaceRepository,
    @Inject(ENTITLEMENT_PROVIDER) private readonly entitlements: EntitlementProvider,
    @Inject(MARKETPLACE_PAYLOAD_STORE) private readonly objects: MarketplacePayloadStore,
  ) {}

  list(tenantId: string, query: ListingQuery, cursor?: ListingCursor) { return this.repository.listListings(tenantId, query, cursor); }
  async get(tenantId: string, listingId: string): Promise<ListingRecord> { const listing=await this.requireListing(tenantId,listingId);if(BigInt(listing.priceMinor)!==0n)throw this.notFound(listingId);return listing; }
  async create(tenantId: string, input: CreateListingInput) { if(BigInt(input.price_minor??"0")!==0n)throw paidUnavailable();return this.repository.createListing(tenantId, marketplaceId("lst"), input); }
  async update(tenantId: string, listingId: string, input: UpdateListingInput, staff?: StaffActorContext) {
    const current = await this.requireOwnedListing(tenantId, listingId);
    if(input.price_minor!==undefined && BigInt(input.price_minor)!==0n)throw paidUnavailable();
    if (input.price_minor !== undefined && !["draft", "private_testing", "needs_changes"].includes(current.status)) {
      throw new MarketplaceHttpError(409, "MARKETPLACE_PRICE_LOCKED", "Price can be changed only before submission.", `/api/v1/marketplace/listings/${listingId}`);
    }
    if (input.status && !transitions[current.status]!.includes(input.status)) throw new MarketplaceHttpError(409, "MARKETPLACE_INVALID_STATUS_TRANSITION", `Cannot transition listing from ${current.status} to ${input.status}.`, `/api/v1/marketplace/listings/${listingId}`);
    if (input.status && ["submitted", "automated_review", "human_review", "needs_changes", "published"].includes(input.status) && !this.isPublishAuthorized(staff)) {
      throw new MarketplaceHttpError(
        403,
        "MARKETPLACE_PUBLISH_REQUIRES_STAFF",
        input.status === "published" ? "Publishing a marketplace listing requires staff review." : "Listing review transitions require staff review.",
        `/api/v1/marketplace/listings/${listingId}`,
      );
    }
    if (input.status === "published" && !(await this.repository.findLatestVersion(tenantId, listingId))) {
      throw new MarketplaceHttpError(409, "MARKETPLACE_VERSION_REQUIRED", "A listing version is required before publishing.", `/api/v1/marketplace/listings/${listingId}`);
    }
    if (input.status === "published" && BigInt(current.priceMinor) > 0n) {
      throw new MarketplaceHttpError(409, "MARKETPLACE_PAID_CHECKOUT_UNAVAILABLE", "Paid listings cannot be published until checkout is ready.", `/api/v1/marketplace/listings/${listingId}`);
    }
    const result = input.status === "published"
      ? await this.repository.publishListing(tenantId, listingId)
      : await this.repository.updateListing(tenantId, listingId, input);
    if (!result) throw this.notFound(listingId);
    return result;
  }

  async publish(staff: StaffActorContext, tenantId: string, listingId: string) {
    return this.update(tenantId, listingId, { status: "published" }, staff);
  }

  async staffTransition(staff: StaffActorContext, tenantId: string, listingId: string, status: "automated_review" | "human_review" | "private_testing") {
    return this.update(tenantId, listingId, { status }, staff);
  }

  private isPublishAuthorized(staff?: StaffActorContext): boolean {
    if (!staff) return false;
    return staff.roles.some((role) => (PUBLISH_ROLES as readonly string[]).includes(role));
  }
  listVersions(tenantId: string, listingId: string) { return this.repository.listVersions(tenantId, listingId); }
  async createVersion(tenantId: string, listingId: string, input: CreateListingVersionInput) { await this.requireOwnedListing(tenantId, listingId); return this.repository.createVersion(tenantId, marketplaceId("lsv"), listingId, input); }
  async compatibility(tenantId: string, listingId: string, versionId: string): Promise<CompatibilityResult> {
    const version = await this.repository.findVersion(tenantId, listingId, versionId);
    if (!version) throw this.notFound(versionId);
    return this.compatibilityForVersion(tenantId, version);
  }
  async install(tenantId: string, workspaceId: string, listingId: string, input: InstallListingInput, idempotencyKey: string) {
    const previous = await this.repository.findInstallByIdempotencyKey(tenantId, idempotencyKey);
    if (previous) {
      if (previous.listingId === listingId && previous.listingVersionId === input.listing_version_id) return previous;
      throw new MarketplaceHttpError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another install.", `/api/v1/marketplace/listings/${listingId}/actions/install`);
    }
    const listing = await this.requireListing(tenantId, listingId);
    if(BigInt(listing.priceMinor)!==0n)throw paidUnavailable();
    const entitlement = await this.entitlements.getEffectiveEntitlement(tenantId);
    if (entitlement.accessState !== "active") throw new MarketplaceHttpError(403, "MARKETPLACE_ENTITLEMENT_INACTIVE", `Marketplace install requires active entitlement; current state is ${entitlement.accessState}.`, `/api/v1/marketplace/listings/${listingId}/actions/install`);
    const version = await this.repository.findVersion(tenantId, listingId, input.listing_version_id);
    if (!version) throw this.notFound(input.listing_version_id);
    if (version.publishedAt === null && listing.tenantId !== tenantId) {
      throw this.notFound(input.listing_version_id);
    }
    const compatibility = await this.compatibilityForVersion(tenantId, version);
    if (!compatibility.compatible) throw new MarketplaceHttpError(409, "MARKETPLACE_INCOMPATIBLE", "Listing version does not meet tenant requirements.", `/api/v1/marketplace/listings/${listingId}/actions/install`);
    const installedPayloadRef = await this.copyPayload(version, tenantId);
    return this.repository.createInstall(tenantId, marketplaceId("ins"), workspaceId, listing.id, version.id, installedPayloadRef, listing.licenseType, idempotencyKey);
  }
  listAssets(tenantId: string) { return this.repository.listAssets(tenantId); }
  async createReview(tenantId: string, listingId: string, input: CreateReviewInput) {
    const install = await this.repository.findInstallForListing(tenantId, listingId);
    if (!install) throw new MarketplaceHttpError(403, "MARKETPLACE_REVIEW_REQUIRES_INSTALL", "Review requires an installed listing.", `/api/v1/marketplace/listings/${listingId}/reviews`);
    try { return await this.repository.createReview(tenantId, marketplaceId("rev"), listingId, install.id, input); }
    catch (error: unknown) { if (isUniqueViolation(error)) throw new MarketplaceHttpError(409, "MARKETPLACE_REVIEW_ALREADY_EXISTS", "Tenant already reviewed this listing.", `/api/v1/marketplace/listings/${listingId}/reviews`); throw error; }
  }
  listReviews(tenantId: string, listingId: string) { return this.repository.listReviews(tenantId, listingId); }
  private async requireListing(tenantId: string, listingId: string) { const listing = await this.repository.findListing(tenantId, listingId); if (!listing) throw this.notFound(listingId); return listing; }
  private async requireOwnedListing(tenantId: string, listingId: string) { const listing = await this.requireListing(tenantId, listingId); if (listing.tenantId !== tenantId) throw this.notFound(listingId); return listing; }
  private notFound(id: string) { return new MarketplaceHttpError(404, "MARKETPLACE_NOT_FOUND", "Marketplace resource was not found.", `/api/v1/marketplace/${id}`); }
  private async copyPayload(version: ListingVersionRecord, tenantId: string): Promise<string> { const source = new URL(version.payloadRef); if (source.protocol !== "s3:") throw new MarketplaceHttpError(502, "MARKETPLACE_PAYLOAD_COPY_FAILED", "Listing payload reference is not supported.", `/api/v1/marketplace/listings/${version.listingId}/actions/install`); const reference = `s3://${source.hostname}/tenants/${encodeURIComponent(tenantId)}/marketplace/${version.id}/${source.pathname.split("/").at(-1) ?? "payload"}`; await this.objects.putObject(reference, await this.objects.getObject(version.payloadRef), "application/octet-stream"); return parseInstalledPayloadRef(reference, `/api/v1/marketplace/listings/${version.listingId}/actions/install`); }
  private async compatibilityForVersion(tenantId: string, version: ListingVersionRecord): Promise<CompatibilityResult> {
    const entitlement = await this.entitlements.getEffectiveEntitlement(tenantId);
    const requirements: CompatibilityRequirement[] = [
      { kind: "dag_schema", name: version.compatibility.dagSchemaVersion, satisfied: true, reason: null },
      ...version.compatibility.nodeTypes.map((name) => ({ kind: "node_type" as const, name, satisfied: true, reason: null })),
      ...version.compatibility.connectorCapabilities.map((name) => ({ kind: "connector_capability" as const, name, satisfied: true, reason: null })),
      ...version.compatibility.requiredEntitlements.map((name) => ({ kind: "entitlement" as const, name, satisfied: entitlement.limits[name as keyof typeof entitlement.limits] > 0, reason: entitlement.limits[name as keyof typeof entitlement.limits] > 0 ? null : `Tenant plan has no ${name}.` })),
    ];
    return { compatible: requirements.every((item) => item.satisfied), requirements, permissions: ["marketplace:install"] };
  }
}
function paidUnavailable(){return new MarketplaceHttpError(409,"MARKETPLACE_FREE_ONLY","Marketplace listings are free-only in v1.","/api/v1/marketplace/listings");}
function isUniqueViolation(error: unknown): error is { code: string } { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505"; }
