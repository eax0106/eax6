import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type {
  AdminIncident,
  CreateIncidentRequest,
  IncidentApprovalRequest,
} from "@alterx/contracts";
import type { StatusPageIncident, StatusPageProvider } from "@alterx/shared-clients";
import { AdminAuditService } from "../admin-audit";
import { IncidentRepository } from "./incident.repository";
import { IncidentHttpError } from "./problem";
import { STATUS_PAGE_PROVIDER } from "./tokens";

@Injectable()
export class IncidentService {
  constructor(
    private readonly incidents: IncidentRepository,
    @Inject(STATUS_PAGE_PROVIDER) private readonly statusPage: StatusPageProvider,
    private readonly audit: AdminAuditService,
  ) {}

  list(): Promise<AdminIncident[]> {
    return this.incidents.list();
  }

  async get(id: string): Promise<AdminIncident> {
    const incident = await this.incidents.find(id);
    if (!incident) throw notFound(id);
    return incident;
  }

  async create(staffUserId: string, input: CreateIncidentRequest): Promise<AdminIncident> {
    const id = `inc_${randomUUID()}`;
    const incident = await this.incidents.create(id, staffUserId, input);
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "incident.create",
      targetType: "incident",
      targetRef: id,
      reasonCode: "incident_response",
      scope: "incidents:write",
    });
    return incident;
  }

  async requestPublication(
    id: string,
    staffUserId: string,
    input: IncidentApprovalRequest,
  ): Promise<AdminIncident> {
    const incident = await this.incidents.requestPublication(id, staffUserId, input.reason);
    if (!incident) await this.throwStateOrNotFound(id, "Incident publication cannot be requested from current state");
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "incident.publication.request",
      targetType: "incident",
      targetRef: id,
      reasonCode: "incident_response",
      scope: "incidents:publish",
    });
    return incident!;
  }

  async approvePublication(
    id: string,
    staffUserId: string,
    input: IncidentApprovalRequest,
  ): Promise<AdminIncident> {
    const current = await this.get(id);
    if (current.created_by === staffUserId || current.publication_requested_by === staffUserId) {
      throw conflict(id, "Publication must be approved by a different staff user");
    }
    const incident = await this.incidents.approve(id, staffUserId, input.reason);
    if (!incident) throw conflict(id, "Incident publication is not pending approval");
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "incident.publication.approve",
      targetType: "incident",
      targetRef: id,
      reasonCode: "human_approval",
      scope: "incidents:approve",
    });
    return incident;
  }

  async publish(id: string, staffUserId: string): Promise<AdminIncident> {
    const incident = await this.incidents.claimPublishing(id);
    if (!incident) await this.throwStateOrNotFound(id, "Incident publication requires human approval");

    try {
      await this.audit.record({
        actorType: "admin",
        actorRef: staffUserId,
        action: "incident.publication.execute",
        targetType: "incident",
        targetRef: id,
        reasonCode: "approved_publication",
        scope: "incidents:publish",
      });
    } catch (error) {
      await this.incidents.releasePublishing(id);
      throw error;
    }

    let published: StatusPageIncident;
    try {
      published = await this.statusPage.publishIncident({
        title: incident!.title,
        body: incident!.summary,
        status: "investigating",
        impact: impact(incident!.severity),
        notifySubscribers: true,
      });
    } catch {
      await this.incidents.releasePublishing(id);
      throw new IncidentHttpError(
        502,
        "STATUS_PAGE_PROVIDER_ERROR",
        "Status page publication failed",
        `/api/v1/admin/incidents/${id}/actions/publish`,
      );
    }

    // Never reopen after external success: that could duplicate customer posts.
    const complete = await this.incidents.completePublication(
      id,
      published.providerIncidentRef,
      published.publishedAt,
    );
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: "incident.publication.complete",
      targetType: "incident",
      targetRef: id,
      reasonCode: "status_page_published",
      scope: "incidents:publish",
    });
    return complete;
  }

  /**
   * Operational status (task B1.5). An incident leaves draft for
   * investigating, then moves freely between investigating, monitoring and
   * resolved -- resolved can reopen -- and never returns to draft.
   */
  async setStatus(
    id: string,
    staffUserId: string,
    to: Exclude<AdminIncident["status"], "draft">,
    reason: string,
  ): Promise<AdminIncident> {
    const current = await this.get(id);
    if (current.status === to) return current;
    if (current.status === "draft" && to !== "investigating") {
      throw conflict(id, "A draft incident moves to investigating first");
    }
    const updated = await this.incidents.setStatus(id, current.status, to);
    if (!updated) throw conflict(id, "Incident status changed concurrently; reload and retry");
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action: `incident.status.${to}`,
      targetType: "incident",
      targetRef: id,
      reasonCode: reason.slice(0, 100),
      scope: "incidents:write",
    });
    return updated;
  }

  private async throwStateOrNotFound(id: string, detail: string): Promise<never> {
    if (!(await this.incidents.find(id))) throw notFound(id);
    throw conflict(id, detail);
  }
}

function impact(severity: AdminIncident["severity"]): "minor" | "major" | "critical" {
  if (severity === "sev1") return "critical";
  if (severity === "sev2") return "major";
  return "minor";
}

function notFound(id: string): IncidentHttpError {
  return new IncidentHttpError(
    404,
    "INCIDENT_NOT_FOUND",
    "Incident not found",
    `/api/v1/admin/incidents/${id}`,
  );
}

function conflict(id: string, detail: string): IncidentHttpError {
  return new IncidentHttpError(
    409,
    "INCIDENT_STATE_CONFLICT",
    detail,
    `/api/v1/admin/incidents/${id}`,
  );
}
