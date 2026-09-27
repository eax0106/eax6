import { Inject, Injectable, Logger } from "@nestjs/common";
import type { BillingDispute, BillingProvider, BillingRefund } from "@alterx/shared-clients";
import type { RefundPaymentRequest, ResolveDisputeRequest } from "@alterx/contracts";
import { AdminAuditService } from "../admin-audit";
import { AdminBillingRepository, type BillingIssueView } from "./admin-billing.repository";
import { BillingHttpError } from "./problem";
import { BILLING_PROVIDER } from "./tokens";

@Injectable()
export class AdminBillingService {
  private readonly logger = new Logger(AdminBillingService.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly audit: AdminAuditService,
    private readonly repository: AdminBillingRepository,
  ) {}

  listIssues(): Promise<BillingIssueView[]> {
    return this.repository.listIssues();
  }

  async refund(staffUserId: string, input: RefundPaymentRequest): Promise<BillingRefund> {
    let refund: BillingRefund;
    try {
      refund = await this.provider.refundPayment(
        input.payment_ref,
        input.amount_minor,
        input.speed,
        input.reason,
      );
    } catch (error) {
      if (error instanceof BillingHttpError) throw error;
      this.logger.error("Billing refund provider call failed", error);
      throw providerError("/api/v1/admin/billing/refunds");
    }
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "billing.payment.refund",
      targetType: "payment",
      targetRef: input.payment_ref,
      reasonCode: "staff_decision",
      scope: "billing:refund",
    });
    return refund;
  }

  async resolveDispute(
    staffUserId: string,
    disputeRef: string,
    input: ResolveDisputeRequest,
  ): Promise<BillingDispute> {
    const instance = `/api/v1/admin/billing/disputes/${disputeRef}/actions/resolve`;
    let dispute: BillingDispute;
    try {
      dispute = await this.provider.resolveDispute(disputeRef, {
        action: input.action,
        reason: input.reason,
        evidenceRefs: input.evidence_refs,
      });
    } catch (error) {
      if (error instanceof BillingHttpError) throw error;
      this.logger.error("Billing dispute provider call failed", error);
      throw providerError(instance);
    }
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: `billing.dispute.${input.action}`,
      targetType: "dispute",
      targetRef: disputeRef,
      reasonCode: "staff_decision",
      scope: "billing:disputes",
    });
    return dispute;
  }
}

function providerError(instance: string): BillingHttpError {
  return new BillingHttpError(
    502,
    "BILLING_PROVIDER_ERROR",
    "Billing provider operation failed",
    instance,
  );
}
