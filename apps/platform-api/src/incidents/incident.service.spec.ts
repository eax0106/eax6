import type { AdminIncident, CreateIncidentRequest } from "@alterx/contracts";
import {
  createMockStatusPageProvider,
  type StatusPageIncidentRequest,
} from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import { IncidentRepository } from "./incident.repository";
import { IncidentService } from "./incident.service";
import { IncidentHttpError } from "./problem";

describe("IncidentService", () => {
  it("never invokes status page before separate human approval", async () => {
    const repository = new MemoryIncidentRepository();
    const onPublish = vi.fn();
    const service = createService(repository, onPublish);
    const incident = await service.create("stf_creator", fixture());
    await service.requestPublication(incident.id, "stf_creator", { reason: "customer impact" });

    await expect(service.publish(incident.id, "stf_creator")).rejects.toBeInstanceOf(IncidentHttpError);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("forbids creator self-approval", async () => {
    const repository = new MemoryIncidentRepository();
    const onPublish = vi.fn();
    const service = createService(repository, onPublish);
    const incident = await service.create("stf_creator", fixture());
    await service.requestPublication(incident.id, "stf_creator", { reason: "customer impact" });

    await expect(service.approvePublication(
      incident.id,
      "stf_creator",
      { reason: "approved" },
    )).rejects.toMatchObject({ status: 409 });
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("publishes exactly once after another staff user approves", async () => {
    const repository = new MemoryIncidentRepository();
    const onPublish = vi.fn();
    const service = createService(repository, onPublish);
    const incident = await service.create("stf_creator", fixture());
    await service.requestPublication(incident.id, "stf_creator", { reason: "customer impact" });
    await service.approvePublication(incident.id, "stf_approver", { reason: "message verified" });

    await expect(service.publish(incident.id, "stf_publisher")).resolves.toMatchObject({
      publication_state: "published",
      provider_incident_ref: "inc_contract",
    });
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({
      status: "investigating",
      impact: "critical",
      notifySubscribers: true,
    }));
    await expect(service.publish(incident.id, "stf_publisher")).rejects.toMatchObject({ status: 409 });
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("moves a draft to investigating, then to resolved, and can reopen; never back to draft", async () => {
    const repository = new MemoryIncidentRepository();
    const service = createService(repository, vi.fn());
    const incident = await service.create("stf_creator", fixture());

    await expect(service.setStatus(incident.id, "stf_admin", "resolved", "done")).rejects.toMatchObject({ status: 409 });
    await expect(service.setStatus(incident.id, "stf_admin", "investigating", "paged")).resolves.toMatchObject({ status: "investigating" });
    await expect(service.setStatus(incident.id, "stf_admin", "resolved", "fixed")).resolves.toMatchObject({ status: "resolved" });
    await expect(service.setStatus(incident.id, "stf_admin", "investigating", "recurred")).resolves.toMatchObject({ status: "investigating" });
  });

  it("refuses a transition when the status changed underneath it", async () => {
    const repository = new MemoryIncidentRepository();
    const service = createService(repository, vi.fn());
    const incident = await service.create("stf_creator", fixture());
    await service.setStatus(incident.id, "stf_admin", "investigating", "paged");
    vi.spyOn(repository, "setStatus").mockResolvedValueOnce(undefined);
    await expect(service.setStatus(incident.id, "stf_admin", "monitoring", "mitigated")).rejects.toMatchObject({ status: 409 });
  });
});

function createService(
  repository: MemoryIncidentRepository,
  onPublish: (request: StatusPageIncidentRequest) => void,
) {
  return new IncidentService(
    repository as unknown as IncidentRepository,
    createMockStatusPageProvider({ onPublish }),
    { record: vi.fn().mockResolvedValue("a".repeat(64)) } as unknown as AdminAuditService,
  );
}

function fixture(): CreateIncidentRequest {
  return {
    title: "API unavailable",
    summary: "Investigating API failures.",
    severity: "sev1",
    impacted_services: ["platform-api"],
  };
}

class MemoryIncidentRepository {
  private readonly records = new Map<string, AdminIncident>();

  async create(id: string, staffUserId: string, input: CreateIncidentRequest) {
    const record: AdminIncident = {
      id,
      ...input,
      status: "draft",
      publication_state: "not_requested",
      created_by: staffUserId,
      created_at: "2026-08-06T00:00:00.000Z",
      publication_requested_by: null,
      publication_requested_at: null,
      approved_by: null,
      approved_at: null,
      provider_incident_ref: null,
      published_at: null,
    };
    this.records.set(id, record);
    return record;
  }

  async list() { return [...this.records.values()]; }
  async find(id: string) { return this.records.get(id); }

  async requestPublication(id: string, staffUserId: string) {
    const current = this.records.get(id);
    if (!current || !["not_requested", "rejected"].includes(current.publication_state)) return undefined;
    return this.update(id, {
      status: "investigating",
      publication_state: "pending_approval",
      publication_requested_by: staffUserId,
      publication_requested_at: "2026-08-06T00:01:00.000Z",
      approved_by: null,
      approved_at: null,
    });
  }

  async approve(id: string, staffUserId: string) {
    const current = this.records.get(id);
    if (!current || current.publication_state !== "pending_approval") return undefined;
    if (current.created_by === staffUserId || current.publication_requested_by === staffUserId) return undefined;
    return this.update(id, {
      publication_state: "approved",
      approved_by: staffUserId,
      approved_at: "2026-08-06T00:02:00.000Z",
    });
  }

  async setStatus(id: string, from: AdminIncident["status"], to: AdminIncident["status"]) {
    const current = this.records.get(id);
    if (!current || current.status !== from) return undefined;
    const updated = { ...current, status: to };
    this.records.set(id, updated);
    return updated;
  }

  async claimPublishing(id: string) {
    const current = this.records.get(id);
    if (!current || current.publication_state !== "approved") return undefined;
    return this.update(id, { publication_state: "publishing" });
  }

  async completePublication(id: string, providerIncidentRef: string, publishedAt: string) {
    return this.update(id, {
      publication_state: "published",
      provider_incident_ref: providerIncidentRef,
      published_at: publishedAt,
    })!;
  }

  async releasePublishing(id: string) {
    const current = this.records.get(id);
    if (current?.publication_state === "publishing") this.update(id, { publication_state: "approved" });
  }

  private update(id: string, patch: Partial<AdminIncident>) {
    const current = this.records.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.records.set(id, next);
    return next;
  }
}
