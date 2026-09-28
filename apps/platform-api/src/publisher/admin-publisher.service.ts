import { Injectable } from "@nestjs/common";
import type { KycSubmission } from "@alterx/shared-clients";
import { AdminAuditService } from "../admin-audit";
import {
  AdminPublisherRepository,
  AdminPublisherUnavailableError,
  type PendingVerification,
} from "./admin-publisher.repository";
import { PublisherHttpError } from "./publisher.problem";
import { PublisherService } from "./publisher.service";
import type { ReviewKycInput } from "./types";

const BASE = "/api/v1/admin/publisher/verifications";

@Injectable()
export class AdminPublisherService {
  constructor(
    private readonly repository: AdminPublisherRepository,
    private readonly publisher: PublisherService,
    private readonly audit: AdminAuditService,
  ) {}

  async listPending(): Promise<PendingVerification[]> {
    try {
      return await this.repository.listPending();
    } catch (error) {
      if (error instanceof AdminPublisherUnavailableError) {
        throw new PublisherHttpError(503, "PUBLISHER_REVIEW_UNAVAILABLE", error.message, BASE);
      }
      throw error;
    }
  }

  /** Approving verifies the publisher; rejecting (reason required) marks it rejected. Audited either way. */
  async review(tenantId: string, submissionId: string, staffUserId: string, input: ReviewKycInput): Promise<KycSubmission> {
    const reviewed = await this.publisher.reviewVerification(tenantId, submissionId, staffUserId, input);
    await this.audit.record({
      tenantId,
      actorType: "admin",
      actorRef: staffUserId,
      action: `publisher.kyc.${input.decision}`,
      targetType: "kyc_submission",
      targetRef: submissionId,
      reasonCode: "staff_decision",
      scope: "publisher:verification",
    });
    return reviewed;
  }
}
