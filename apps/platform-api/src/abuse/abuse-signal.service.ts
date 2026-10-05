import { Injectable } from "@nestjs/common";
import { SecurityReviewStaffSchema, type AbuseSignal, type AssignAbuseSignalRequest, type ReviewAbuseSignalRequest } from "@alterx/contracts";
import { AdminAuditService } from "../admin-audit";
import {
  AbuseSignalRepository,
  AbuseSignalSourceUnavailableError,
} from "./abuse-signal.repository";
import { AbuseSignalsHttpError } from "./problem";

@Injectable()
export class AbuseSignalService {
  constructor(
    private readonly signals: AbuseSignalRepository,
    private readonly audit: AdminAuditService,
  ) {}

  list(status?: AbuseSignal["status"]): Promise<AbuseSignal[]> {
    return this.signals.list(status);
  }

  async eligibleStaff() { return SecurityReviewStaffSchema.array().parse(await this.signals.eligibleStaff()); }

  async assign(id: string, staffUserId: string, input: AssignAbuseSignalRequest, ifMatch: string | undefined): Promise<AbuseSignal> {
    const signal = await this.signals.assign(id, input.staff_user_id, input.reason, staffUserId, { ifMatch,
      audit: (value, historyId) => this.audit.record({ tenantId: value.tenant_id, actorType: "admin", actorRef: staffUserId,
        action: "abuse.signal.assign", targetType: "abuse_signal", targetRef: id, reasonCode: "staff_assignment", scope: ["abuse:assign", `history:${historyId}`] }),
    });
    if (!signal) throw new AbuseSignalsHttpError(404, "ABUSE_SIGNAL_NOT_FOUND", "Security review not found", `/api/v1/admin/abuse/signals/${id}/actions/assign`);
    return signal;
  }

  async refresh(staffUserId: string): Promise<{ observed: number; stored: number }> {
    let facts;
    try {
      facts = await this.signals.collectFacts();
    } catch (error) {
      if (!(error instanceof AbuseSignalSourceUnavailableError)) throw error;
      throw new AbuseSignalsHttpError(
        503,
        "ABUSE_SIGNAL_SOURCES_UNAVAILABLE",
        error.message,
        "/api/v1/admin/abuse/signals/actions/refresh",
      );
    }
    const stored = await this.signals.upsertFacts(facts);
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "abuse.signals.refresh",
      targetType: "abuse_queue",
      targetRef: "global",
      reasonCode: "staff_refresh",
      scope: "abuse:write",
    });
    return { observed: facts.length, stored };
  }

  async review(
    id: string,
    staffUserId: string,
    input: ReviewAbuseSignalRequest,
    ifMatch?: string,
  ): Promise<AbuseSignal> {
    const signal = await this.signals.review(id, input.decision, input.reason, staffUserId, { ifMatch,
      audit: (value, historyId) => this.audit.record({ tenantId: value.tenant_id, actorType: "admin", actorRef: staffUserId,
        action: `abuse.signal.${input.decision}`, targetType: "abuse_signal", targetRef: id,
        reasonCode: "staff_decision", scope: ["abuse:review", `history:${historyId}`] }),
    });
    if (!signal) {
      throw new AbuseSignalsHttpError(
        409,
        "ABUSE_SIGNAL_NOT_OPEN",
        "Abuse signal is missing or already reviewed",
        `/api/v1/admin/abuse/signals/${id}/actions/review`,
      );
    }
    return signal;
  }
}
