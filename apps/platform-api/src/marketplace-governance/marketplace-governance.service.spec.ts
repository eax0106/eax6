import { describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import { MarketplaceGovernanceRepository } from "./marketplace-governance.repository";
import { MarketplaceGovernanceService } from "./marketplace-governance.service";

describe("MarketplaceGovernanceService", () => {
  it("requires audit acknowledgement within the repository transaction", async () => {
    const item = {
      review_notes: [{id:"mge_test"}],
      resource_type: "listing" as const,
      id: "lst_123",
      tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
      name: "Reviewed listing",
      status: "published",
      trust_level: null,
      updated_at: "2026-08-06T10:00:00.000Z",
    };
    const act = vi.fn(async (_type, _id, _input, write) => { await write.audit(item); return item; });
    const record = vi.fn().mockResolvedValue("a".repeat(64));
    const service = new MarketplaceGovernanceService(
      { act } as unknown as MarketplaceGovernanceRepository,
      { record } as unknown as AdminAuditService,
    );

    await expect(service.act("listing", item.id, "stf_security", {
      action: "approve",
      reason: "human review passed",
    })).resolves.toEqual(item);
    expect(act).toHaveBeenCalledBefore(record);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: "marketplace.governance.approve",
      targetRef: item.id,
    }));
  });
});
