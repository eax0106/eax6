import { describe, expect, it, vi } from "vitest";

import {
  RunObservabilityService,
  type OrchestrationTenantStore,
} from "./run-observability.service";

const TENANT = "ten_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const RUN = "run_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const VERIFICATION = "ver_018f4d6e-cccc-7ccc-8ccc-cccccccccccc";

describe("RunObservabilityService", () => {
  it("reads persisted verification rows and derives quality gates from same rows", async () => {
    const query = vi.fn(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      if (sql.startsWith("SELECT id FROM runs")) return { rowCount: 1, rows: [{ id: RUN }] };
      if (sql.includes("FROM verification_results")) return {
        rowCount: 1,
        rows: [{ id: VERIFICATION, run_id: RUN, gate_type: "quality", verdict: "pass" }],
      };
      throw new Error(`Unexpected query ${sql}`);
    });
    const store: OrchestrationTenantStore = {
      async withTenant(tenantId, operation) {
        expect(tenantId).toBe(TENANT.slice("ten_".length));
        return operation({ query: query as never });
      },
    };
    const service = new RunObservabilityService(store);

    await expect(service.verificationResults(TENANT, RUN)).resolves.toMatchObject({
      data: [{ id: VERIFICATION, verdict: "pass" }],
      page: { has_more: false },
    });
    await expect(service.qualityGates(TENANT, RUN)).resolves.toMatchObject({
      data: [{ id: VERIFICATION, gate_type: "quality" }],
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("gate_type IN"))).toBe(true);
  });

  describe("recentResolvedRecoveries (the recovery feed)", () => {
    const ACTION = "rec_018f4d6e-dddd-7ddd-8ddd-dddddddddddd";

    function setup(rows: Record<string, unknown>[] = [], cursorRow?: { resolved_at: string }) {
      const query = vi.fn(async (statement: string, values?: readonly unknown[]) => {
        const sql = statement.replace(/\s+/g, " ").trim();
        if (sql.startsWith("SELECT resolved_at::text FROM recovery_actions")) {
          return { rowCount: cursorRow ? 1 : 0, rows: cursorRow ? [cursorRow] : [] };
        }
        if (sql.includes("FROM recovery_actions a JOIN runs r")) return { rowCount: rows.length, rows };
        throw new Error(`Unexpected query ${sql} ${JSON.stringify(values)}`);
      });
      const store: OrchestrationTenantStore = {
        async withTenant(tenantId, operation) {
          expect(tenantId).toBe(TENANT.slice("ten_".length));
          return operation({ query: query as never });
        },
      };
      return { query, service: new RunObservabilityService(store) };
    }

    const feedSql = (query: ReturnType<typeof setup>["query"]) =>
      String(query.mock.calls.find(([sql]) => String(sql).includes("JOIN runs r"))![0]).replace(/\s+/g, " ");

    it("lists only recoveries that repaired the problem, newest first, with the run's workspace", async () => {
      const { query, service } = setup([{ id: ACTION, run_id: RUN, workspace_id: "w" }]);

      await expect(service.recentResolvedRecoveries(TENANT)).resolves.toMatchObject({
        data: [{ id: ACTION }],
        page: { has_more: false, next_cursor: null, limit: 50 },
      });

      const sql = feedSql(query);
      expect(sql).toContain("a.outcome = 'resolved'");
      expect(sql).toContain("a.strategy NOT IN ('ask_user', 'terminate')");
      expect(sql).toContain("ORDER BY a.resolved_at DESC, a.id DESC");
      expect(sql).toContain("r.workspace_id");
    });

    it("filters by resolved_after and pages by cursor", async () => {
      const { query, service } = setup([], { resolved_at: "2026-09-29 10:00:00+00" });

      await service.recentResolvedRecoveries(TENANT, {
        resolvedAfter: "2026-09-29T09:00:00.000Z",
        cursor: ACTION,
        limit: 10,
      });

      const call = query.mock.calls.find(([sql]) => String(sql).includes("JOIN runs r"))!;
      expect(String(call[0])).toContain("a.resolved_at > $2::timestamptz");
      expect(String(call[0])).toContain("(a.resolved_at, a.id) < ($3::timestamptz, $4)");
      expect(call[1]).toEqual([
        TENANT.slice("ten_".length),
        "2026-09-29T09:00:00.000Z",
        "2026-09-29 10:00:00+00",
        ACTION,
        11,
      ]);
    });

    it("says there is more when the page overflows, and points at the last row it returned", async () => {
      const rows = [{ id: "rec_1" }, { id: "rec_2" }, { id: "rec_3" }];
      const { service } = setup(rows);
      await expect(service.recentResolvedRecoveries(TENANT, { limit: 2 })).resolves.toMatchObject({
        data: [{ id: "rec_1" }, { id: "rec_2" }],
        page: { has_more: true, next_cursor: "rec_2", limit: 2 },
      });
    });

    it.each([
      ["a bad timestamp", { resolvedAfter: "yesterday-ish" }],
      ["a cursor that is not a recovery action id", { cursor: "run_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb" }],
      ["a limit above 200", { limit: 201 }],
      ["a limit of zero", { limit: 0 }],
    ])("refuses %s", async (_name, query) => {
      const { service } = setup();
      await expect(service.recentResolvedRecoveries(TENANT, query)).rejects.toMatchObject({
        name: "RunObservabilityValidationError",
      });
    });

    it("refuses a cursor from another tenant (its row is not visible)", async () => {
      const { service } = setup([], undefined);
      await expect(service.recentResolvedRecoveries(TENANT, { cursor: ACTION })).rejects.toThrow(
        "cursor does not belong to this tenant",
      );
    });

    it("refuses a tenant that is not a prefixed UUIDv7", async () => {
      const { service } = setup();
      await expect(service.recentResolvedRecoveries("not-a-tenant")).rejects.toThrow("ten_ prefixed");
    });
  });
});
