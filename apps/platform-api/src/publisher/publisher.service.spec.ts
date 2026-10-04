import { describe, expect, it, vi } from "vitest";
import type { KycProvider } from "@alterx/shared-clients";
import type { ListingStatus } from "../marketplace/types";
import { PublisherService, PUBLISHING_TRANSITIONS } from "./publisher.service";

const tenantId = "ten_018f47a5-7b2c-7d10-8f11-1234567890ab";
const listingId = "lst_018f47a5-7b2c-7d10-8f11-1234567890ad";
const statuses = Object.keys(PUBLISHING_TRANSITIONS) as ListingStatus[];
const unusedKyc = {} as KycProvider;

function repository(current: ListingStatus, verificationStatus = "verified") {
  return {
    getPublisher: vi.fn().mockResolvedValue({ verificationStatus }),
    listingStatus: vi.fn().mockResolvedValue(current),
    transitionListing: vi.fn().mockImplementation(async (_tenantId: string, _listingId: string, target: ListingStatus) => target),
    reviewSubmission: vi.fn(), listPayouts: vi.fn(), earnings: vi.fn(),
  };
}

describe("PublisherService publishing pipeline", () => {
  it("allows tenant-managed graph edges", async () => {
    for (const from of statuses) {
      for (const to of PUBLISHING_TRANSITIONS[from]) {
        if (["submitted", "automated_review", "human_review", "published"].includes(to)) continue;
        const store = repository(from);
        const service = new PublisherService(store as never, unusedKyc);
        await expect(service.transitionListing(tenantId, listingId, to)).resolves.toEqual({ listingId, status: to });
        expect(store.transitionListing).toHaveBeenCalledWith(tenantId, listingId, to);
      }
    }
  });

  it("rejects every non-edge", async () => {
    for (const from of statuses) {
      for (const to of statuses.filter((status) => !PUBLISHING_TRANSITIONS[from].includes(status) && !["submitted", "automated_review", "human_review", "published"].includes(status))) {
        const store = repository(from);
        const service = new PublisherService(store as never, unusedKyc);
        await expect(service.transitionListing(tenantId, listingId, to)).rejects.toMatchObject({ status: 409 });
        expect(store.transitionListing).not.toHaveBeenCalled();
      }
    }
  });

  it("submits free listings for review without collecting KYC", async () => {
    const store = {...repository("draft", "pending_review"),submitFreeListing:vi.fn().mockResolvedValue("submitted")};
    const kyc = {submitVerification:vi.fn()};
    const service = new PublisherService(store as never, kyc as never);
    await expect(service.submitListing(tenantId,listingId)).resolves.toEqual({listingId,status:"submitted"});
    expect(store.submitFreeListing).toHaveBeenCalledWith(tenantId,listingId);
    expect(store.getPublisher).not.toHaveBeenCalled();
    expect(()=>service.submitVerification(tenantId,{documents:[]})).toThrow();
    expect(kyc.submitVerification).not.toHaveBeenCalled();
  });
});
