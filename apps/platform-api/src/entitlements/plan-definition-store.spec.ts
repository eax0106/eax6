import { describe, expect, it, vi } from "vitest";
import { PostgresPlanDefinitionStore } from "./plan-definition-store";
import type { EntitlementLimits } from "./types";

const LIMITS: EntitlementLimits = {
  maxWorkflows: 200,
  maxProjects: 50,
  maxRunsPerDay: 10_000,
  maxConcurrentRuns: 25,
  maxSandboxMinutesPerMonth: 5_000,
  maxAdsStorageMb: 50_000,
  maxIntegrations: 100,
};

const updatedAt = new Date("2026-08-06T00:00:00Z");

function fakePool(queryImpl: (sql: string, values?: unknown[]) => unknown) {
  return {
    query: vi.fn(queryImpl),
    end: vi.fn(),
  };
}

describe("PostgresPlanDefinitionStore", () => {
  it("lists definitions ordered by plan", async () => {
    const pool = fakePool(() => ({
      rows: [
        { plan: "free", limits: LIMITS, updated_at: updatedAt, updated_by: "stf_a" },
      ],
    }));
    const store = new PostgresPlanDefinitionStore(pool as never);

    expect(await store.list()).toEqual([
      { plan: "free", limits: LIMITS, commercial: null, updatedAt, updatedBy: "stf_a" },
    ]);
    expect(pool.query.mock.calls[0]![0]).toContain("ORDER BY plan");
  });

  it("returns undefined for a plan with no definition row", async () => {
    const store = new PostgresPlanDefinitionStore(fakePool(() => ({ rows: [] })) as never);
    expect(await store.find("pro")).toBeUndefined();
  });

  it("coerces jsonb limits back to the seven entitlement keys as numbers", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          plan: "pro",
          // pg returns jsonb numbers as JS numbers, but a numeric-string
          // value must still narrow to a number here.
          limits: { ...LIMITS, maxWorkflows: "200" as unknown as number },
          updated_at: updatedAt,
          updated_by: "stf_a",
        },
      ],
    }));
    const store = new PostgresPlanDefinitionStore(pool as never);

    expect((await store.find("pro"))!.limits).toEqual(LIMITS);
  });

  it("reports created=true from xmax on an insert and false on a conflict update", async () => {
    const createdPool = fakePool(() => ({
      rows: [
        { plan: "pro", limits: LIMITS, updated_at: updatedAt, updated_by: "stf_a", created: true },
      ],
    }));
    const created = await new PostgresPlanDefinitionStore(createdPool as never).upsert(
      "pro",
      LIMITS,
      "stf_a",
    );
    expect(created.created).toBe(true);
    expect(createdPool.query.mock.calls[0]![1]).toEqual([
      "pro",
      JSON.stringify(LIMITS),
      "stf_a",
      null,
      false,
    ]);

    const updatedPool = fakePool(() => ({
      rows: [
        { plan: "pro", limits: LIMITS, updated_at: updatedAt, updated_by: "stf_a", created: false },
      ],
    }));
    const updated = await new PostgresPlanDefinitionStore(updatedPool as never).upsert(
      "pro",
      LIMITS,
      "stf_a",
    );
    expect(updated.created).toBe(false);
  });

  it("reports whether a delete removed a row", async () => {
    const hit = new PostgresPlanDefinitionStore(
      fakePool(() => ({ rowCount: 1 })) as never,
    );
    const miss = new PostgresPlanDefinitionStore(
      fakePool(() => ({ rowCount: 0 })) as never,
    );
    const nullCount = new PostgresPlanDefinitionStore(
      fakePool(() => ({ rowCount: null })) as never,
    );

    expect(await hit.remove("pro")).toBe(true);
    expect(await miss.remove("pro")).toBe(false);
    expect(await nullCount.remove("pro")).toBe(false);
  });

  it("writes a pda_-prefixed audit row with serialised limits", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const store = new PostgresPlanDefinitionStore(pool as never);

    await store.recordAudit("pro", "created", LIMITS, "launch", "stf_a");

    const values = pool.query.mock.calls[0]![1] as unknown[];
    expect(values[0]).toMatch(/^pda_/);
    expect(values.slice(1)).toEqual([
      "pro",
      "created",
      JSON.stringify(LIMITS),
      "launch",
      "stf_a",
      null,
    ]);
  });

  it("writes a null limits audit row when there are no limits to record", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const store = new PostgresPlanDefinitionStore(pool as never);

    await store.recordAudit("pro", "deleted", null, "retired", "stf_a");

    expect((pool.query.mock.calls[0]![1] as unknown[])[3]).toBeNull();
  });

  it("maps history rows, including a null limits entry", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          id: "pda_1",
          plan: "pro",
          action: "created",
          limits: LIMITS,
          reason: "launch",
          staff_user_id: "stf_a",
          occurred_at: updatedAt,
        },
        {
          id: "pda_2",
          plan: "pro",
          action: "deleted",
          limits: null,
          reason: "retired",
          staff_user_id: "stf_a",
          occurred_at: updatedAt,
        },
      ],
    }));
    const store = new PostgresPlanDefinitionStore(pool as never);

    const history = await store.history("pro", 10);

    expect(history[0]).toEqual({
      id: "pda_1",
      plan: "pro",
      action: "created",
      limits: LIMITS,
      commercial: null,
      reason: "launch",
      staffUserId: "stf_a",
      occurredAt: updatedAt,
    });
    expect(history[1]!.limits).toBeNull();
    expect(pool.query.mock.calls[0]![1]).toEqual(["pro", 10]);
  });

  it("closes its pool on destroy only when it owns it", async () => {
    const owned = fakePool(() => ({ rows: [] }));
    await new PostgresPlanDefinitionStore(owned as never, true).onModuleDestroy();
    expect(owned.end).toHaveBeenCalledTimes(1);

    const borrowed = fakePool(() => ({ rows: [] }));
    await new PostgresPlanDefinitionStore(borrowed as never).onModuleDestroy();
    expect(borrowed.end).not.toHaveBeenCalled();
  });
});
