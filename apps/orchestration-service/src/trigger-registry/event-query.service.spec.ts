import { describe, expect, it, vi } from "vitest";

import {
  EventNotFoundError,
  EventQueryService,
  EventValidationError,
  type OrchestrationTenantStore,
} from "./event-query.service";

const TENANT = "ten_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const BARE_TENANT = TENANT.slice("ten_".length);
const EVENT_A = "evt_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const EVENT_B = "evt_018f4d6e-cccc-7ccc-8ccc-cccccccccccc";

function rowFor(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    event_type: "whatsapp.message.received",
    tenant_id: BARE_TENANT,
    workspace_id: "018f4d6e-dddd-7ddd-8ddd-dddddddddddd",
    source: "whatsapp",
    source_account_id: null,
    trigger_id: null,
    trigger_version: null,
    occurred_at: "2026-08-26T00:00:00.000Z",
    received_at: "2026-08-26T00:00:00.000Z",
    signature_status: "verified",
    workflow_id: null,
    run_id: null,
    ...overrides,
  };
}

function storeWith(
  query: (statement: string, values?: readonly unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>,
): OrchestrationTenantStore {
  return {
    async withTenant(tenantId, operation) {
      expect(tenantId).toBe(BARE_TENANT);
      return operation({ query: query as never });
    },
  };
}

describe("EventQueryService", () => {
  it("lists real events for the tenant, ordered by received_at", async () => {
    const rows = [rowFor(EVENT_A), rowFor(EVENT_B)];
    const query = vi.fn(async (statement: string, values?: readonly unknown[]) => {
      void values;
      const sql = statement.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT e.event_id")) return { rowCount: rows.length, rows };
      throw new Error(`Unexpected query ${sql}`);
    });
    const service = new EventQueryService(storeWith(query));

    const page = await service.list(TENANT);

    expect(page).toEqual({
      data: rows,
      page: { next_cursor: null, has_more: false, limit: 50 },
    });
    expect(query.mock.calls[0]![1]).toEqual([BARE_TENANT, 51]);
  });

  it("paginates: a full page reports has_more and a next_cursor from the last row", async () => {
    const rows = [rowFor(EVENT_A), rowFor(EVENT_B)];
    const query = vi.fn(async () => ({ rowCount: rows.length, rows }));
    const service = new EventQueryService(storeWith(query));

    const page = await service.list(TENANT, { limit: 1 });

    expect(page.data).toEqual([rows[0]]);
    expect(page.page).toEqual({ next_cursor: EVENT_A, has_more: true, limit: 1 });
  });

  it("resolves a cursor's received_at before paginating from it", async () => {
    const query = vi.fn(async (statement: string, values?: readonly unknown[]) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT received_at::text")) {
        expect(values).toEqual([BARE_TENANT, EVENT_A, null]);
        return { rowCount: 1, rows: [{ received_at: "2026-08-26T00:00:00.000Z" }] };
      }
      if (sql.startsWith("SELECT e.event_id")) {
        expect(sql).toContain("(e.received_at, e.event_id) >");
        expect(values).toEqual([BARE_TENANT, "2026-08-26T00:00:00.000Z", EVENT_A, 51]);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query ${sql}`);
    });
    const service = new EventQueryService(storeWith(query));

    await expect(service.list(TENANT, { cursor: EVENT_A })).resolves.toMatchObject({ data: [] });
  });

  it("rejects a cursor that does not belong to this tenant's events", async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const service = new EventQueryService(storeWith(query));

    await expect(service.list(TENANT, { cursor: EVENT_A })).rejects.toBeInstanceOf(EventValidationError);
  });

  it("filters by source", async () => {
    const query = vi.fn(async (statement: string, values?: readonly unknown[]) => {
      expect(statement).toContain("e.source = $2");
      expect(values).toEqual([BARE_TENANT, "whatsapp", 51]);
      return { rowCount: 0, rows: [] };
    });
    const service = new EventQueryService(storeWith(query));

    await service.list(TENANT, { source: "whatsapp" });
  });

  it.each([
    ["failed", "e.signature_status = $2"],
    ["triggered", "e.signature_status <> 'failed' AND e.trigger_id IS NOT NULL"],
    ["received", "e.signature_status <> 'failed' AND e.trigger_id IS NULL"],
  ])("filters by the derivable status %s", async (status, clause) => {
    const query = vi.fn(async (statement: string) => {
      expect(statement).toContain(clause);
      return { rowCount: 0, rows: [] };
    });
    const service = new EventQueryService(storeWith(query));

    await service.list(TENANT, { status });
  });

  it.each(["matched", "ignored", "bogus"])(
    "rejects the non-derivable status %s rather than silently returning wrong results",
    async (status) => {
      const query = vi.fn();
      const service = new EventQueryService(storeWith(query as never));

      await expect(service.list(TENANT, { status })).rejects.toBeInstanceOf(EventValidationError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("gets a single event by id", async () => {
    const row = rowFor(EVENT_A, { trigger_id: "trg_1", trigger_version: 2 });
    const query = vi.fn(async (statement: string, values?: readonly unknown[]) => {
      expect(statement).toContain("WHERE e.tenant_id = $1 AND e.event_id = $2");
      expect(values).toEqual([BARE_TENANT, EVENT_A]);
      return { rowCount: 1, rows: [row] };
    });
    const service = new EventQueryService(storeWith(query));

    await expect(service.get(TENANT, EVENT_A)).resolves.toEqual(row);
  });

  it("throws EventNotFoundError for a missing event", async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const service = new EventQueryService(storeWith(query));

    await expect(service.get(TENANT, EVENT_A)).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it("rejects invalid tenant ids, event ids, and limits without querying", async () => {
    const query = vi.fn();
    const service = new EventQueryService({ withTenant: query } as never);

    await expect(service.list("not-a-tenant")).rejects.toBeInstanceOf(EventValidationError);
    await expect(service.list(TENANT, { limit: 0 })).rejects.toBeInstanceOf(EventValidationError);
    await expect(service.list(TENANT, { limit: 201 })).rejects.toBeInstanceOf(EventValidationError);
    await expect(service.get(TENANT, "not-an-event-id")).rejects.toBeInstanceOf(EventValidationError);
    expect(query).not.toHaveBeenCalled();
  });
});
