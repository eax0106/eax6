import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EffectiveEntitlement,
  EntitlementAccessState,
  EntitlementLimits,
} from "../entitlements/types";
import type { EntitlementProvider } from "../entitlements/entitlement-provider.interface";
import { MarketplaceRepository } from "./marketplace.repository";
import { MarketplaceService } from "./marketplace.service";
import type { StaffActorContext } from "../rbac/types";
import { createInMemoryPayloadStore } from "./payload-store";
import type {
  InstallRecord,
  ListingCompatibility,
  ListingRecord,
  ListingStatus,
  ListingVersionRecord,
  ReviewRecord,
} from "./types";

const tenantId = "ten_018f47a5-7b2c-7d10-8f11-1234567890ab";
const workspaceId = "ws_018f47a5-7b2c-7d10-8f11-1234567890ac";
const listingId = "lst_018f47a5-7b2c-7d10-8f11-1234567890ad";
const versionId = "lsv_018f47a5-7b2c-7d10-8f11-1234567890ae";
const otherListingId = "lst_018f47a5-7b2c-7d10-8f11-1234567890af";
const sourceRef = "s3://catalog-bucket/listings/template.json";
const createdAt = new Date("2026-08-04T10:00:00.000Z");

const fullLimits: EntitlementLimits = {
  maxWorkflows: 3,
  maxProjects: 1,
  maxRunsPerDay: 10,
  maxConcurrentRuns: 1,
  maxSandboxMinutesPerMonth: 30,
  maxAdsStorageMb: 500,
  maxIntegrations: 3,
};

function entitlement(
  overrides: {
    limits?: Partial<EntitlementLimits>;
    accessState?: EntitlementAccessState;
  } = {},
): EffectiveEntitlement {
  return {
    tenantId,
    plan: "free",
    limits: { ...fullLimits, ...overrides.limits },
    accessState: overrides.accessState ?? "active",
    source: "config",
  };
}

function compatibility(
  overrides: Partial<ListingCompatibility> = {},
): ListingCompatibility {
  return {
    dagSchemaVersion: "1.0.0",
    nodeTypes: [],
    connectorCapabilities: [],
    requiredEntitlements: [],
    ...overrides,
  };
}

function listing(overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: listingId,
    tenantId,
    type: "workflow_template",
    name: "Lead qualification",
    description: null,
    latestVersion: "1.0.0",
    licenseType: "single_workspace",
    priceMinor: "0",
    currency: "INR",
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function version(
  overrides: Partial<ListingVersionRecord> = {},
): ListingVersionRecord {
  return {
    id: versionId,
    listingId,
    version: "1.0.0",
    payloadRef: sourceRef,
    compatibility: compatibility(),
    publishedAt: createdAt,
    ...overrides,
  };
}

function install(overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    id: "ins_018f47a5-7b2c-7d10-8f11-1234567890b0",
    tenantId,
    workspaceId,
    listingId,
    listingVersionId: versionId,
    installedPayloadRef: "s3://catalog-bucket/tenants/x/marketplace/y/template.json",
    licenseType: "single_workspace",
    idempotencyKey: "idem-1",
    installedAt: createdAt,
    ...overrides,
  };
}

interface Harness {
  service: MarketplaceService;
  repository: {
    findListing: ReturnType<typeof vi.fn>;
    updateListing: ReturnType<typeof vi.fn>;
    publishListing: ReturnType<typeof vi.fn>;
    findLatestVersion: ReturnType<typeof vi.fn>;
    findVersion: ReturnType<typeof vi.fn>;
    findInstallByIdempotencyKey: ReturnType<typeof vi.fn>;
    createInstall: ReturnType<typeof vi.fn>;
    findInstallForListing: ReturnType<typeof vi.fn>;
    createReview: ReturnType<typeof vi.fn>;
  };
  store: ReturnType<typeof createInMemoryPayloadStore>;
  putSpy: ReturnType<typeof vi.spyOn>;
  setEntitlement: (value: EffectiveEntitlement) => void;
}

function harness(): Harness {
  let current = entitlement();
  const installs: InstallRecord[] = [];

  const repository = {
    findListing: vi.fn(async () => listing()),
    updateListing: vi.fn(
      async (_tenant: string, id: string, input: { status?: ListingStatus }) =>
        listing({ id, status: input.status ?? "draft" }),
    ),
    publishListing: vi.fn(async (_tenant: string, id: string) => listing({ id, status: "published" })),
    findLatestVersion: vi.fn(async () => version()),
    findVersion: vi.fn(async () => version()),
    findInstallByIdempotencyKey: vi.fn(
      async (_tenant: string, key: string) =>
        installs.find((row) => row.idempotencyKey === key),
    ),
    createInstall: vi.fn(
      async (
        _tenant: string,
        id: string,
        workspace: string,
        listing_: string,
        listingVersionId: string,
        installedPayloadRef: string,
        licenseType: InstallRecord["licenseType"],
        idempotencyKey: string,
      ) => {
        const record = install({
          id,
          workspaceId: workspace,
          listingId: listing_,
          listingVersionId,
          installedPayloadRef,
          licenseType,
          idempotencyKey,
        });
        installs.push(record);
        return record;
      },
    ),
    findInstallForListing: vi.fn(async () => install()),
    createReview: vi.fn(
      async (
        _tenant: string,
        id: string,
        listing_: string,
        installId: string,
        input: { rating: number; comment?: string },
      ): Promise<ReviewRecord> => ({
        id,
        tenantId,
        listingId: listing_,
        installId,
        rating: input.rating,
        comment: input.comment ?? null,
        createdAt,
      }),
    ),
  };

  const store = createInMemoryPayloadStore(
    new Map([[sourceRef, Buffer.from("payload-bytes")]]),
  );
  const putSpy = vi.spyOn(store, "putObject");

  const entitlements: EntitlementProvider = {
    getEffectiveEntitlement: vi.fn(async () => current),
    checkLimit: vi.fn(),
    createEntitlement: vi.fn(),
  } as unknown as EntitlementProvider;

  const service = new MarketplaceService(
    repository as unknown as MarketplaceRepository,
    entitlements,
    store,
  );

  return {
    service,
    repository,
    store,
    putSpy,
    setEntitlement: (value) => {
      current = value;
    },
  };
}

describe("MarketplaceService", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("rejects priced creation, edits, details, publication and install before persistence or payload copy", async () => {
    await expect(h.service.create(tenantId,{type:"agent",name:"Paid",license_type:"tenant_wide",price_minor:"100"})).rejects.toMatchObject({status:409,response:{error_code:"MARKETPLACE_FREE_ONLY"}});
    await expect(h.service.update(tenantId,listingId,{price_minor:"100"})).rejects.toMatchObject({status:409,response:{error_code:"MARKETPLACE_FREE_ONLY"}});
    h.repository.findListing.mockResolvedValue(listing({status:"published",priceMinor:"100"}));
    await expect(h.service.get(tenantId,listingId)).rejects.toMatchObject({status:404});
    await expect(h.service.install(tenantId,workspaceId,listingId,{listing_version_id:versionId,confirmed:true},"paid-install")).rejects.toMatchObject({status:409,response:{error_code:"MARKETPLACE_FREE_ONLY"}});
    expect(h.repository.createInstall).not.toHaveBeenCalled();expect(h.putSpy).not.toHaveBeenCalled();
    h.repository.findListing.mockResolvedValue(listing({status:"human_review",priceMinor:"100"}));
    const staff:StaffActorContext={staff_user_id:"stf_1",identity_ref:"x",email:"s@x",roles:["staff_admin"]};
    await expect(h.service.publish(staff,tenantId,listingId)).rejects.toMatchObject({status:409,response:{error_code:"MARKETPLACE_PAID_CHECKOUT_UNAVAILABLE"}});
    expect(h.repository.publishListing).not.toHaveBeenCalled();
  });

  // Spec 7 — transition table, not enum validation.
  describe("listing status transitions", () => {
    it.each([
      ["draft", "private_testing"],
      ["published", "removed"],
    ] as const)("allows %s to %s", async (from, to) => {
      h.repository.findListing.mockResolvedValueOnce(listing({ status: from }));
      await expect(
        h.service.update(tenantId, listingId, { status: to }),
      ).resolves.toMatchObject({ status: to });
    });

    it.each([
      ["draft", "published"],
      ["removed", "draft"],
      ["deprecated", "published"],
    ] as const)("rejects %s to %s naming both states", async (from, to) => {
      h.repository.findListing.mockResolvedValueOnce(listing({ status: from }));
      await expect(
        h.service.update(tenantId, listingId, { status: to }),
      ).rejects.toMatchObject({
        response: {
          error_code: "MARKETPLACE_INVALID_STATUS_TRANSITION",
          detail: `Cannot transition listing from ${from} to ${to}.`,
        },
      });
      expect(h.repository.updateListing).not.toHaveBeenCalled();
    });
  });

  // ENGINE-FIX-B1-SECURITY #5 — tenants cannot self-publish; publishing
  // requires a staff actor (bypassing staff review is the vulnerability).
  describe("publishing requires staff review", () => {
    it("rejects a tenant self-publishing from automated_review", async () => {
      h.repository.findListing.mockResolvedValueOnce(listing({ status: "automated_review" }));
      await expect(
        h.service.update(tenantId, listingId, { status: "published" }),
      ).rejects.toMatchObject({
        response: {
          error_code: "MARKETPLACE_PUBLISH_REQUIRES_STAFF",
          detail: "Publishing a marketplace listing requires staff review.",
        },
      });
      expect(h.repository.updateListing).not.toHaveBeenCalled();
    });

    it("rejects a tenant self-publishing from human_review", async () => {
      h.repository.findListing.mockResolvedValueOnce(listing({ status: "human_review" }));
      await expect(
        h.service.update(tenantId, listingId, { status: "published" }),
      ).rejects.toMatchObject({
        response: { error_code: "MARKETPLACE_PUBLISH_REQUIRES_STAFF" },
      });
      expect(h.repository.updateListing).not.toHaveBeenCalled();
    });

    it("allows a staff actor to publish from human_review", async () => {
      h.repository.findListing.mockResolvedValueOnce(listing({ status: "human_review" }));
      const staff: StaffActorContext = { staff_user_id: "stf_1", identity_ref: "x", email: "s@x", roles: ["staff_admin"] };
      await expect(
        h.service.update(tenantId, listingId, { status: "published" }, staff),
      ).resolves.toMatchObject({ status: "published" });
    });

    it("publish() uses the owning tenant and publishes as staff", async () => {
      h.repository.findListing.mockResolvedValueOnce(listing({ tenantId, status: "automated_review" }));
      const staff: StaffActorContext = { staff_user_id: "stf_1", identity_ref: "x", email: "s@x", roles: ["staff_security"] };
      await expect(h.service.publish(staff, tenantId, listingId)).resolves.toMatchObject({ status: "published" });
      expect(h.repository.findListing).toHaveBeenCalledWith(tenantId, listingId);
    });

    it("publish() rejects unknown listing with not found", async () => {
      h.repository.findListing.mockResolvedValueOnce(undefined);
      const staff: StaffActorContext = { staff_user_id: "stf_1", identity_ref: "x", email: "s@x", roles: ["staff_admin"] };
      await expect(h.service.publish(staff, tenantId, listingId)).rejects.toMatchObject({
        response: { error_code: "MARKETPLACE_NOT_FOUND" },
      });
    });
  });

  // Spec 1 — per-requirement breakdown, not a bare boolean.
  it("reports each unmet entitlement requirement by name", async () => {
    h.setEntitlement(entitlement({ limits: { maxProjects: 0 } }));
    h.repository.findVersion.mockResolvedValueOnce(
      version({
        compatibility: compatibility({
          requiredEntitlements: ["maxWorkflows", "maxProjects"],
        }),
      }),
    );

    const result = await h.service.compatibility(tenantId, listingId, versionId);

    expect(result.compatible).toBe(false);
    expect(result.requirements).toContainEqual({
      kind: "entitlement",
      name: "maxProjects",
      satisfied: false,
      reason: "Tenant plan has no maxProjects.",
    });
    expect(result.requirements).toContainEqual({
      kind: "entitlement",
      name: "maxWorkflows",
      satisfied: true,
      reason: null,
    });
  });

  it("marks compatible when every required entitlement is available", async () => {
    h.repository.findVersion.mockResolvedValueOnce(
      version({
        compatibility: compatibility({ requiredEntitlements: ["maxWorkflows"] }),
      }),
    );

    const result = await h.service.compatibility(tenantId, listingId, versionId);

    expect(result.compatible).toBe(true);
    expect(result.permissions).toContain("marketplace:install");
  });

  // Spec 3 — inactive entitlement blocks install.
  it.each(["grace", "limited", "suspended"] as const)(
    "blocks install when entitlement state is %s",
    async (accessState) => {
      h.setEntitlement(entitlement({ accessState }));

      await expect(
        h.service.install(
          tenantId,
          workspaceId,
          listingId,
          { listing_version_id: versionId, confirmed: true },
          "idem-inactive",
        ),
      ).rejects.toMatchObject({
        response: {
          error_code: "MARKETPLACE_ENTITLEMENT_INACTIVE",
          detail: `Marketplace install requires active entitlement; current state is ${accessState}.`,
        },
      });
      expect(h.repository.createInstall).not.toHaveBeenCalled();
    },
  );

  // Spec 4 — idempotent replay copies once and returns the stored reference.
  it("replays an install without copying the payload twice", async () => {
    const first = await h.service.install(
      tenantId,
      workspaceId,
      listingId,
      { listing_version_id: versionId, confirmed: true },
      "idem-replay",
    );
    const second = await h.service.install(
      tenantId,
      workspaceId,
      listingId,
      { listing_version_id: versionId, confirmed: true },
      "idem-replay",
    );

    expect(h.repository.createInstall).toHaveBeenCalledTimes(1);
    expect(h.putSpy).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.installedPayloadRef).toBe(first.installedPayloadRef);
  });

  it("copies the payload into a tenant-scoped reference", async () => {
    const record = await h.service.install(
      tenantId,
      workspaceId,
      listingId,
      { listing_version_id: versionId, confirmed: true },
      "idem-copy",
    );

    expect(record.installedPayloadRef).not.toBe(sourceRef);
    expect(record.installedPayloadRef).toContain(encodeURIComponent(tenantId));
    await expect(h.store.getObject(record.installedPayloadRef)).resolves.toEqual(
      Buffer.from("payload-bytes"),
    );
  });

  it("rejects a non-owner install of an unreleased version", async () => {
    h.repository.findListing.mockResolvedValueOnce(
      listing({ tenantId: "ten_018f47a5-7b2c-7d10-8f11-1234567890bb", status: "published" }),
    );
    h.repository.findVersion.mockResolvedValueOnce(version({ publishedAt: null }));

    await expect(
      h.service.install(
        tenantId,
        workspaceId,
        listingId,
        { listing_version_id: versionId, confirmed: true },
        "idem-unreleased-non-owner",
      ),
    ).rejects.toMatchObject({
      response: { error_code: "MARKETPLACE_NOT_FOUND" },
    });
    expect(h.repository.createInstall).not.toHaveBeenCalled();
    expect(h.putSpy).not.toHaveBeenCalled();
  });

  it("allows an owner to install an unreleased version", async () => {
    h.repository.findVersion.mockResolvedValueOnce(version({ publishedAt: null }));

    await expect(
      h.service.install(
        tenantId,
        workspaceId,
        listingId,
        { listing_version_id: versionId, confirmed: true },
        "idem-unreleased-owner",
      ),
    ).resolves.toMatchObject({ listingVersionId: versionId });
  });

  // Spec 6 — compatibility is re-checked server-side.
  it("blocks an incompatible install even when the caller confirms", async () => {
    h.setEntitlement(entitlement({ limits: { maxProjects: 0 } }));
    h.repository.findVersion.mockResolvedValue(
      version({
        compatibility: compatibility({ requiredEntitlements: ["maxProjects"] }),
      }),
    );

    await expect(
      h.service.install(
        tenantId,
        workspaceId,
        listingId,
        { listing_version_id: versionId, confirmed: true },
        "idem-incompatible",
      ),
    ).rejects.toMatchObject({
      response: { error_code: "MARKETPLACE_INCOMPATIBLE" },
    });
    expect(h.repository.createInstall).not.toHaveBeenCalled();
    expect(h.putSpy).not.toHaveBeenCalled();
  });

  // Spec 11 — idempotency key is scoped to listing and version.
  it("rejects an idempotency key reused for a different listing", async () => {
    await h.service.install(
      tenantId,
      workspaceId,
      listingId,
      { listing_version_id: versionId, confirmed: true },
      "idem-shared",
    );

    await expect(
      h.service.install(
        tenantId,
        workspaceId,
        otherListingId,
        { listing_version_id: versionId, confirmed: true },
        "idem-shared",
      ),
    ).rejects.toMatchObject({
      response: { error_code: "IDEMPOTENCY_KEY_REUSED" },
    });
    expect(h.repository.createInstall).toHaveBeenCalledTimes(1);
  });

  it("rejects an idempotency key reused for a different version", async () => {
    await h.service.install(
      tenantId,
      workspaceId,
      listingId,
      { listing_version_id: versionId, confirmed: true },
      "idem-version",
    );

    await expect(
      h.service.install(
        tenantId,
        workspaceId,
        listingId,
        { listing_version_id: "lsv_other", confirmed: true },
        "idem-version",
      ),
    ).rejects.toMatchObject({
      response: { error_code: "IDEMPOTENCY_KEY_REUSED" },
    });
  });

  // Spec 8 — reviews require a verified install.
  it("rejects a review with no matching install", async () => {
    h.repository.findInstallForListing.mockResolvedValueOnce(null);

    await expect(
      h.service.createReview(tenantId, listingId, { rating: 5 }),
    ).rejects.toMatchObject({
      response: { error_code: "MARKETPLACE_REVIEW_REQUIRES_INSTALL" },
    });
    expect(h.repository.createReview).not.toHaveBeenCalled();
  });

  it("accepts a review from a tenant that installed the listing", async () => {
    const review = await h.service.createReview(tenantId, listingId, {
      rating: 4,
      comment: "solid",
    });

    expect(review).toMatchObject({ rating: 4, comment: "solid", listingId });
  });

  // Spec 9 — duplicate review maps to 409, never a 500.
  it("maps a unique violation to a duplicate-review conflict", async () => {
    h.repository.createReview.mockRejectedValueOnce({ code: "23505" });

    await expect(
      h.service.createReview(tenantId, listingId, { rating: 3 }),
    ).rejects.toMatchObject({
      status: 409,
      response: { error_code: "MARKETPLACE_REVIEW_ALREADY_EXISTS" },
    });
  });

  it("rethrows a non-unique-violation repository failure unchanged", async () => {
    const failure = new Error("connection reset");
    h.repository.createReview.mockRejectedValueOnce(failure);

    await expect(
      h.service.createReview(tenantId, listingId, { rating: 3 }),
    ).rejects.toBe(failure);
  });
});
