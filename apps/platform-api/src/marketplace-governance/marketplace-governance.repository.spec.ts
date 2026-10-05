import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { governanceEtag } from "./governance-history";
import { MarketplaceGovernanceRepository } from "./marketplace-governance.repository";

describe("MarketplaceGovernanceRepository", () => {
  it("blocks manifest and revokes every version in one transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT * FROM tool_manifests") || sql.includes("UPDATE tool_manifests")) {
        return { rows: [{
          id: "tlm_123",
          tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
          name: "Unsafe package",
          status: "blocked",
          trust_level: "blocked",
          governance_revision: "0",
          updated_at: new Date("2026-08-06T10:00:00.000Z"),
        }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const repository = new MarketplaceGovernanceRepository(pool);

    await expect(repository.act("tool_manifest", "tlm_123", {
      action: "takedown",
      reason: "critical install script",
    }, {actorRef:"stf_security",ifMatch:governanceEtag("tlm_123", "0"),audit:async()=>"ack"})).resolves.toMatchObject({ status: "blocked", trust_level: "blocked" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE tool_versions")))
      .toBe(true);
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
