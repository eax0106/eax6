import { describe, expect, it } from "vitest";
import { TenantActivityCountFromStorageSchema, TenantActivityWindowSchema, TenantBilledSpendSchema, TenantDetailActivitySchema, TenantMembersSchema } from "./tenant-activity";

const window = { tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890a1", start_at: "2026-09-05T00:00:00.000Z", end_at: "2026-10-05T00:00:00.000Z" };
describe("read-only tenant activity contracts", () => {
  it("requires an exact, ordered thirty-day window and a real tenant UUID", () => {
    expect(TenantActivityCountFromStorageSchema.parse("2147483648")).toBe(2147483648);
    expect(TenantActivityCountFromStorageSchema.parse(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const count of ["9007199254740992", "-1", "1.1", ""]) expect(() => TenantActivityCountFromStorageSchema.parse(count)).toThrow();
    expect(TenantActivityWindowSchema.parse(window)).toEqual(window);
    for (const input of [{ ...window, end_at: window.start_at }, { ...window, start_at: window.end_at }, { ...window, end_at: "2026-10-06T00:00:00.000Z" }, { ...window, tenant_id: "other" }, { ...window, actor: "staff" }]) {
      expect(() => TenantActivityWindowSchema.parse(input)).toThrow();
    }
  });
  it("keeps currency totals exact and rejects cost breakdowns and malformed amounts", () => {
    const spend = { ...window, currencies: [{ currency: "INR", billed_minor: "90071992547409930001", event_count: 2 }] };
    expect(TenantBilledSpendSchema.parse(spend)).toEqual(spend);
    for (const amount of ["-1", "1.1", "NaN", ""]) expect(() => TenantBilledSpendSchema.parse({ ...spend, currencies: [{ ...spend.currencies[0], billed_minor: amount }] })).toThrow();
    expect(() => TenantBilledSpendSchema.parse({ ...spend, internal_cost_minor: "1" })).toThrow();
    expect(() => TenantBilledSpendSchema.parse({ ...spend, currencies: [{ ...spend.currencies[0], margin_minor: "1" }] })).toThrow();
    expect(() => TenantBilledSpendSchema.parse({ ...spend, currencies: [spend.currencies[0], spend.currencies[0]] })).toThrow();
    expect(() => TenantBilledSpendSchema.parse({ ...spend, currencies: [{ ...spend.currencies[0], event_count: 0 }] })).toThrow();
  });
  it("bounds lists independently of actual totals and rejects mismatched spend scope", () => {
    const member = { id: window.tenant_id, email: "member@example.test", name: null, role: "member" };
    expect(TenantMembersSchema.parse({ count: 51, members: [member] }).count).toBe(51);
    expect(() => TenantMembersSchema.parse({ count: 0, members: [member] })).toThrow();
    expect(() => TenantMembersSchema.parse({ count: 51, members: Array.from({ length: 51 }, () => member) })).toThrow();
    const activity = { ...window, workflow_count: 0, run_count: 0, workflows: [], runs: [], members: { count: 0, members: [] }, spend: { ...window, currencies: [] } };
    expect(TenantDetailActivitySchema.parse(activity)).toEqual(activity);
    expect(() => TenantDetailActivitySchema.parse({ ...activity, spend: { ...activity.spend, tenant_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890b1" } })).toThrow();
    expect(() => TenantDetailActivitySchema.parse({ ...activity, spend: { ...activity.spend, start_at: "2026-09-06T00:00:00.000Z" } })).toThrow();
    const short = { ...activity, start_at: "2026-09-06T00:00:00.000Z", spend: { ...activity.spend, start_at: "2026-09-06T00:00:00.000Z" } };
    expect(() => TenantDetailActivitySchema.parse(short)).toThrow();
    const run = { id: `run_${window.tenant_id}`, workspace_id: window.tenant_id, workflow_id: null, status: "completed", created_at: window.end_at };
    expect(() => TenantDetailActivitySchema.parse({ ...activity, run_count: 1, runs: [run] })).toThrow();
    expect(() => TenantDetailActivitySchema.parse({ ...activity, runs: [{ ...run, created_at: window.start_at }] })).toThrow();
  });
});
