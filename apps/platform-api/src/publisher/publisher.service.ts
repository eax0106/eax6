import { Injectable } from "@nestjs/common";
import type { KycProvider } from "@alterx/shared-clients";
import type { ListingStatus } from "../marketplace/types";
import { PublisherHttpError } from "./publisher.problem";
import { PublisherRepository } from "./publisher.repository";
import type { ListingTransitionInput, ReviewKycInput, SubmitVerificationInput } from "./types";

export const PUBLISHING_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  draft: ["private_testing", "submitted", "removed"],
  private_testing: ["draft", "submitted", "removed"],
  submitted: ["automated_review", "private_testing", "removed"],
  automated_review: ["human_review", "published", "private_testing", "removed"],
  human_review: ["published", "private_testing", "removed"],
  published: ["suspended", "deprecated", "removed"],
  suspended: ["published", "deprecated", "removed"],
  deprecated: ["removed"],
  removed: [],
};

@Injectable()
export class PublisherService {
  constructor(private readonly repository: PublisherRepository, private readonly kyc: KycProvider) {}
  submitVerification(tenantId: string, input: SubmitVerificationInput) { return this.kyc.submitVerification(tenantId, input.documents); }
  verificationStatus(tenantId: string) { return this.kyc.getVerificationStatus(tenantId); }
  payouts(tenantId: string) { return this.repository.listPayouts(tenantId); }
  earnings(tenantId: string) { return this.repository.earnings(tenantId); }

  async reviewVerification(tenantId: string, submissionId: string, reviewerId: string, input: ReviewKycInput) {
    const reviewed = await this.repository.reviewSubmission(tenantId, submissionId, reviewerId, input.decision, input.reason ?? null);
    if (!reviewed) throw new PublisherHttpError(404, "PUBLISHER_KYC_SUBMISSION_NOT_FOUND", "Pending KYC submission was not found.", `/api/v1/admin/publisher/verifications/${tenantId}/${submissionId}/actions/review`);
    return reviewed;
  }

  async submitListing(tenantId: string, listingId: string) {
    const publisher = await this.repository.getPublisher(tenantId);
    if (publisher?.verificationStatus !== "verified") {
      throw new PublisherHttpError(403, "PUBLISHER_VERIFICATION_REQUIRED", "Publisher verification is required before listing submission.", `/api/v1/publisher/listings/${listingId}/actions/submit`);
    }
    return this.applyTransition(tenantId, listingId, "submitted");
  }

  async transitionListing(tenantId: string, listingId: string, input: ListingTransitionInput | ListingStatus) {
    const target = typeof input === "string" ? input : input.status;
    if (["submitted", "automated_review", "human_review", "published"].includes(target)) {
      throw new PublisherHttpError(403, "PUBLISHER_REVIEW_TRANSITION_REQUIRED", "Use the dedicated submission or staff review action.", `/api/v1/publisher/listings/${listingId}/actions/transition`);
    }
    return this.applyTransition(tenantId, listingId, target);
  }

  private async applyTransition(tenantId: string, listingId: string, target: ListingStatus) {
    const current = await this.repository.listingStatus(tenantId, listingId);
    if (!current) throw new PublisherHttpError(404, "PUBLISHER_LISTING_NOT_FOUND", "Publisher listing was not found.", `/api/v1/publisher/listings/${listingId}`);
    if (!isListingStatus(current) || !PUBLISHING_TRANSITIONS[current].includes(target)) {
      throw new PublisherHttpError(409, "PUBLISHER_INVALID_PIPELINE_TRANSITION", `Cannot transition listing from ${current} to ${target}.`, `/api/v1/publisher/listings/${listingId}/actions/transition`);
    }
    const status = await this.repository.transitionListing(tenantId, listingId, target);
    if (!status) throw new PublisherHttpError(404, "PUBLISHER_LISTING_NOT_FOUND", "Publisher listing was not found.", `/api/v1/publisher/listings/${listingId}`);
    return { listingId, status };
  }
}

function isListingStatus(value: string): value is ListingStatus { return Object.hasOwn(PUBLISHING_TRANSITIONS, value); }
