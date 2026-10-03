import { describe, expect, it, vi } from "vitest";
import {
  ClarificationsService,
  type OrchestrationTenantStore,
} from "./clarifications.service";

const TENANT = "ten_00000000-0000-7000-8000-00000000000a";
const BARE_TENANT = "00000000-0000-7000-8000-00000000000a";
const CLARIFICATION = "clr_00000000-0000-7000-8000-00000000000b";

function fakeStore(): { readonly store: OrchestrationTenantStore; readonly query: ReturnType<typeof vi.fn> } {
  const row = {
    id: CLARIFICATION,
    conversation_id: "cnv_00000000-0000-7000-8000-00000000000c",
    question: "Which region?",
    status: "open",
    assignee_user_id: null,
    assigned_at: null,
    requested_at: "2026-08-06T00:00:00.000Z",
    answered_at: null,
    expiry_at: "2026-08-07T00:00:00.000Z",
  };
  const query = vi.fn(async (statement: string) => {
    if (statement.includes("WHERE tenant_id = $1 AND ($2::uuid IS NULL OR workspace_id = $2) AND status = 'open'")) {
      return { rowCount: 1, rows: [row] };
    }
    if (statement.includes("WHERE tenant_id = $1 AND id = $2 AND status = 'open'")) {
      return { rowCount: 1, rows: [{ ...row, assignee_user_id: "00000000-0000-7000-8000-00000000000d" }] };
    }
    return { rowCount: 1, rows: [] };
  });
  return {
    store: { async withTenant(tenantId, operation) { expect(tenantId).toBe(BARE_TENANT); return operation({ query: query as never }); } },
    query,
  };
}

describe("ClarificationsService", () => {
  it("lists only real open rows after expiring stale rows", async () => {
    const { store, query } = fakeStore();
    await expect(new ClarificationsService(store).list(TENANT)).resolves.toMatchObject({
      data: [{ id: CLARIFICATION, status: "open" }],
      page: { has_more: false, limit: 50 },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'expired'"), [BARE_TENANT, null]);
  });

  it("assigns an open clarification to a validated user", async () => {
    const { store, query } = fakeStore();
    await expect(
      new ClarificationsService(store).assign(
        TENANT,
        CLARIFICATION,
        "usr_00000000-0000-7000-8000-00000000000d",
      ),
    ).resolves.toMatchObject({ assignee_user_id: "00000000-0000-7000-8000-00000000000d" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET assignee_user_id = $3"),
      [BARE_TENANT, CLARIFICATION, "00000000-0000-7000-8000-00000000000d"],
    );
  });
});
